export const STATUS = {
  CURRENT: "Adimplente",
  LATE: "Em atraso",
  DEFAULTED: "Inadimplente",
  TERMINATED: "Distrato Inadimplência",
  TERMINATED_OTHER: "Distrato Outros Motivos",
  PAID: "Quitado",
};

export const STATUS_OPTIONS = [
  STATUS.CURRENT,
  STATUS.LATE,
  STATUS.DEFAULTED,
  STATUS.TERMINATED,
];

export const REQUIRED_COLUMNS = [
  "LOCALIZADOR",
  "DATA",
  "STATUS",
  "IMÓVEL",
  "COTA",
  "PRODUTO",
  "CESSIONÁRIO 1",
  "STATUS FINANCEIRO",
  "VALOR TOTAL ATUALIZADO",
  "VALOR ATRASADO",
  "DATA PRÓXIMO VENCIMENTO",
];

export const CATEGORIES = ["Diamante", "Prata", "Ouro", "Bronze", "Não classificado"];

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function normalizeHeader(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

export function getCategory(product) {
  const normalized = normalizeText(product);
  if (normalized.includes("diamante")) return "Diamante";
  if (normalized.includes("prata")) return "Prata";
  if (normalized.includes("ouro")) return "Ouro";
  if (normalized.includes("bronze")) return "Bronze";
  return "Não classificado";
}

export function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === "") return 0;
  const clean = String(value)
    .replace(/[R$\s.]/g, "")
    .replace(",", ".");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseExcelDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number") {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + value * 86400000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 2,
  }).format(toNumber(value));
}

export function formatPercent(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatDate(value) {
  if (!value) return "-";
  const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR").format(date);
}

export function todayIso() {
  return new Date().toISOString();
}

export function getDaysOverdue(contract, referenceDate = new Date()) {
  if (!contract.nextDueDate || toNumber(contract.overdueValue) <= 0) return 0;
  const nextDue = new Date(contract.nextDueDate);
  if (Number.isNaN(nextDue.getTime())) return 0;
  const diff = Math.floor((referenceDate - nextDue) / 86400000);
  return Math.max(0, diff);
}

export function getAgingBucket(days) {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 180) return "91-180";
  return "180+";
}

export function deriveStatus(contract) {
  if (contract.manualStatus === STATUS.TERMINATED || contract.manualStatus === STATUS.TERMINATED_OTHER) {
    return contract.manualStatus;
  }
  if (contract.financialStatus === STATUS.PAID || normalizeText(contract.financialStatus) === "quitado") {
    return STATUS.PAID;
  }
  const overdueValue = toNumber(contract.overdueValue);
  if (overdueValue <= 0) return STATUS.CURRENT;
  return getDaysOverdue(contract) >= 90 ? STATUS.DEFAULTED : STATUS.LATE;
}

export function enrichContract(contract) {
  const category = contract.category || getCategory(contract.product);
  const daysOverdue = getDaysOverdue(contract);
  const appStatus = deriveStatus({ ...contract, category });
  return {
    ...contract,
    category,
    daysOverdue,
    agingBucket: getAgingBucket(daysOverdue),
    appStatus,
    searchText: normalizeText([
      contract.contractCode,
      contract.localizer,
      contract.contractId,
      contract.sourceNumber,
      contract.primaryClient,
      contract.secondaryClient,
      contract.primaryDocument,
      contract.product,
      category,
      appStatus,
    ].join(" ")),
  };
}

export function byUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
}

export function debounce(fn, delay = 180) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

export function slugStatus(status) {
  return String(status).replace(/\s+/g, "-");
}

export function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function monthKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "Sem data";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function filenameDate(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR")
    .format(date)
    .replace(/\//g, "-");
}
