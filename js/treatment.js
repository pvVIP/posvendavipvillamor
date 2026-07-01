import { toNumber } from "./utils.js";

export const TREATMENT_DECISIONS = Object.freeze({
  PENDING: "pending",
  TREATED: "treated",
  DIRECTORATE: "directorate",
  KEPT: "kept",
});

const FINANCIAL_BLOCK_TERMS = [
  "impedido",
  "bloqueado",
  "cancelado",
  "distratado",
  "rescindido",
  "encerrado",
  "inativo",
];

export function buildTreatmentCases({
  contracts = [],
  reversions = [],
  activeTerminationConflicts = [],
  reviews = [],
} = {}) {
  const reviewMap = new Map(reviews.map((review) => [review.caseId, review]));
  const conflictIds = new Set(activeTerminationConflicts.map((contract) => String(contract.contractId)));
  const reversionsByActive = groupReversionsByActive(reversions);
  const cases = [
    ...buildActiveTerminationCases(contracts, conflictIds),
    ...buildZeroIntegratedCases(contracts, reversionsByActive),
  ];

  return cases
    .map((item) => attachReview(item, reviewMap.get(item.id)))
    .sort(compareTreatmentCases);
}

export function summarizeTreatmentCases(cases = []) {
  const treated = cases.filter((item) => item.decision === TREATMENT_DECISIONS.TREATED && !item.reviewStale);
  const directorate = cases.filter((item) => item.decision === TREATMENT_DECISIONS.DIRECTORATE && !item.reviewStale);
  const pending = cases.filter((item) => (
    item.decision === TREATMENT_DECISIONS.PENDING
    || item.reviewStale
  ));
  const potential = sumImpact(cases.filter((item) => item.resolvable));
  const validated = sumImpact(treated);

  return {
    total: cases.length,
    critical: cases.filter((item) => item.severity === "critical").length,
    pending: pending.length,
    treated: treated.length,
    directorate: directorate.length,
    automatable: cases.filter((item) => item.autoEligible).length,
    stale: cases.filter((item) => item.reviewStale).length,
    potential,
    validated,
  };
}

function buildActiveTerminationCases(contracts, conflictIds) {
  return contracts.flatMap((contract) => {
    const financialStatus = normalize(contract.financialStatus);
    const blockedFinancialStatus = FINANCIAL_BLOCK_TERMS.some((term) => financialStatus.includes(term));
    const reportedDate = contract.reportedTerminationDate || null;
    const reportedReason = contract.reportedTerminationReason || "";
    const extraEvidence = findTerminationEvidence(contract.sourceExtras);
    const hasHistoricalConflict = conflictIds.has(String(contract.contractId));
    const signals = [
      blockedFinancialStatus ? `Status financeiro: ${contract.financialStatus}` : "",
      reportedDate ? `Data de cancelamento: ${reportedDate}` : "",
      reportedReason ? `Motivo de cancelamento: ${reportedReason}` : "",
      hasHistoricalConflict ? "Localizador também encontrado no histórico de distratos" : "",
      ...extraEvidence,
    ].filter(Boolean);

    if (!signals.length) return [];

    const independentSignals = [
      blockedFinancialStatus,
      Boolean(reportedDate || reportedReason),
      hasHistoricalConflict,
      Boolean(extraEvidence.length),
    ].filter(Boolean).length;
    const confidence = independentSignals >= 2 ? "high" : "medium";
    const contractId = String(contract.contractId);
    const proposal = {
      action: "reclassify_terminated",
      sourceStatus: contract.sourceStatus || "Ativo",
      treatedStatus: "Distratado",
      activeDelta: -1,
      portfolioDelta: -Math.max(0, toNumber(contract.totalUpdatedValue)),
      integratedDelta: -Math.max(0, toNumber(contract.effectivePaidValue)),
      receivableDelta: -Math.max(0, toNumber(contract.remainingBalance)),
      overdueDelta: -Math.max(0, toNumber(contract.overdueValue)),
    };
    const fingerprint = treatmentFingerprint({
      ruleId: "active-termination-conflict",
      contractId,
      financialStatus: contract.financialStatus,
      reportedDate,
      reportedReason,
      signals,
      proposal,
    });

    return [{
      id: `active-termination-conflict:${contractId}`,
      ruleId: "active-termination-conflict",
      ruleName: "Ativo com evidência de distrato",
      contract,
      severity: "critical",
      confidence,
      autoEligible: confidence === "high",
      resolvable: confidence === "high",
      issue: "O contrato está na carteira ativa, mas existem sinais de impedimento financeiro ou encerramento.",
      evidence: signals,
      expected: "Contrato ativo sem evidências de distrato, cancelamento ou impedimento definitivo.",
      proposedSummary: confidence === "high"
        ? "Retirar da carteira ativa somente no resultado tratado e classificar como possível distrato."
        : "Conferir o contrato antes de qualquer reclassificação; a evidência isolada ainda não é conclusiva.",
      proposal,
      sourceFingerprint: fingerprint,
    }];
  });
}

function buildZeroIntegratedCases(contracts, reversionsByActive) {
  return contracts.flatMap((contract) => {
    const total = Math.max(0, toNumber(contract.totalUpdatedValue));
    const paid = Math.max(0, toNumber(contract.effectivePaidValue));
    const percent = normalizedPercent(contract.effectivePaidPercent ?? contract.paidPercent);
    if (total <= 0 || paid > financialTolerance(total) || (percent !== null && percent > 0.05)) return [];

    const linkedReversions = reversionsByActive.get(String(contract.contractId)) || [];
    const settledReversions = linkedReversions.filter(hasSettlementEvidence);
    const activeEntry = Math.max(0, toNumber(contract.entryValue));
    const linkedCandidates = settledReversions
      .map((item) => ({
        contract: item,
        value: Math.max(0, toNumber(item.entryValue), toNumber(item.effectivePaidValue)),
      }))
      .filter((item) => item.value > 0);
    const linkedValue = linkedCandidates.length === 1 ? linkedCandidates[0].value : 0;
    const suggestedPaid = activeEntry > 0 && settledReversions.length === 1
      ? activeEntry
      : linkedValue;
    const strongLink = settledReversions.length === 1 && suggestedPaid > 0;
    const confidence = strongLink ? "high" : linkedReversions.length ? "medium" : "low";
    const evidence = [
      "Integralizado atual: R$ 0,00",
      activeEntry > 0 ? `Entrada no contrato ativo: ${money(activeEntry)}` : "Entrada no contrato ativo não informada",
      `${linkedReversions.length} reversão(ões) vinculada(s)`,
      `${settledReversions.length} reversão(ões) com evidência financeira de quitação`,
      linkedValue > 0 ? `Valor encontrado no histórico vinculado: ${money(linkedValue)}` : "",
    ].filter(Boolean);
    const proposal = {
      action: suggestedPaid > 0 ? "replace_integrated_value" : "manual_investigation",
      originalIntegratedValue: paid,
      treatedIntegratedValue: suggestedPaid,
      treatedPaidPercent: total > 0 && suggestedPaid > 0 ? Math.min(100, (suggestedPaid / total) * 100) : null,
      activeDelta: 0,
      portfolioDelta: 0,
      integratedDelta: suggestedPaid,
      receivableDelta: 0,
      overdueDelta: 0,
      linkedReversionIds: linkedReversions.map((item) => String(item.contractId)),
    };
    const contractId = String(contract.contractId);
    const fingerprint = treatmentFingerprint({
      ruleId: "active-zero-integrated",
      contractId,
      total,
      paid,
      activeEntry,
      linked: linkedReversions.map((item) => [
        item.contractId,
        item.financialStatus,
        item.entryValue,
        item.effectivePaidValue,
      ]),
      proposal,
    });

    return [{
      id: `active-zero-integrated:${contractId}`,
      ruleId: "active-zero-integrated",
      ruleName: "Ativo com integralização zerada",
      contract,
      severity: strongLink ? "warning" : "critical",
      confidence,
      autoEligible: strongLink,
      resolvable: strongLink,
      issue: "O contrato ativo possui carteira positiva, mas está com integralização de 0%.",
      evidence,
      expected: "Integralização coerente com a entrada e com o histórico financeiro das reversões vinculadas.",
      proposedSummary: strongLink
        ? `Usar ${money(suggestedPaid)} como integralizado no resultado tratado, preservando o contrato como ativo.`
        : "Manter pendente e conferir a cadeia de reversões ou a coluna Entrada com a diretoria/financeiro.",
      proposal,
      sourceFingerprint: fingerprint,
    }];
  });
}

function attachReview(item, review) {
  const reviewStale = Boolean(review && review.sourceFingerprint !== item.sourceFingerprint);
  return {
    ...item,
    review: review || null,
    reviewStale,
    decision: reviewStale
      ? TREATMENT_DECISIONS.PENDING
      : review?.decision || TREATMENT_DECISIONS.PENDING,
    note: review?.note || "",
    reviewedAt: review?.reviewedAt || null,
    reviewedBy: review?.reviewedBy || "",
  };
}

function groupReversionsByActive(reversions) {
  const grouped = new Map();
  reversions.forEach((contract) => {
    const activeId = String(contract.linkedActiveContractId || "").trim();
    if (!activeId) return;
    if (!grouped.has(activeId)) grouped.set(activeId, []);
    grouped.get(activeId).push(contract);
  });
  return grouped;
}

function findTerminationEvidence(sourceExtras = {}) {
  return Object.entries(sourceExtras || {}).flatMap(([key, value]) => {
    if (value === null || value === undefined || value === "") return [];
    const normalizedKey = normalize(key);
    const relevant = ["cancel", "distrat", "rescis", "imped"].some((term) => normalizedKey.includes(term));
    return relevant ? [`${key}: ${String(value)}`] : [];
  });
}

function hasSettlementEvidence(contract) {
  if (normalize(contract.financialStatus) === "quitado") return true;
  if (contract.settlementDate) return true;
  const percent = normalizedPercent(contract.effectivePaidPercent ?? contract.paidPercent);
  if (percent !== null && percent >= 99.95) return true;

  const paidEvidence = Math.max(0, toNumber(contract.entryValue), toNumber(contract.effectivePaidValue));
  const reference = Math.max(0, toNumber(contract.financedValue))
    || Math.max(0, toNumber(contract.totalUpdatedValue));
  return reference > 0 && paidEvidence + financialTolerance(reference) >= reference;
}

function sumImpact(cases) {
  return cases.reduce((total, item) => ({
    activeDelta: total.activeDelta + toNumber(item.proposal?.activeDelta),
    portfolioDelta: total.portfolioDelta + toNumber(item.proposal?.portfolioDelta),
    integratedDelta: total.integratedDelta + toNumber(item.proposal?.integratedDelta),
    receivableDelta: total.receivableDelta + toNumber(item.proposal?.receivableDelta),
    overdueDelta: total.overdueDelta + toNumber(item.proposal?.overdueDelta),
  }), {
    activeDelta: 0,
    portfolioDelta: 0,
    integratedDelta: 0,
    receivableDelta: 0,
    overdueDelta: 0,
  });
}

function compareTreatmentCases(a, b) {
  const decisionOrder = {
    pending: 0,
    directorate: 1,
    treated: 2,
    kept: 3,
  };
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  return (decisionOrder[a.decision] ?? 9) - (decisionOrder[b.decision] ?? 9)
    || (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
    || String(a.contract.primaryClient || "").localeCompare(String(b.contract.primaryClient || ""), "pt-BR");
}

function normalizedPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = toNumber(value);
  if (!Number.isFinite(number)) return null;
  return number > 0 && number <= 1 ? number * 100 : number;
}

function financialTolerance(reference) {
  return Math.max(1, Math.abs(toNumber(reference)) * 0.0005);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function money(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(toNumber(value));
}

function treatmentFingerprint(payload) {
  const source = stableStringify(payload);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
