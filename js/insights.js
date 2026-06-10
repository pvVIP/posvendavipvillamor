import { formatCurrency, formatPercent, toNumber } from "./utils.js";
import {
  calculateKpis,
  getAgingData,
  getHeatmapData,
  getTopDefaulted,
  groupByCategory,
  sum,
} from "./dashboard.js?v=20260609-7";

export function generateInsights(contracts, terminatedContracts = []) {
  const insights = [];
  const totalOverdue = sum(contracts, "overdueValue");
  const categoryRisk = groupByCategory(contracts, "overdueValue").sort((a, b) => b.value - a.value);
  const aging = getAgingData(contracts);
  const heatmap = getHeatmapData(contracts);
  const top = getTopDefaulted(contracts, 1)[0];
  const recovery = calculateKpis(contracts, terminatedContracts);

  if (categoryRisk[0] && totalOverdue) {
    insights.push(`${categoryRisk[0].label} representa ${formatPercent(categoryRisk[0].value / totalOverdue)} da inadimplência financeira.`);
  }

  const longAging = aging.find((item) => item.label === "180+");
  if (longAging) {
    insights.push(`Existem ${longAging.value} contratos acima de 180 dias, somando ${formatCurrency(longAging.amount)} em exposição.`);
  }

  if (top) {
    insights.push(`${top.primaryClient} possui a maior exposição individual: ${formatCurrency(top.overdueValue)}.`);
  }

  if (heatmap[0]) {
    insights.push(`O grupo ${heatmap[0].product} concentra o maior risco por produto, com ${heatmap[0].labelValue}.`);
  }

  insights.push(`O valor recuperável é ${formatCurrency(recovery.recoverableValue)}, correspondente ao total integralizado nos contratos inadimplentes com 90 dias ou mais.`);

  if (recovery.refundTotal > 0) {
    insights.push(`Os distratos registram ${formatCurrency(recovery.refundTotal)} em reembolsos e ${formatCurrency(recovery.retainedTotal)} em retenções informadas.`);
  }

  const severe = contracts.filter((item) => item.daysOverdue >= 90 && toNumber(item.overdueValue) > 0);
  if (severe.length) {
    insights.push(`${severe.length} contratos estão em prioridade alta de cobrança por atraso igual ou superior a 90 dias.`);
  }

  return insights;
}
