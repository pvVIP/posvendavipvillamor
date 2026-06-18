import {
  STATUS,
  CATEGORIES,
  formatCurrency,
  getAgingBucket,
  monthKey,
  toNumber,
} from "./utils.js";

export function getActiveContracts(contracts) {
  return contracts.filter((contract) => ![STATUS.TERMINATED, STATUS.TERMINATED_OTHER].includes(contract.appStatus));
}

export function calculateKpis(contracts, terminatedContracts = []) {
  const active = getActiveContracts(contracts);
  const defaulted = active.filter((item) => item.appStatus === STATUS.DEFAULTED);
  const late = active.filter((item) => item.appStatus === STATUS.LATE);
  const current = active.filter((item) => item.appStatus === STATUS.CURRENT || item.appStatus === STATUS.PAID);
  const totalPortfolio = sum(active, "totalUpdatedValue");
  const totalIntegralized = sum(active, "effectivePaidValue");
  const totalReceivable = active.reduce((total, item) => {
    const sourceBalance = toNumber(item.remainingBalance);
    const derivedBalance = Math.max(0, toNumber(item.totalUpdatedValue) - toNumber(item.effectivePaidValue));
    return total + (sourceBalance > 0 ? sourceBalance : derivedBalance);
  }, 0);
  const totalOverdue = sum(active, "overdueValue");
  const totalDefaultedOverdue = sum(defaulted, "overdueValue");
  const recoverableValue = sum(defaulted, "effectivePaidValue");
  const refundTotal = sum(terminatedContracts.filter((item) => item.hasRefund), "refundValue");
  const retainedTotal = sum(terminatedContracts.filter((item) => item.hasRetention), "retainedValue");
  const averageAging = average(active.filter((item) => toNumber(item.overdueValue) > 0), "daysOverdue");
  const overdueContracts = active.filter((item) => toNumber(item.overdueValue) > 0);
  const aging90Plus = overdueContracts.filter((item) => item.daysOverdue >= 90).length;
  const aging180Plus = overdueContracts.filter((item) => item.daysOverdue > 180).length;

  return {
    totalActive: active.length,
    totalCurrent: current.length,
    totalDefaulted: defaulted.length,
    totalLate: late.length,
    totalTerminated: terminatedContracts.length,
    totalPortfolio,
    totalIntegralized,
    totalReceivable,
    totalOverdue,
    totalDefaultedOverdue,
    defaultRate: totalPortfolio ? totalOverdue / totalPortfolio : 0,
    overdueRateReceivable: totalReceivable ? totalOverdue / totalReceivable : 0,
    defaultedRatePortfolio: totalPortfolio ? totalDefaultedOverdue / totalPortfolio : 0,
    defaultedRateReceivable: totalReceivable ? totalDefaultedOverdue / totalReceivable : 0,
    averageTicket: active.length ? totalPortfolio / active.length : 0,
    recoverableValue,
    refundTotal,
    retainedTotal,
    terminationRate: active.length + terminatedContracts.length ? terminatedContracts.length / (active.length + terminatedContracts.length) : 0,
    averageAging,
    aging90Plus,
    aging180Plus,
  };
}

export function groupByCategory(contracts, valueKey = "overdueValue") {
  return CATEGORIES.map((category) => ({
    label: category,
    value: sum(contracts.filter((item) => item.category === category), valueKey),
    count: contracts.filter((item) => item.category === category).length,
  })).filter((item) => item.value > 0 || item.count > 0);
}

export function getFunnelData(contracts, terminatedContracts) {
  return [
    { label: "Ativos", value: contracts.length },
    { label: "Em atraso", value: contracts.filter((item) => item.appStatus === STATUS.LATE).length },
    { label: "Inadimplentes", value: contracts.filter((item) => item.appStatus === STATUS.DEFAULTED).length },
    { label: "Distratados", value: terminatedContracts.length },
  ];
}

export function getAgingData(contracts) {
  const buckets = ["0-30", "31-60", "61-90", "91-180", "180+"];
  return buckets.map((bucket) => ({
    label: bucket,
    value: contracts.filter((item) => toNumber(item.overdueValue) > 0 && getAgingBucket(item.daysOverdue) === bucket).length,
    amount: sum(contracts.filter((item) => toNumber(item.overdueValue) > 0 && getAgingBucket(item.daysOverdue) === bucket), "overdueValue"),
  }));
}

export function getEvolutionData(contracts) {
  const grouped = new Map();
  contracts
    .filter((item) => toNumber(item.overdueValue) > 0)
    .forEach((item) => {
      const key = monthKey(item.nextDueDate || item.createdAt);
      grouped.set(key, (grouped.get(key) || 0) + toNumber(item.overdueValue));
    });
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([label, value]) => ({ label, value }));
}

export function getTopDefaulted(contracts, limit = 20) {
  return [...contracts]
    .filter((item) => item.appStatus === STATUS.DEFAULTED && toNumber(item.overdueValue) > 0)
    .sort((a, b) => toNumber(b.overdueValue) - toNumber(a.overdueValue))
    .slice(0, limit);
}

export function getHeatmapData(contracts) {
  const grouped = new Map();
  contracts.forEach((item) => {
    const key = `${item.category} | ${item.product}`;
    grouped.set(key, (grouped.get(key) || 0) + toNumber(item.overdueValue));
  });
  const rows = [...grouped.entries()]
    .map(([key, value]) => {
      const [category, product] = key.split(" | ");
      return { category, product, value };
    })
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 18);
  const max = Math.max(...rows.map((item) => item.value), 1);
  return rows.map((item) => ({ ...item, intensity: item.value / max, labelValue: formatCurrency(item.value) }));
}

export function sum(rows, key) {
  return rows.reduce((total, item) => total + toNumber(item[key]), 0);
}

function average(rows, key) {
  if (!rows.length) return 0;
  return rows.reduce((total, item) => total + toNumber(item[key]), 0) / rows.length;
}
