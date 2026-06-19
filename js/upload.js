import {
  getCategory,
  normalizeHeader,
  parseExcelDate,
  toNumber,
} from "./utils.js";

const FIELD_ALIASES = {
  contractId: ["localizador", "numero contrato", "n contrato", "contrato", "id contrato"],
  contractCode: ["codigo", "codigo contrato", "cod contrato"],
  sourceNumber: ["numero"],
  createdAt: ["data", "data contrato", "data venda", "data cadastro"],
  originReversal: ["origem reversao", "origem da reversao"],
  sourceStatus: ["status", "situacao", "situacao contrato"],
  clientState: ["estado", "uf"],
  property: ["imovel", "unidade", "apartamento"],
  quota: ["cota", "numero cota"],
  product: ["produto", "grupo produto", "tipo produto", "categoria produto"],
  primaryClient: ["cessionario 1", "cliente", "nome cliente", "titular", "comprador", "nome"],
  secondaryClient: ["cessionario 2", "segundo cessionario", "cotitular", "segundo comprador"],
  primaryDocument: ["cpf/cnpj cessionario 1", "cpf/cnpj", "cpf", "cnpj", "documento cliente"],
  secondaryDocument: ["cpf/cnpj cessionario 2", "cpf/cnpj cotitular", "documento cessionario 2"],
  primaryPhone: ["telefone cessionario 1", "telefone", "celular", "whatsapp"],
  secondaryPhone: ["telefone cessionario 2", "telefone cotitular"],
  financialStatus: ["status financeiro", "situacao financeira", "estado financeiro"],
  settlementDate: ["data quitacao", "data de quitacao"],
  entryValue: ["entrada", "valor entrada"],
  effectivePaidValue: [
    "valor integralizado efetivo",
    "valor integralizado",
    "integralizado",
    "valor pago",
    "total pago",
    "valor recebido",
  ],
  effectivePaidPercent: ["percentual integralizado efetivo", "percentual pago efetivo"],
  remainingBalance: ["saldo restante", "saldo devedor", "saldo"],
  totalUpdatedValue: ["valor total atualizado", "valor contrato", "valor total", "valor da venda"],
  overdueValue: ["valor atrasado", "valor em atraso", "saldo atrasado", "inadimplencia"],
  paidPercent: ["percentual integralizado", "percentual pago"],
  nextDueDate: ["data proximo vencimento", "proximo vencimento", "data vencimento", "vencimento"],
  primaryBirthDate: ["data nascimento cessionario 1", "data nascimento", "nascimento cliente"],
  secondaryBirthDate: ["data nascimento cessionario 2", "nascimento cotitular"],
  sourceTerminationDate: ["data cancelamento", "data distrato", "data rescisao"],
  sourceReversalDate: ["data reversao", "data reativacao"],
  sourceTerminationReason: ["motivo de cancelamento", "motivo cancelamento", "motivo distrato", "motivo rescisao"],
};

const FIELD_LABELS = {
  contractId: "localizador",
  contractCode: "código do contrato",
  sourceStatus: "status do contrato",
  primaryClient: "cliente principal",
  product: "produto/grupo",
  effectivePaidValue: "valor integralizado",
  overdueValue: "valor em atraso",
  nextDueDate: "data do próximo vencimento",
};

const EXTRA_FIELD_RULES = [
  {
    terms: ["numero"],
    contribution: "Será preservado como identificador auxiliar da origem e poderá apoiar conciliações futuras.",
  },
  {
    terms: ["estado", "uf", "cidade", "municipio"],
    contribution: "Pode permitir análises geográficas de carteira, inadimplência e distratos.",
  },
  {
    terms: ["parcela", "prestacao"],
    contribution: "Pode melhorar quantidade de parcelas em atraso, aging e priorização de cobrança.",
  },
  {
    terms: ["pagamento", "pago", "integralizado", "recebido"],
    contribution: "Pode aprimorar indicadores de valor integralizado e recuperação financeira.",
  },
  {
    terms: ["email", "telefone", "contato", "whatsapp"],
    contribution: "Pode contribuir para um futuro CRM e ações operacionais de cobrança.",
  },
  {
    terms: ["vendedor", "canal", "origem", "campanha"],
    contribution: "Pode permitir análises de risco e inadimplência por canal de venda.",
  },
  {
    terms: ["empreendimento", "bloco", "torre", "unidade", "apartamento"],
    contribution: "Pode ampliar a segmentação física e financeira da carteira.",
  },
  {
    terms: ["distrato", "retencao", "reembolso", "devolucao", "cancelamento", "reversao"],
    contribution: "Será usado para identificar distratos históricos, datas, motivos e reversões provenientes da base.",
  },
  {
    terms: ["negociacao", "acordo", "cobranca", "promessa"],
    contribution: "Pode apoiar histórico de negociação, cobrança e previsão de recebimento.",
  },
  {
    terms: ["score", "risco", "classificacao"],
    contribution: "Pode contribuir para score de risco e priorização automática.",
  },
];

const ALIAS_TO_FIELD = buildAliasIndex();

export async function parseWorkbookFile(file) {
  if (!window.XLSX) {
    throw new Error("Biblioteca SheetJS ainda não carregou. Tente novamente em alguns segundos.");
  }

  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames.includes("BASEDEDADOS") ? "BASEDEDADOS" : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const sourceRows = window.XLSX.utils.sheet_to_json(sheet, { defval: null });
  const headers = Object.keys(sourceRows[0] || {});
  const resolvedHeaders = resolveHeaders(headers);
  const { rows, ignoredRows } = removeVerifiedSummaryRows(sourceRows, resolvedHeaders);
  const validation = validateRows(rows, resolvedHeaders, {
    sourceRows: sourceRows.length,
    ignoredRows,
  });
  const columnAnalysis = analyzeColumns(headers, resolvedHeaders);

  if (validation.errors.length) {
    return { contracts: [], validation, columnAnalysis, sheetName };
  }

  const contracts = rows.map((row) => normalizeImportedRow(row, resolvedHeaders));
  return { contracts, validation, columnAnalysis, sheetName };
}

function removeVerifiedSummaryRows(rows, resolvedHeaders) {
  const contractHeader = resolvedHeaders.get("contractId");
  const contractCodeHeader = resolvedHeaders.get("contractCode");
  const statusHeader = resolvedHeaders.get("sourceStatus");
  const clientHeader = resolvedHeaders.get("primaryClient");
  const productHeader = resolvedHeaders.get("product");
  const financialHeaders = [
    resolvedHeaders.get("entryValue"),
    resolvedHeaders.get("effectivePaidValue"),
    resolvedHeaders.get("remainingBalance"),
    resolvedHeaders.get("totalUpdatedValue"),
    resolvedHeaders.get("overdueValue"),
  ].filter(Boolean);
  const ignoredRows = [];
  const keptRows = [];

  rows.forEach((row, index) => {
    const identifier = String(contractHeader ? row[contractHeader] ?? "" : "").trim();
    const contractCode = String(contractCodeHeader ? row[contractCodeHeader] ?? "" : "").trim();
    const status = String(statusHeader ? row[statusHeader] ?? "" : "").trim();
    const client = String(clientHeader ? row[clientHeader] ?? "" : "").trim();
    const product = String(productHeader ? row[productHeader] ?? "" : "").trim();
    const populatedCells = Object.values(row).filter((value) => value !== null && value !== undefined && String(value).trim() !== "");
    const financialTotals = financialHeaders.filter((header) => {
      const value = row[header];
      return value !== null && value !== undefined && String(value).trim() !== "";
    });
    const quantityMatch = identifier.match(/^qtd(?:\.|ade)?\s*:\s*(\d+)\s*$/i);
    const declaredQuantity = quantityMatch ? Number(quantityMatch[1]) : null;
    const expectedDataRows = rows.length - 1;
    const matchesDataRowCount = declaredQuantity === expectedDataRows;
    const isVerifiedSummary = Boolean(
      quantityMatch
      && !status
      && !contractCode
      && !client
      && !product
      && populatedCells.length <= 8
      && financialTotals.length >= 2
    );

    if (isVerifiedSummary) {
      ignoredRows.push({
        line: index + 2,
        identifier,
        reason: matchesDataRowCount
          ? `Linha de total verificada: quantidade declarada (${declaredQuantity}) coincide com as linhas de contratos e não possui status, cliente ou produto.`
          : `Linha de total verificada pela estrutura: não possui status, cliente, produto ou código e concentra totais financeiros. A quantidade declarada (${declaredQuantity}) diverge das ${expectedDataRows} linhas encontradas e foi sinalizada para conferência.`,
      });
    } else {
      keptRows.push(row);
    }
  });

  return { rows: keptRows, ignoredRows };
}

function buildAliasIndex() {
  const index = new Map();
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    aliases.forEach((alias) => index.set(normalizeHeader(alias), field));
  });
  return index;
}

function resolveHeaders(headers) {
  const resolved = new Map();
  headers.forEach((header) => {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(header));
    if (field && !resolved.has(field)) resolved.set(field, header);
  });
  if (!resolved.has("contractId")) {
    const fallbackHeader = resolved.get("contractCode") || resolved.get("sourceNumber");
    if (fallbackHeader) resolved.set("contractId", fallbackHeader);
  }
  return resolved;
}

function validateRows(rows, resolvedHeaders, importSummary = {}) {
  const errors = [];
  const warnings = [];
  const statusCounts = { active: 0, terminated: 0, reverted: 0, unknown: 0 };

  if (!rows.length) errors.push("A planilha não possui linhas de dados.");
  if (!resolvedHeaders.has("contractId")) {
    errors.push("Não foi encontrada uma coluna confiável para localizar o registro. Use LOCALIZADOR, CÓDIGO ou CONTRATO.");
  }
  if (!resolvedHeaders.has("sourceStatus")) {
    errors.push("Não foi encontrada a coluna STATUS ou ESTADO. Ela é obrigatória para separar ativos, cancelados e revertidos.");
  }

  ["primaryClient", "product", "effectivePaidValue", "overdueValue", "nextDueDate"].forEach((field) => {
    if (!resolvedHeaders.has(field)) {
      warnings.push(`Campo não encontrado: ${FIELD_LABELS[field]}. Indicadores relacionados poderão ficar incompletos.`);
    }
  });

  if (!resolvedHeaders.has("contractId") || !resolvedHeaders.has("sourceStatus")) {
    return {
      ok: false,
      errors,
      warnings,
      totalRows: rows.length,
      sourceRows: importSummary.sourceRows ?? rows.length,
      ignoredRows: importSummary.ignoredRows || [],
      statusCounts,
    };
  }

  const contractHeader = resolvedHeaders.get("contractId");
  const contractCodeHeader = resolvedHeaders.get("contractCode");
  const statusHeader = resolvedHeaders.get("sourceStatus");
  const clientHeader = resolvedHeaders.get("primaryClient");
  const financialStatusHeader = resolvedHeaders.get("financialStatus");
  const effectivePaidHeader = resolvedHeaders.get("effectivePaidValue");
  const effectivePaidPercentHeader = resolvedHeaders.get("effectivePaidPercent");
  const paidPercentHeader = resolvedHeaders.get("paidPercent");
  const remainingHeader = resolvedHeaders.get("remainingBalance");
  const totalHeader = resolvedHeaders.get("totalUpdatedValue");
  const overdueHeader = resolvedHeaders.get("overdueValue");
  const terminationDateHeader = resolvedHeaders.get("sourceTerminationDate");
  const terminationReasonHeader = resolvedHeaders.get("sourceTerminationReason");
  const seen = new Set();
  let negativeTotalCount = 0;
  let negativeOverdueCount = 0;
  let missingClientCount = 0;
  let missingContractCodeCount = 0;
  let activeWithTerminationEvidenceCount = 0;
  let paidIntegrityIssueCount = 0;
  let integratedAboveTotalCount = 0;
  let invalidPaidPercentCount = 0;
  const contractCodeCounts = new Map();
  const unknownStatuses = new Map();

  rows.forEach((row, index) => {
    const line = index + 2;
    const contractId = row[contractHeader];
    if (contractId === null || contractId === undefined || String(contractId).trim() === "") {
      errors.push(`Linha ${line}: identificador do contrato vazio.`);
    } else if (seen.has(String(contractId).trim())) {
      errors.push(`Linha ${line}: contrato duplicado (${contractId}).`);
    }
    seen.add(String(contractId).trim());

    if (contractCodeHeader) {
      const contractCode = String(row[contractCodeHeader] ?? "").trim();
      if (!contractCode) {
        missingContractCodeCount += 1;
      } else {
        contractCodeCounts.set(contractCode, (contractCodeCounts.get(contractCode) || 0) + 1);
      }
    }
    if (totalHeader && toNumber(row[totalHeader]) < 0) negativeTotalCount += 1;
    if (overdueHeader && toNumber(row[overdueHeader]) < 0) negativeOverdueCount += 1;
    if (clientHeader && !row[clientHeader]) missingClientCount += 1;
    const total = totalHeader ? Math.max(0, toNumber(row[totalHeader])) : 0;
    const integrated = effectivePaidHeader ? Math.max(0, toNumber(row[effectivePaidHeader])) : 0;
    const remaining = remainingHeader ? Math.max(0, toNumber(row[remainingHeader])) : 0;
    const overdue = overdueHeader ? Math.max(0, toNumber(row[overdueHeader])) : 0;
    const effectivePercent = effectivePaidPercentHeader
      ? normalizeImportPercent(row[effectivePaidPercentHeader])
      : null;
    const legacyPercent = paidPercentHeader ? normalizeImportPercent(row[paidPercentHeader]) : null;
    const paidPercent = effectivePercent ?? legacyPercent ?? (total > 0 ? (integrated / total) * 100 : null);
    const tolerance = Math.max(1, total * 0.0005);
    const isPaid = financialStatusHeader && normalizeHeader(row[financialStatusHeader]) === "quitado";
    if (isPaid && (
      (paidPercent !== null && paidPercent < 99.95)
      || (total > 0 && integrated + tolerance < total)
      || remaining > tolerance
      || overdue > tolerance
    )) {
      paidIntegrityIssueCount += 1;
    }
    if (total > 0 && integrated > total + tolerance) integratedAboveTotalCount += 1;
    if ([effectivePercent, legacyPercent].some((value) => value !== null && (value < 0 || value > 100.05))) {
      invalidPaidPercentCount += 1;
    }
    const status = normalizeHeader(row[statusHeader]);
    const reverted = ["revertid", "reativad", "restaurad"].some((term) => status.includes(term));
    const terminated = !reverted && ["distrat", "cancelad", "rescind", "rescis"].some((term) => status.includes(term));
    const recognized = status === "ativo" || terminated || reverted;
    if (status === "ativo") statusCounts.active += 1;
    else if (reverted) statusCounts.reverted += 1;
    else if (terminated) statusCounts.terminated += 1;
    else statusCounts.unknown += 1;
    if (status === "ativo" && (
      (terminationDateHeader && row[terminationDateHeader])
      || (terminationReasonHeader && row[terminationReasonHeader])
    )) {
      activeWithTerminationEvidenceCount += 1;
    }
    if (!recognized) unknownStatuses.set(status || "vazio", (unknownStatuses.get(status || "vazio") || 0) + 1);
  });

  if (negativeTotalCount) {
    warnings.push(
      `${negativeTotalCount} registros possuem valor total negativo. O valor original será preservado e zero será usado nos indicadores para não reduzir artificialmente a carteira.`,
    );
  }
  if (negativeOverdueCount) {
    warnings.push(
      `${negativeOverdueCount} registros possuem valor em atraso negativo. O valor original será preservado e esses casos não serão classificados como inadimplência.`,
    );
  }
  if (missingClientCount) {
    warnings.push(`${missingClientCount} registros estão sem cliente principal.`);
  }
  if (!contractCodeHeader) {
    warnings.push("A coluna CÓDIGO não foi encontrada. O localizador continuará sendo exibido como contrato por compatibilidade.");
  } else {
    const duplicatedCodes = [...contractCodeCounts.values()].filter((count) => count > 1);
    const duplicateRows = duplicatedCodes.reduce((total, count) => total + count, 0);
    if (missingContractCodeCount) {
      warnings.push(`${missingContractCodeCount} registros estão sem CÓDIGO de contrato.`);
    }
    if (duplicatedCodes.length) {
      warnings.push(`${duplicatedCodes.length} códigos de contrato aparecem repetidos em ${duplicateRows} registros. Os localizadores únicos serão mantidos para evitar mistura de contratos.`);
    }
  }
  if (unknownStatuses.size) {
    const summary = [...unknownStatuses.entries()].map(([status, count]) => `${status}: ${count}`).join(", ");
    warnings.push(`Status ainda não classificados (${summary}). Esses registros serão preservados em Alertas de Dados e ficarão fora dos indicadores.`);
  }
  if (activeWithTerminationEvidenceCount) {
    warnings.push(`${activeWithTerminationEvidenceCount} registros estão com status Ativo e dados de cancelamento/distrato preenchidos. O status Ativo prevalecerá e esses contratos não entrarão na aba Distratos.`);
  }

  if (paidIntegrityIssueCount) {
    warnings.push(`${paidIntegrityIssueCount} contratos marcados como Quitado não comprovam integralização de 100%, saldo zero e atraso zero. Eles serão detalhados em Alertas de Dados.`);
  }
  if (integratedAboveTotalCount) {
    warnings.push(`${integratedAboveTotalCount} registros possuem valor integralizado maior que o valor total atualizado.`);
  }
  if (invalidPaidPercentCount) {
    warnings.push(`${invalidPaidPercentCount} registros possuem percentual integralizado fora da faixa de 0% a 100%.`);
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    totalRows: rows.length,
    sourceRows: importSummary.sourceRows ?? rows.length,
    ignoredRows: importSummary.ignoredRows || [],
    statusCounts,
    contractCodeHealth: {
      missing: missingContractCodeCount,
      duplicatedCodes: [...contractCodeCounts.values()].filter((count) => count > 1).length,
      duplicateRows: [...contractCodeCounts.values()].filter((count) => count > 1)
        .reduce((total, count) => total + count, 0),
    },
    activeWithTerminationEvidence: activeWithTerminationEvidenceCount,
    financialHealth: {
      paidIntegrityIssues: paidIntegrityIssueCount,
      integratedAboveTotal: integratedAboveTotalCount,
      invalidPaidPercent: invalidPaidPercentCount,
    },
  };
}

function normalizeImportPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = toNumber(value);
  if (!Number.isFinite(number)) return null;
  if (number > 0 && number <= 1) return number * 100;
  return number;
}

function analyzeColumns(headers, resolvedHeaders) {
  const mappedHeaderSet = new Set(resolvedHeaders.values());
  const mapped = [...resolvedHeaders.entries()].map(([field, header]) => ({ header, field }));
  const extras = headers
    .filter((header) => !mappedHeaderSet.has(header))
    .map((header) => {
      const normalized = normalizeHeader(header);
      const rule = EXTRA_FIELD_RULES.find((item) => item.terms.some((term) => normalized.includes(term)));
      return {
        header,
        classification: rule ? "potentially-useful" : "unclassified",
        contribution: rule
          ? rule.contribution
          : "Será preservado como dado adicional, mas ainda não possui uso confiável nos indicadores atuais.",
      };
    });

  return {
    mapped,
    extras,
    usefulExtras: extras.filter((item) => item.classification === "potentially-useful"),
    unknownExtras: extras.filter((item) => item.classification === "unclassified"),
  };
}

function normalizeImportedRow(row, resolvedHeaders) {
  const output = {};
  const mappedSourceHeaders = new Set();

  Object.keys(FIELD_ALIASES).forEach((field) => {
    const header = resolvedHeaders.get(field);
    output[field] = header ? row[header] : null;
    if (header) mappedSourceHeaders.add(header);
  });

  const sourceExtras = Object.fromEntries(
    Object.entries(row)
      .filter(([header]) => !mappedSourceHeaders.has(header))
      .map(([header, value]) => [header, normalizeExtraValue(value)]),
  );

  const product = String(output.product || "");
  const sourceTermination = detectSourceTermination(row, output);
  const totalUpdatedValue = toNumber(output.totalUpdatedValue);
  const overdueValue = toNumber(output.overdueValue);
  const sourceFinancialAdjustments = {
    totalUpdatedValue: totalUpdatedValue < 0 ? totalUpdatedValue : null,
    overdueValue: overdueValue < 0 ? overdueValue : null,
  };
  return {
    ...output,
    contractId: String(output.contractId).trim(),
    localizer: String(output.contractId).trim(),
    contractCode: String(output.contractCode || output.contractId).trim(),
    hasContractCodeSource: Boolean(String(output.contractCode || "").trim()),
    createdAt: parseExcelDate(output.createdAt),
    settlementDate: parseExcelDate(output.settlementDate),
    nextDueDate: parseExcelDate(output.nextDueDate),
    entryValue: toNumber(output.entryValue),
    effectivePaidValue: toNumber(output.effectivePaidValue),
    effectivePaidPercent: toNumber(output.effectivePaidPercent),
    remainingBalance: toNumber(output.remainingBalance),
    totalUpdatedValue: Math.max(0, totalUpdatedValue),
    overdueValue: Math.max(0, overdueValue),
    paidPercent: toNumber(output.paidPercent),
    category: getCategory(product),
    sourceExtras,
    sourceFinancialAdjustments,
    ...sourceTermination,
    notes: "",
    manualStatus: null,
    previousStatus: null,
    lastUpdatedAt: null,
    localUser: "Operador Local",
  };
}

function detectSourceTermination(row, output) {
  const entries = Object.entries(row);
  const sourceStatus = normalizeHeader(output.sourceStatus || "");
  if (sourceStatus === "ativo") {
    return {
      sourceTerminated: false,
      sourceReverted: false,
      sourceTerminationDate: null,
      sourceReversalDate: null,
      sourceTerminationReason: null,
      sourceTerminationOrigin: null,
    };
  }

  const statusText = sourceStatus;
  const terminatedByStatus = ["distrat", "cancelad", "rescind", "rescis"].some((term) => statusText.includes(term));
  const revertedByStatus = ["revertid", "reativad", "restaurad"].some((term) => statusText.includes(term));

  const dateEntry = output.sourceTerminationDate ? ["sourceTerminationDate", output.sourceTerminationDate] : entries.find(([header, value]) => {
    if (!value) return false;
    const normalized = normalizeHeader(header);
    return normalized.includes("data")
      && ["distrat", "cancel", "rescis"].some((term) => normalized.includes(term));
  });
  const reversalEntry = output.sourceReversalDate ? ["sourceReversalDate", output.sourceReversalDate] : entries.find(([header, value]) => {
    if (!value) return false;
    const normalized = normalizeHeader(header);
    return normalized.includes("data")
      && ["revers", "reativ", "restaur"].some((term) => normalized.includes(term));
  });
  const reasonEntry = output.sourceTerminationReason ? ["sourceTerminationReason", output.sourceTerminationReason] : entries.find(([header, value]) => {
    if (!value) return false;
    const normalized = normalizeHeader(header);
    return ["motivo", "razao", "causa"].some((term) => normalized.includes(term))
      && ["distrat", "cancel", "rescis"].some((term) => normalized.includes(term));
  });

  const sourceReverted = revertedByStatus || Boolean(reversalEntry);
  const sourceTerminated = !sourceReverted && (terminatedByStatus || Boolean(dateEntry) || Boolean(reasonEntry));
  return {
    sourceTerminated,
    sourceReverted,
    sourceTerminationDate: dateEntry ? parseExcelDate(dateEntry[1]) : null,
    sourceReversalDate: reversalEntry ? parseExcelDate(reversalEntry[1]) : null,
    sourceTerminationReason: reasonEntry
      ? String(reasonEntry[1])
      : terminatedByStatus
        ? String(output.sourceStatus || output.financialStatus || "Distrato identificado")
        : null,
    sourceTerminationOrigin: sourceTerminated ? "Base importada" : null,
  };
}

function normalizeExtraValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}
