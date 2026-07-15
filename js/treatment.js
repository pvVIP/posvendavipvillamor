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
  historicalTerminated = [],
  activeTerminationConflicts = [],
  reviews = [],
} = {}) {
  const reviewMap = new Map(reviews.map((review) => [review.caseId, review]));
  const conflictIds = new Set(activeTerminationConflicts.map((contract) => String(contract.contractId)));
  const reversionsByActive = groupReversionsByActive(reversions);
  const transferCases = buildTransferredIntegrationCases(contracts, reversionsByActive);
  const transferredIds = new Set(transferCases.map((item) => String(item.contract.contractId)));
  const cases = [
    ...buildActiveTerminationCases(contracts, conflictIds),
    ...buildZeroIntegratedCases(contracts, reversionsByActive),
    ...buildActiveReversalChainCases(contracts),
    ...transferCases,
    ...buildPossibleDuplicateCases(contracts),
    ...buildAdjustedValueDivergenceCases(contracts),
    ...buildUpdatedFinancedOutlierCases(contracts),
    ...buildUpdatedBelowFinancedCases(contracts),
    ...buildReversionFinancedValueCases(contracts, reversionsByActive),
    ...buildIncompletePaidCases(contracts, transferredIds),
    ...buildOverdueAboveBalanceCases(contracts),
    ...buildMissingHistoricalDateCases(reversions, historicalTerminated),
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

function buildActiveReversalChainCases(contracts) {
  const activeById = new Map(contracts.map((contract) => [String(contract.contractId), contract]));
  const childrenByParent = new Map();
  contracts.forEach((child) => {
    const parentId = String(child.originReversal || "").trim();
    if (!parentId || parentId === String(child.contractId) || !activeById.has(parentId)) return;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(child);
  });

  return [...childrenByParent.entries()].map(([parentId, children]) => {
    const parent = activeById.get(parentId);
    const childIds = children.map((item) => String(item.contractId)).sort();
    const unambiguous = children.length === 1;
    const proposal = {
      action: unambiguous ? "reclassify_active_predecessor" : "investigate_active_reversal_chain",
      treatedStatus: unambiguous ? "Revertido" : null,
      activeDelta: unambiguous ? -1 : 0,
      portfolioDelta: unambiguous ? -Math.max(0, toNumber(parent.totalUpdatedValue)) : 0,
      integratedDelta: unambiguous ? -Math.max(0, toNumber(parent.effectivePaidValue)) : 0,
      receivableDelta: unambiguous ? -Math.max(0, toNumber(parent.remainingBalance)) : 0,
      overdueDelta: unambiguous ? -Math.max(0, toNumber(parent.overdueValue)) : 0,
      relatedContractIds: childIds,
    };
    const sourceFingerprint = treatmentFingerprint({
      ruleId: "active-reversal-chain",
      parentId,
      childIds,
      parent: financialFingerprint(parent),
      proposal,
    });
    return {
      id: `active-reversal-chain:${parentId}:${childIds.join("-")}`,
      ruleId: "active-reversal-chain",
      ruleName: "Dois ativos na mesma cadeia de reversão",
      contract: parent,
      severity: "critical",
      confidence: unambiguous ? "high" : "medium",
      autoEligible: unambiguous,
      resolvable: unambiguous,
      issue: "Um contrato ativo também aparece como origem de outro contrato que continua ativo.",
      evidence: [
        `Ativo predecessor: ${parentId}`,
        `Ativo(s) sucessor(es): ${childIds.join(", ")}`,
        `Quantidade de sucessores ativos: ${children.length}`,
      ],
      expected: "Somente o contrato vigente da cadeia deve permanecer na carteira ativa.",
      proposedSummary: unambiguous
        ? "Classificar o predecessor como revertido apenas no resultado tratado e manter o sucessor como ativo."
        : "A cadeia possui ramificações e precisa ser conferida antes de escolher o contrato vigente.",
      proposal,
      sourceFingerprint,
    };
  });
}

function buildTransferredIntegrationCases(contracts, reversionsByActive) {
  return contracts.flatMap((contract) => {
    if (normalize(contract.financialStatus) !== "quitado") return [];
    const paid = Math.max(0, toNumber(contract.effectivePaidValue));
    const entry = Math.max(0, toNumber(contract.entryValue));
    const financed = Math.max(0, toNumber(contract.financedValue));
    const percent = normalizedPercent(contract.effectivePaidPercent ?? contract.paidPercent);
    if (paid <= 0 || entry <= 0 || financed <= 0 || percent === null || percent >= 99.99) return [];
    if (Math.abs((paid + entry) - financed) > 0.02) return [];

    const predecessors = (reversionsByActive.get(String(contract.contractId)) || [])
      .filter((item) => Math.abs(toNumber(item.effectivePaidValue) - entry) <= 0.02);
    if (predecessors.length !== 1) return [];

    const predecessor = predecessors[0];
    const remaining = Math.max(0, toNumber(contract.remainingBalance));
    const overdue = Math.max(0, toNumber(contract.overdueValue));
    const treatedPaid = paid + entry;
    const proposal = {
      action: "reconcile_transferred_integration",
      originalIntegratedValue: paid,
      treatedIntegratedValue: treatedPaid,
      treatedPaidPercent: 100,
      treatedRemainingBalance: 0,
      treatedOverdueValue: 0,
      activeDelta: 0,
      portfolioDelta: 0,
      integratedDelta: entry,
      receivableDelta: -remaining,
      overdueDelta: -overdue,
      predecessorId: String(predecessor.contractId),
    };
    const contractId = String(contract.contractId);
    const sourceFingerprint = treatmentFingerprint({
      ruleId: "transferred-integration",
      contractId,
      predecessor: financialFingerprint(predecessor),
      contract: financialFingerprint(contract),
      entry,
      proposal,
    });
    return [{
      id: `transferred-integration:${contractId}`,
      ruleId: "transferred-integration",
      ruleName: "Integralização transferida por reversão",
      contract,
      severity: "critical",
      confidence: "high",
      autoEligible: true,
      resolvable: true,
      issue: "O contrato está quitado, mas parte da integralização permaneceu registrada no predecessor revertido.",
      evidence: [
        `Integralizado atual: ${money(paid)}`,
        `Entrada transferida: ${money(entry)}`,
        `Valor financiado: ${money(financed)}`,
        `Predecessor confirmado: ${String(predecessor.contractId)}`,
        `Integralizado do predecessor: ${money(predecessor.effectivePaidValue)}`,
      ],
      expected: "Contrato quitado com 100% do valor financiado integralizado e saldo a receber zerado.",
      proposedSummary: `Somar a entrada transferida ao integralizado (${money(treatedPaid)}) e zerar saldo e atraso somente no resultado tratado.`,
      proposal,
      sourceFingerprint,
    }];
  });
}

function buildPossibleDuplicateCases(contracts) {
  const groups = new Map();
  contracts.forEach((contract) => {
    const document = normalize(contract.primaryDocument);
    const property = normalize(contract.property);
    const quota = normalize(contract.quota);
    const createdAt = dateOnly(contract.createdAt);
    if (!document || !property || !quota || !createdAt) return;
    const key = [
      document,
      property,
      quota,
      createdAt,
      cents(contract.effectivePaidValue),
      cents(contract.remainingBalance),
      cents(contract.totalUpdatedValue),
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(contract);
  });

  return [...groups.values()].filter((items) => items.length > 1).map((items) => {
    const ordered = [...items].sort((a, b) => String(a.contractId).localeCompare(String(b.contractId), "pt-BR"));
    const anchor = ordered[0];
    const identifiers = ordered.map((item) => String(item.contractId));
    const proposal = emptyImpactProposal("investigate_possible_duplicate", {
      relatedContractIds: identifiers,
      probableExcessActive: items.length - 1,
    });
    const sourceFingerprint = treatmentFingerprint({
      ruleId: "possible-active-duplicate",
      identifiers,
      signatures: ordered.map(financialFingerprint),
    });
    return {
      id: `possible-active-duplicate:${identifiers.join("-")}`,
      ruleId: "possible-active-duplicate",
      ruleName: "Possível duplicidade ativa",
      contract: anchor,
      severity: "critical",
      confidence: "high",
      autoEligible: false,
      resolvable: false,
      issue: "Dois ou mais ativos repetem titular, imóvel, cota, data e composição financeira.",
      evidence: [
        `Localizadores envolvidos: ${identifiers.join(", ")}`,
        `Imóvel: ${anchor.property || "-"}`,
        `Cota: ${anchor.quota || "-"}`,
        `Data do contrato: ${dateOnly(anchor.createdAt) || "-"}`,
        `Valor por registro: ${money(anchor.totalUpdatedValue)}`,
      ],
      expected: "Uma única obrigação ativa para a mesma titularidade, imóvel, cota, data e valores.",
      proposedSummary: "Confirmar qual contrato é vigente antes de retirar qualquer registro da carteira tratada.",
      proposal,
      sourceFingerprint,
    };
  });
}

function buildAdjustedValueDivergenceCases(contracts) {
  return contracts.flatMap((contract) => {
    const adjustedValue = extraNumericValue(contract.sourceExtras, "valor total reajustado");
    if (adjustedValue === null) return [];
    const typedValue = Math.max(0, toNumber(contract.totalUpdatedValue));
    const difference = adjustedValue - typedValue;
    if (Math.abs(difference) <= 0.01) return [];
    const proposal = emptyImpactProposal("validate_adjusted_value_semantics", {
      currentTotalValue: typedValue,
      sourceAdjustedValue: adjustedValue,
      investigatedPortfolioDelta: difference,
    });
    const contractId = String(contract.contractId);
    return [{
      id: `adjusted-value-divergence:${contractId}`,
      ruleId: "adjusted-value-divergence",
      ruleName: "Valor reajustado não conciliado",
      contract,
      severity: "warning",
      confidence: "medium",
      autoEligible: false,
      resolvable: false,
      issue: "O valor total usado na carteira diverge do campo adicional Valor Total Reajustado.",
      evidence: [
        `Valor usado atualmente: ${money(typedValue)}`,
        `Valor Total Reajustado na origem: ${money(adjustedValue)}`,
        `Diferença: ${signedMoney(difference)}`,
      ],
      expected: "Semântica financeira confirmada antes de escolher qual coluna representa a carteira oficial.",
      proposedSummary: "Levar a definição das colunas ao ESOLUTION/diretoria; não substituir valores automaticamente.",
      proposal,
      sourceFingerprint: treatmentFingerprint({
        ruleId: "adjusted-value-divergence",
        contractId,
        typedValue,
        adjustedValue,
      }),
    }];
  });
}

function buildUpdatedFinancedOutlierCases(contracts) {
  const ratiosByCategory = categoryRatioStats(contracts);
  return contracts.flatMap((contract) => {
    const financed = Math.max(0, toNumber(contract.financedValue));
    const updated = Math.max(0, toNumber(contract.totalUpdatedValue));
    if (financed <= 0 || updated <= 0) return [];
    const ratio = updated / financed;
    const excess = updated - financed;
    if (ratio < 1.8 || excess <= 10000) return [];

    const categoryStats = ratiosByCategory.get(contract.category || "") || {};
    const severity = ratio >= 2 || excess >= 100000 ? "critical" : "warning";
    const confidence = ratio >= 2 ? "high" : "medium";
    const contractId = String(contract.contractId);
    return [{
      id: `updated-financed-outlier:${contractId}`,
      ruleId: "updated-financed-outlier",
      ruleName: "Valor atualizado acima do financiado",
      contract,
      severity,
      confidence,
      autoEligible: false,
      resolvable: false,
      issue: "O valor atualizado estÃ¡ muito acima do valor financiado. Se a diferenÃ§a deveria ser apenas INCC/reajuste, o campo precisa ser conferido.",
      evidence: [
        `Valor financiado: ${money(financed)}`,
        `Valor atualizado: ${money(updated)}`,
        `DiferenÃ§a absoluta: ${money(excess)}`,
        `RelaÃ§Ã£o atualizado/financiado: ${(ratio * 100).toFixed(1)}%`,
        categoryStats.median ? `Mediana da categoria ${contract.category || "-"}: ${(categoryStats.median * 100).toFixed(1)}%` : "",
      ].filter(Boolean),
      expected: "Valor atualizado compatÃ­vel com o valor financiado acrescido de reajustes plausÃ­veis, sem salto incompatÃ­vel com a carteira.",
      proposedSummary: "Conferir se o valor atualizado recebeu componente indevido, se a coluna foi interpretada corretamente ou se hÃ¡ efeito de reversÃ£o/projeto.",
      proposal: emptyImpactProposal("investigate_updated_financed_outlier", {
        currentFinancedValue: financed,
        currentTotalUpdatedValue: updated,
        appreciationRatio: ratio,
        excessValue: excess,
        categoryMedianRatio: categoryStats.median || null,
      }),
      sourceFingerprint: treatmentFingerprint({
        ruleId: "updated-financed-outlier",
        contractId,
        financed,
        updated,
        ratio,
        categoryMedian: categoryStats.median || null,
      }),
    }];
  });
}

function buildUpdatedBelowFinancedCases(contracts) {
  return contracts.flatMap((contract) => {
    const financed = Math.max(0, toNumber(contract.financedValue));
    const updated = Math.max(0, toNumber(contract.totalUpdatedValue));
    if (financed <= 0 || updated <= 0) return [];
    const ratio = updated / financed;
    const gap = financed - updated;
    if (ratio >= 0.8 || gap <= 1000) return [];

    const contractId = String(contract.contractId);
    return [{
      id: `updated-below-financed:${contractId}`,
      ruleId: "updated-below-financed",
      ruleName: "Valor atualizado abaixo do financiado",
      contract,
      severity: ratio < 0.5 ? "critical" : "warning",
      confidence: ratio < 0.5 ? "high" : "medium",
      autoEligible: false,
      resolvable: false,
      issue: "O valor atualizado ficou abaixo do valor financiado em proporÃ§Ã£o incompatÃ­vel com uma carteira reajustada.",
      evidence: [
        `Valor financiado: ${money(financed)}`,
        `Valor atualizado: ${money(updated)}`,
        `DiferenÃ§a negativa: ${money(gap)}`,
        `RelaÃ§Ã£o atualizado/financiado: ${(ratio * 100).toFixed(1)}%`,
        contract.financialStatus ? `Status financeiro: ${contract.financialStatus}` : "",
      ].filter(Boolean),
      expected: "Valor atualizado igual ou superior ao valor financiado, salvo desconto, baixa ou exceÃ§Ã£o documental claramente identificada.",
      proposedSummary: "Conferir se a origem gravou apenas entrada, parcela, valor residual ou outro campo no lugar do valor atualizado do contrato.",
      proposal: emptyImpactProposal("investigate_updated_below_financed", {
        currentFinancedValue: financed,
        currentTotalUpdatedValue: updated,
        appreciationRatio: ratio,
        negativeGapValue: gap,
      }),
      sourceFingerprint: treatmentFingerprint({
        ruleId: "updated-below-financed",
        contractId,
        financed,
        updated,
        ratio,
      }),
    }];
  });
}

function buildReversionFinancedValueCases(contracts, reversionsByActive) {
  return contracts.flatMap((contract) => {
    const linkedReversions = reversionsByActive.get(String(contract.contractId)) || [];
    if (!linkedReversions.length) return [];

    const financed = Math.max(0, toNumber(contract.financedValue));
    const updated = Math.max(0, toNumber(contract.totalUpdatedValue));
    if (financed <= 0 || updated <= 0) return [];

    const sameFamily = linkedReversions.filter((item) => sameFinancialFamily(contract, item));
    if (!sameFamily.length) return [];

    const ratio = updated / financed;
    const predecessorReference = Math.max(...sameFamily.map((item) => Math.max(
      toNumber(item.financedValue),
      toNumber(item.totalUpdatedValue),
      toNumber(item.entryValue),
      toNumber(item.effectivePaidValue),
    )), 0);
    const financedShift = predecessorReference > 0 ? Math.abs(financed - predecessorReference) : 0;
    const financedShiftRatio = predecessorReference > 0 ? financedShift / predecessorReference : 0;
    const highUpdatedRatio = ratio >= 1.6 && updated - financed > 10000;
    const materialFinancedShift = predecessorReference > 0 && financedShiftRatio >= 0.35 && financedShift > 10000;
    if (!highUpdatedRatio && !materialFinancedShift) return [];

    const contractId = String(contract.contractId);
    const predecessorIds = sameFamily.map((item) => String(item.contractId)).sort();
    return [{
      id: `reversion-financed-value:${contractId}:${predecessorIds.join("-")}`,
      ruleId: "reversion-financed-value",
      ruleName: "Valor financiado exige leitura da reversÃ£o",
      contract,
      severity: ratio >= 2 || materialFinancedShift ? "critical" : "warning",
      confidence: ratio >= 1.8 || materialFinancedShift ? "high" : "medium",
      autoEligible: false,
      resolvable: false,
      issue: "O contrato ativo possui reversÃ£o na mesma famÃ­lia financeira e o valor financiado/atualizado pode nÃ£o representar o fechamento originÃ¡rio.",
      evidence: [
        `ReversÃ£o(Ãµes) vinculada(s): ${predecessorIds.join(", ")}`,
        `Categoria atual: ${contract.category || "-"}`,
        `Valor financiado ativo: ${money(financed)}`,
        `Valor atualizado ativo: ${money(updated)}`,
        `RelaÃ§Ã£o atualizado/financiado: ${(ratio * 100).toFixed(1)}%`,
        predecessorReference > 0 ? `Maior referÃªncia financeira na origem: ${money(predecessorReference)}` : "",
        materialFinancedShift ? `DiferenÃ§a frente Ã  origem: ${money(financedShift)}` : "",
      ].filter(Boolean),
      expected: "Quando a reversÃ£o for apenas atualizaÃ§Ã£o de projeto, o valor financiado deve respeitar a negociaÃ§Ã£o originÃ¡ria ou uma regra documentada de substituiÃ§Ã£o.",
      proposedSummary: "Analisar a cadeia da reversÃ£o antes de usar o valor financiado para simulador, valorizaÃ§Ã£o ou leitura gerencial da carteira.",
      proposal: emptyImpactProposal("review_reversion_financed_value", {
        currentFinancedValue: financed,
        currentTotalUpdatedValue: updated,
        predecessorReferenceValue: predecessorReference || null,
        appreciationRatio: ratio,
        financedShiftValue: financedShift,
        linkedReversionIds: predecessorIds,
      }),
      sourceFingerprint: treatmentFingerprint({
        ruleId: "reversion-financed-value",
        contractId,
        financed,
        updated,
        ratio,
        predecessorReference,
        predecessorIds,
      }),
    }];
  });
}

function buildIncompletePaidCases(contracts, transferredIds) {
  return contracts.flatMap((contract) => {
    if (normalize(contract.financialStatus) !== "quitado") return [];
    if (transferredIds.has(String(contract.contractId))) return [];
    const paid = Math.max(0, toNumber(contract.effectivePaidValue));
    const remaining = Math.max(0, toNumber(contract.remainingBalance));
    const percent = normalizedPercent(contract.effectivePaidPercent ?? contract.paidPercent);
    if (paid <= financialTolerance(contract.totalUpdatedValue)) return [];
    const issues = [
      percent !== null && percent < 99.99 ? `Integralização informada: ${percent.toFixed(2)}%` : "",
      remaining > 0.01 ? `Saldo a receber: ${money(remaining)}` : "",
    ].filter(Boolean);
    if (!issues.length) return [];
    const proposal = emptyImpactProposal("investigate_incomplete_paid_contract", {
      currentIntegratedValue: paid,
      currentRemainingBalance: remaining,
      currentPaidPercent: percent,
    });
    const contractId = String(contract.contractId);
    return [{
      id: `incomplete-paid-contract:${contractId}`,
      ruleId: "incomplete-paid-contract",
      ruleName: "Quitado financeiramente incompleto",
      contract,
      severity: "critical",
      confidence: "high",
      autoEligible: false,
      resolvable: false,
      issue: "O status financeiro indica quitação, mas percentual ou saldo ainda demonstram obrigação aberta.",
      evidence: [`Integralizado: ${money(paid)}`, ...issues],
      expected: "Contrato quitado com 100% integralizado e saldo a receber igual a zero.",
      proposedSummary: "Conferir valores transferidos, estornos e saldo antes de corrigir a camada tratada.",
      proposal,
      sourceFingerprint: treatmentFingerprint({
        ruleId: "incomplete-paid-contract",
        contractId,
        paid,
        remaining,
        percent,
      }),
    }];
  });
}

function buildOverdueAboveBalanceCases(contracts) {
  return contracts.flatMap((contract) => {
    const overdue = Math.max(0, toNumber(contract.overdueValue));
    const remaining = Math.max(0, toNumber(contract.remainingBalance));
    if (overdue <= remaining + 0.01) return [];
    const contractId = String(contract.contractId);
    return [{
      id: `overdue-above-balance:${contractId}`,
      ruleId: "overdue-above-balance",
      ruleName: "Atraso superior ao saldo",
      contract,
      severity: "critical",
      confidence: "high",
      autoEligible: false,
      resolvable: false,
      issue: "O valor em atraso supera o saldo total que ainda consta para recebimento.",
      evidence: [
        `Valor em atraso: ${money(overdue)}`,
        `Saldo a receber: ${money(remaining)}`,
        `Excesso: ${money(overdue - remaining)}`,
      ],
      expected: "Atraso menor ou igual ao saldo a receber, salvo juros ou encargos documentados.",
      proposedSummary: "Conferir se a diferença representa juros/multa ou erro no saldo antes de tratar.",
      proposal: emptyImpactProposal("investigate_overdue_above_balance", {
        currentOverdueValue: overdue,
        currentRemainingBalance: remaining,
      }),
      sourceFingerprint: treatmentFingerprint({
        ruleId: "overdue-above-balance",
        contractId,
        overdue,
        remaining,
      }),
    }];
  });
}

function buildMissingHistoricalDateCases(reversions, historicalTerminated) {
  const missingReversions = reversions.filter((contract) => !contract.sourceReversalDate).map((contract) => ({
    contract,
    eventType: "reversão",
    ruleId: "missing-reversal-date",
  }));
  const missingTerminations = historicalTerminated.filter((contract) => !contract.sourceTerminationDate).map((contract) => ({
    contract,
    eventType: "distrato",
    ruleId: "missing-termination-date",
  }));
  return [...missingReversions, ...missingTerminations].map(({ contract, eventType, ruleId }) => {
    const contractId = String(contract.contractId);
    return {
      id: `${ruleId}:${contractId}`,
      ruleId: "missing-historical-date",
      ruleName: "Evento histórico sem data",
      contract,
      severity: "warning",
      confidence: "high",
      autoEligible: false,
      resolvable: false,
      issue: `O histórico de ${eventType} não possui data válida para análise temporal.`,
      evidence: [
        `Tipo de evento: ${eventType}`,
        `Status de origem: ${contract.sourceStatus || "-"}`,
        `Saldo associado: ${money(contract.remainingBalance)}`,
      ],
      expected: "Todo distrato ou reversão deve possuir uma data de ocorrência verificável.",
      proposedSummary: "Preencher a data na origem ou registrar a pendência para decisão administrativa.",
      proposal: emptyImpactProposal("complete_historical_event_date", { eventType }),
      sourceFingerprint: treatmentFingerprint({
        ruleId,
        contractId,
        eventType,
        sourceStatus: contract.sourceStatus,
      }),
    };
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

function extraNumericValue(sourceExtras, expectedKey) {
  const entry = Object.entries(sourceExtras || {})
    .find(([key]) => normalize(key) === expectedKey);
  if (!entry || entry[1] === null || entry[1] === undefined || entry[1] === "") return null;
  if (typeof entry[1] === "number") return Number.isFinite(entry[1]) ? entry[1] : null;
  const clean = String(entry[1]).replace(/[R$\s]/g, "");
  const normalizedValue = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const value = Number(normalizedValue);
  return Number.isFinite(value) ? value : null;
}

function categoryRatioStats(contracts) {
  const groups = new Map();
  contracts.forEach((contract) => {
    const financed = Math.max(0, toNumber(contract.financedValue));
    const updated = Math.max(0, toNumber(contract.totalUpdatedValue));
    if (financed <= 0 || updated <= 0) return;
    const ratio = updated / financed;
    if (ratio < 0.5 || ratio > 1.6) return;
    const key = contract.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ratio);
  });
  return new Map([...groups.entries()].map(([key, values]) => [key, {
    median: median(values),
    count: values.length,
  }]));
}

function sameFinancialFamily(active, predecessor) {
  if (active.category && predecessor.category && active.category === predecessor.category) return true;
  const activeProduct = normalizeProductFamily(active.product);
  const predecessorProduct = normalizeProductFamily(predecessor.product);
  if (!activeProduct || !predecessorProduct) return false;
  return activeProduct === predecessorProduct;
}

function normalizeProductFamily(value) {
  const normalized = normalize(value)
    .replace(/\b(luxo|villamor|bangalo|luxury|t|integral|cota)\b/g, " ")
    .replace(/\b\d+(?:o|º|°)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.includes("diamante")) return "diamante";
  if (normalized.includes("ouro")) return "ouro";
  if (normalized.includes("prata")) return "prata";
  if (normalized.includes("bronze")) return "bronze";
  return normalized;
}

function emptyImpactProposal(action, extra = {}) {
  return {
    action,
    activeDelta: 0,
    portfolioDelta: 0,
    integratedDelta: 0,
    receivableDelta: 0,
    overdueDelta: 0,
    ...extra,
  };
}

function financialFingerprint(contract) {
  return {
    contractId: String(contract.contractId),
    sourceStatus: contract.sourceStatus,
    financialStatus: contract.financialStatus,
    originReversal: contract.originReversal,
    financedValue: toNumber(contract.financedValue),
    entryValue: toNumber(contract.entryValue),
    totalUpdatedValue: toNumber(contract.totalUpdatedValue),
    effectivePaidValue: toNumber(contract.effectivePaidValue),
    effectivePaidPercent: normalizedPercent(contract.effectivePaidPercent ?? contract.paidPercent),
    remainingBalance: toNumber(contract.remainingBalance),
    overdueValue: toNumber(contract.overdueValue),
  };
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : "";
}

function cents(value) {
  return Math.round(toNumber(value) * 100);
}

function signedMoney(value) {
  const number = toNumber(value);
  return `${number > 0 ? "+" : number < 0 ? "-" : ""}${money(Math.abs(number))}`;
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
  const highestPriorityByContract = new Map();
  cases.forEach((item) => {
    const contractId = String(item.contract?.contractId || item.id);
    const current = highestPriorityByContract.get(contractId);
    if (!current || impactPriority(item) > impactPriority(current)) {
      highestPriorityByContract.set(contractId, item);
    }
  });

  return [...highestPriorityByContract.values()].reduce((total, item) => ({
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

function impactPriority(item) {
  return {
    reclassify_terminated: 100,
    reclassify_active_predecessor: 90,
    reconcile_transferred_integration: 80,
    replace_integrated_value: 70,
  }[item.proposal?.action] || 0;
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

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
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
