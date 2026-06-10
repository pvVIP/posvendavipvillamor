import {
  getAgingData,
  getEvolutionData,
  getFunnelData,
  groupByCategory,
} from "./dashboard.js";
import { formatCurrency } from "./utils.js";

const chartInstances = new Map();
const palette = ["#9D2A4F", "#D75D5C", "#D39473", "#522B2C", "#3268B8", "#079455"];

export function renderCharts(contracts, terminatedContracts, interactions = {}) {
  if (!window.Chart) return;
  renderCategoryChart(contracts, interactions.onCategorySelect);
  renderDonutChart(contracts);
  renderFunnelChart(contracts, terminatedContracts);
  renderAgingChart(contracts, interactions.onAgingSelect);
  renderEvolutionChart(contracts);
}

function upsertChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const existing = chartInstances.get(id);
  if (existing) existing.destroy();
  chartInstances.set(id, new window.Chart(canvas, config));
}

function moneyTooltip() {
  return {
    callbacks: {
      label: (context) => `${context.dataset.label || context.label}: ${formatCurrency(context.raw)}`,
    },
  };
}

function renderCategoryChart(contracts, onSelect) {
  const rows = groupByCategory(contracts, "overdueValue");
  upsertChart("categoryChart", {
    type: "bar",
    data: {
      labels: rows.map((item) => item.label),
      datasets: [{
        label: "Valor atrasado",
        data: rows.map((item) => item.value),
        backgroundColor: palette,
        borderRadius: 8,
      }],
    },
    options: baseOptions({
      plugins: { tooltip: moneyTooltip() },
      onClick: (_, elements) => {
        if (elements.length && onSelect) onSelect(rows[elements[0].index].label);
      },
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
    }),
  });
}

function renderDonutChart(contracts) {
  const rows = groupByCategory(contracts, "totalUpdatedValue");
  upsertChart("donutChart", {
    type: "doughnut",
    data: {
      labels: rows.map((item) => item.label),
      datasets: [{
        data: rows.map((item) => item.value),
        backgroundColor: palette,
        borderWidth: 0,
      }],
    },
    options: baseOptions({ cutout: "68%", plugins: { tooltip: moneyTooltip() } }),
  });
}

function renderFunnelChart(contracts, terminatedContracts) {
  const rows = getFunnelData(contracts, terminatedContracts);
  upsertChart("funnelChart", {
    type: "bar",
    data: {
      labels: rows.map((item) => item.label),
      datasets: [{
        label: "Contratos",
        data: rows.map((item) => item.value),
        backgroundColor: palette,
        borderRadius: 8,
      }],
    },
    options: baseOptions({ indexAxis: "y" }),
  });
}

function renderAgingChart(contracts, onSelect) {
  const rows = getAgingData(contracts);
  upsertChart("agingChart", {
    type: "bar",
    data: {
      labels: rows.map((item) => item.label),
      datasets: [{
        label: "Contratos",
        data: rows.map((item) => item.value),
        backgroundColor: "#D75D5C",
        borderRadius: 8,
      }],
    },
    options: baseOptions({
      onClick: (_, elements) => {
        if (elements.length && onSelect) onSelect(rows[elements[0].index].label);
      },
      onHover: (event, elements) => {
        event.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
    }),
  });
}

function renderEvolutionChart(contracts) {
  const rows = getEvolutionData(contracts);
  upsertChart("evolutionChart", {
    type: "line",
    data: {
      labels: rows.map((item) => item.label),
      datasets: [{
        label: "Inadimplência",
        data: rows.map((item) => item.value),
        borderColor: "#9D2A4F",
        backgroundColor: "rgba(157, 42, 79, 0.16)",
        fill: true,
        tension: 0.35,
        pointRadius: 3,
      }],
    },
    options: baseOptions({ plugins: { tooltip: moneyTooltip() } }),
  });
}

function baseOptions(extra = {}) {
  const theme = getChartTheme();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      intersect: false,
      mode: "index",
    },
    plugins: {
      legend: {
        labels: {
          color: theme.text,
          boxWidth: 10,
          usePointStyle: true,
        },
      },
      ...(extra.plugins || {}),
    },
    scales: extra.cutout ? undefined : {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: theme.muted, maxRotation: 0 },
      },
      y: {
        beginAtZero: true,
        grid: { color: theme.grid },
        border: { display: false },
        ticks: { color: theme.muted },
      },
    },
    ...extra,
    plugins: {
      legend: {
        labels: {
          color: theme.text,
          boxWidth: 10,
          usePointStyle: true,
        },
      },
      ...(extra.plugins || {}),
    },
  };
}

function getChartTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return dark
    ? {
        text: "#FFF7F8",
        muted: "#D1B8C0",
        grid: "rgba(255, 255, 255, 0.09)",
      }
    : {
        text: "#522B2C",
        muted: "#765447",
        grid: "rgba(82, 43, 44, 0.08)",
      };
}
