import { createDataProvider, getDataProviderInfo } from "./data-provider.js?v=20260612-3";
import { DistratoService } from "./distratos.js?v=20260612-3";
import { parseWorkbookFile } from "./upload.js?v=20260609-4";
import { renderCharts } from "./charts.js";
import { generateInsights } from "./insights.js?v=20260609-7";
import {
  STATUS,
  byUnique,
  debounce,
  downloadBlob,
  enrichContract,
  filenameDate,
  formatCurrency,
  formatDate,
  formatPercent,
  slugStatus,
  toNumber,
} from "./utils.js";
import {
  calculateKpis,
  getActiveContracts,
  groupByCategory,
  getHeatmapData,
  getTopDefaulted,
} from "./dashboard.js?v=20260609-7";

const db = createDataProvider();
const state = {
  contracts: [],
  terminated: [],
  historicalTerminated: [],
  reversions: [],
  sourceExceptions: [],
  filtered: [],
  selected: new Set(),
  page: 1,
  pageSize: 25,
  sortKey: "overdueValue",
  sortDirection: "desc",
  currentUser: "Operador Local",
  currentUserId: null,
  currentRole: "operator",
  pendingTermination: [],
  editingTermination: null,
  terminationTrigger: null,
  pendingImport: null,
  installPrompt: null,
  canWrite: true,
  authMode: "signin",
};

const distratos = new DistratoService(db);

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  bindAuthEvents();
  bindEvents();
  setupProgressiveWebApp();
  try {
    await db.init();
  } catch (error) {
    if (db.requiresAuthentication) {
      showAuthGate(error);
      return;
    }
    throw error;
  }
  await initializeApplication();
}

async function initializeApplication() {
  hideAuthGate();
  const settings = await db.getSettings();
  const identity = db.getIdentity?.();
  state.currentUser = identity?.name || settings.currentUser || "Operador Local";
  state.currentUserId = identity?.id || null;
  state.currentRole = identity?.role || "operator";
  state.canWrite = identity?.canWrite ?? true;
  document.getElementById("currentUserLabel").textContent = state.currentUser;
  document.getElementById("dataModeLabel").textContent = getDataProviderInfo().label;
  document.getElementById("userModeLabel").textContent = identity
    ? `${roleLabel(identity.role)} online`
    : "Usuário local";
  document.getElementById("changeUserButton").textContent = identity ? "Sair" : "Alterar";
  document.body.dataset.readonly = String(!state.canWrite);
  document.getElementById("uploadInput").disabled = !state.canWrite;
  document.getElementById("bulkTerminateButton").disabled = !state.canWrite;
  applyTheme(settings.theme || "light");
  await reload();
  const postImportReport = sessionStorage.getItem("villamor-post-import-report");
  if (postImportReport) {
    sessionStorage.removeItem("villamor-post-import-report");
    try {
      showPostImportReport(JSON.parse(postImportReport));
    } catch {
      toast("A base foi aplicada e os indicadores foram recalculados.");
    }
  } else if (settings.pendingSystemEvolutionReport) {
    await db.setSetting("pendingSystemEvolutionReport", null);
    showSystemEvolutionReport(settings.pendingSystemEvolutionReport);
  } else {
    toast(identity ? "Dados sincronizados com segurança." : "Aplicação carregada com persistência local.");
  }
}

function bindAuthEvents() {
  document.getElementById("authForm").addEventListener("submit", handleAuthentication);
  document.getElementById("authModeButton").addEventListener("click", () => {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    syncAuthMode();
  });
}

async function handleAuthentication(event) {
  event.preventDefault();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const displayName = document.getElementById("authDisplayName").value.trim();
  setAuthMessage("");
  document.body.classList.add("is-authenticating");

  try {
    if (state.authMode === "signup") {
      if (!displayName) throw new Error("Informe seu nome para criar o acesso.");
      const result = await db.signUp(email, password, displayName);
      if (!result.access_token) {
        state.authMode = "signin";
        syncAuthMode();
        setAuthMessage("Cadastro criado. Confirme o e-mail recebido e depois entre no sistema.", true);
        return;
      }
    } else {
      await db.signIn(email, password);
    }
    await db.init();
    await initializeApplication();
  } catch (error) {
    setAuthMessage(authErrorMessage(error));
  } finally {
    document.body.classList.remove("is-authenticating");
  }
}

function showAuthGate(error) {
  document.getElementById("authGate").hidden = false;
  document.body.classList.add("auth-open");
  document.querySelector(".app-shell").setAttribute("aria-hidden", "true");
  if (error?.code === "ACCOUNT_PENDING") {
    setAuthMessage("Conta criada, mas ainda aguardando aprovação do administrador.");
  } else if (error?.code !== "AUTH_REQUIRED" && error?.message) {
    setAuthMessage(error.message);
  }
  document.getElementById("authEmail").focus();
}

function hideAuthGate() {
  document.getElementById("authGate").hidden = true;
  document.body.classList.remove("auth-open");
  document.querySelector(".app-shell").removeAttribute("aria-hidden");
  setAuthMessage("");
}

function syncAuthMode() {
  const signup = state.authMode === "signup";
  document.getElementById("authNameField").hidden = !signup;
  document.getElementById("authSubmitButton").textContent = signup ? "Criar acesso" : "Entrar";
  document.getElementById("authModeButton").textContent = signup ? "Já tenho acesso" : "Criar primeiro acesso";
  document.getElementById("authPassword").autocomplete = signup ? "new-password" : "current-password";
  setAuthMessage("");
}

function setAuthMessage(message, success = false) {
  const element = document.getElementById("authMessage");
  element.textContent = message;
  element.classList.toggle("is-success", success);
}

function authErrorMessage(error) {
  if (error?.code === "ACCOUNT_PENDING") return "Seu cadastro aguarda aprovação do administrador.";
  const message = String(error?.message || "");
  if (/invalid login credentials/i.test(message)) return "E-mail ou senha incorretos.";
  if (/email not confirmed/i.test(message)) return "Confirme o e-mail recebido antes de entrar.";
  if (/user already registered/i.test(message)) return "Este e-mail já possui cadastro. Use a opção Entrar.";
  return message || "Não foi possível autenticar agora.";
}

function roleLabel(role) {
  return {
    admin: "Administrador",
    operator: "Operador",
    viewer: "Leitura",
  }[role] || "Usuário";
}

function bindEvents() {
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
  });

  const applyDebounced = debounce(() => {
    state.page = 1;
    renderAll();
  }, 150);

  ["globalSearch", "categoryFilter", "groupFilter", "statusFilter", "agingFilter", "valueFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("input", applyDebounced);
  });

  document.getElementById("clearFiltersButton").addEventListener("click", clearFilters);
  document.getElementById("refreshButton").addEventListener("click", refreshApplicationData);
  document.getElementById("pageSize").addEventListener("change", (event) => {
    state.pageSize = Number(event.target.value);
    state.page = 1;
    renderTable();
  });
  document.getElementById("prevPage").addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    renderTable();
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    state.page = Math.min(totalPages, state.page + 1);
    renderTable();
  });
  document.querySelectorAll("th[data-sort]").forEach((header) => {
    header.addEventListener("click", () => sortBy(header.dataset.sort));
  });
  document.getElementById("selectAllRows").addEventListener("change", toggleSelectPage);
  document.getElementById("bulkTerminateButton").addEventListener("click", requestBulkTermination);
  document.getElementById("terminateForm").addEventListener("submit", handleTerminationSubmit);
  document.getElementById("cancelTerminationButton").addEventListener("click", cancelTermination);
  document.getElementById("terminateDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelTermination();
  });
  document.getElementById("terminationReason").addEventListener("input", () => {
    document.getElementById("terminationReasonError").hidden = true;
  });
  document.getElementById("terminationApproach").addEventListener("change", () => {
    document.getElementById("terminationReasonError").hidden = true;
  });
  document.getElementById("hasRetention").addEventListener("change", syncTerminationFinancialFields);
  document.getElementById("hasRefund").addEventListener("change", syncTerminationFinancialFields);
  document.getElementById("retentionTotal").addEventListener("change", handleRetentionTotalChange);
  document.getElementById("terminationContractSelect").addEventListener("change", handleTerminationContractSelection);
  ["retainedValue", "refundValue"].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener("input", handleMoneyInput);
    input.addEventListener("blur", formatMoneyInput);
  });
  document.getElementById("uploadInput").addEventListener("change", handleUpload);
  document.getElementById("cancelImportButton").addEventListener("click", cancelImport);
  document.getElementById("confirmImportButton").addEventListener("click", () => confirmImport(false));
  document.getElementById("restartImportButton").addEventListener("click", () => confirmImport(true));
  document.getElementById("closeImportButton").addEventListener("click", closeImportDialog);
  document.getElementById("importDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelImport();
  });
  document.getElementById("captureButton").addEventListener("click", captureDashboard);
  document.getElementById("newTerminationButton").addEventListener("click", openTerminationFromHub);
  document.getElementById("formalTerminationReportButton").addEventListener("click", () => printTerminationReport("formal"));
  document.getElementById("executiveTerminationReportButton").addEventListener("click", () => printTerminationReport("executive"));
  document.getElementById("clearTerminationFiltersButton").addEventListener("click", clearTerminationFilters);
  ["terminationSearch", "terminationReasonFilter", "terminationApproachFilter", "terminationStartDate", "terminationEndDate"]
    .forEach((id) => document.getElementById(id).addEventListener("input", renderTerminatedTable));
  document.getElementById("changeUserButton").addEventListener("click", changeUser);
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("installAppButton").addEventListener("click", installProgressiveWebApp);
}

async function refreshApplicationData() {
  const button = document.getElementById("refreshButton");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Atualizando...";
  try {
    await reload();
    toast(db.requiresAuthentication ? "Dados sincronizados novamente." : "Indicadores recalculados.");
  } catch (error) {
    toast(`Não foi possível atualizar: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function setupProgressiveWebApp() {
  updateConnectionStatus();
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    document.getElementById("installAppButton").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    document.getElementById("installAppButton").hidden = true;
    toast("Aplicativo instalado com sucesso.");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      toast("O modo instalável ainda não pôde ser ativado.");
    });
  }
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  const status = document.getElementById("connectionStatus");
  status.classList.toggle("is-offline", !online);
  document.getElementById("connectionStatusLabel").textContent = online ? "Online" : "Sem conexão";
}

async function installProgressiveWebApp() {
  if (!state.installPrompt) {
    toast("A instalação estará disponível quando o navegador concluir a preparação do aplicativo.");
    return;
  }
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  document.getElementById("installAppButton").hidden = true;
}

async function reload() {
  state.contracts = (await db.getContracts()).map(enrichContract);
  state.terminated = (await db.getTerminatedContracts()).map(enrichContract);
  state.historicalTerminated = (await db.getSourceTerminations()).map(enrichContract);
  state.reversions = (await db.getSourceReversions()).map(enrichContract);
  state.sourceExceptions = (await db.getSourceExceptions()).map(enrichContract);
  populateFilterOptions();
  renderAll();
}

function renderAll() {
  state.filtered = applyFilters(state.contracts);
  renderPerformanceMeters();
  renderOperationalKpis();
  renderTable();
  renderTerminatedTable();
  renderHistoricalTerminatedTable();
  renderReversions();
  renderDataHealth();
  renderExecutive();
}

function renderPerformanceMeters() {
  const kpis = calculateKpis(getActiveContracts(state.filtered), getProductionTerminations());
  const percentage = kpis.totalActive ? kpis.totalCurrent / kpis.totalActive : 0;
  const content = performanceMeterMarkup(percentage, kpis.totalCurrent, kpis.totalActive);
  document.getElementById("operationalPerformance").innerHTML = content;
  document.getElementById("executivePerformance").innerHTML = content;
}

function performanceMeterMarkup(percentage, current, total) {
  const safePercentage = Math.max(0, Math.min(1, percentage));
  return `
    <div class="performance-meter-head">
      <div class="performance-meter-copy">
        <span>Índice de adimplência</span>
        <strong>Progresso da carteira</strong>
      </div>
      <div class="performance-meter-value">${formatPercent(safePercentage)}</div>
    </div>
    <div class="performance-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(safePercentage * 100)}">
      <div class="performance-fill" style="width:${safePercentage * 100}%"></div>
    </div>
    <div class="performance-caption">
      <span>${current} contratos adimplentes ou quitados</span>
      <span>${total} contratos no filtro atual</span>
    </div>
  `;
}

function switchTab(target) {
  document.querySelectorAll(".nav-tab").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === target));
  document.getElementById("operationalPanel").classList.toggle("active", target === "operational");
  document.getElementById("terminationsPanel").classList.toggle("active", target === "terminations");
  document.getElementById("reversionsPanel").classList.toggle("active", target === "reversions");
  document.getElementById("healthPanel").classList.toggle("active", target === "health");
  document.getElementById("executivePanel").classList.toggle("active", target === "executive");
  document.querySelector(".global-filters").hidden = !["operational", "executive"].includes(target);
  if (target === "executive") setTimeout(() => renderExecutive(), 80);
}

function populateFilterOptions() {
  setSelectOptions("categoryFilter", ["all", ...byUnique([...state.contracts, ...state.terminated].map((item) => item.category))], "Todas");
  setSelectOptions("groupFilter", ["all", ...byUnique([...state.contracts, ...state.terminated].map((item) => item.product))], "Todos");
  setSelectOptions("statusFilter", ["all", STATUS.CURRENT, STATUS.LATE, STATUS.DEFAULTED, STATUS.PAID, STATUS.TERMINATED], "Todos");
}

function setSelectOptions(id, values, allLabel) {
  const select = document.getElementById(id);
  const currentValue = select.value || "all";
  select.innerHTML = values.map((value) => {
    const label = value === "all" ? allLabel : value;
    return `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`;
  }).join("");
  select.value = [...select.options].some((option) => option.value === currentValue) ? currentValue : "all";
}

function applyFilters(contracts) {
  const query = document.getElementById("globalSearch").value.trim().toLowerCase();
  const category = document.getElementById("categoryFilter").value;
  const group = document.getElementById("groupFilter").value;
  const status = document.getElementById("statusFilter").value;
  const aging = document.getElementById("agingFilter").value;
  const valueRange = document.getElementById("valueFilter").value;

  return contracts
    .filter((contract) => {
      if (query && !contract.searchText.includes(query.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) return false;
      if (category !== "all" && contract.category !== category) return false;
      if (group !== "all" && contract.product !== group) return false;
      if (status !== "all" && contract.appStatus !== status) return false;
      if (aging !== "all" && contract.agingBucket !== aging) return false;
      if (!matchesValueRange(contract.totalUpdatedValue, valueRange)) return false;
      return true;
    })
    .sort((a, b) => compareRows(a, b, state.sortKey, state.sortDirection));
}

function matchesValueRange(value, range) {
  const number = toNumber(value);
  if (range === "all") return true;
  if (range === "500000+") return number >= 500000;
  const [min, max] = range.split("-").map(Number);
  return number >= min && number < max;
}

function compareRows(a, b, key, direction) {
  const multiplier = direction === "asc" ? 1 : -1;
  const av = a[key] ?? "";
  const bv = b[key] ?? "";
  if (typeof av === "number" || typeof bv === "number") return (toNumber(av) - toNumber(bv)) * multiplier;
  return String(av).localeCompare(String(bv), "pt-BR") * multiplier;
}

function sortBy(key) {
  if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  else {
    state.sortKey = key;
    state.sortDirection = "asc";
  }
  renderAll();
}

function renderOperationalKpis() {
  const kpis = calculateKpis(state.filtered, state.terminated);
  document.getElementById("operationalKpis").innerHTML = [
    metric("Contratos filtrados", kpis.totalActive, "Base ativa"),
    metric("Inadimplentes", kpis.totalDefaulted, formatPercent(kpis.totalActive ? kpis.totalDefaulted / kpis.totalActive : 0)),
    metric("Valor atrasado", formatCurrency(kpis.totalOverdue), "Exposição financeira"),
    metric("Aging médio", `${Math.round(kpis.averageAging)} dias`, "Pela data próximo vencimento"),
    metric("Aging 90+ dias", kpis.aging90Plus, "Prioridade alta"),
    metric("Aging 180+ dias", kpis.aging180Plus, "Risco crítico"),
  ].join("");
}

function renderExecutive() {
  const active = getActiveContracts(state.filtered);
  const productionTerminations = getProductionTerminations();
  const kpis = calculateKpis(active, productionTerminations);
  document.getElementById("dashboardDate").textContent = `Atualizado em ${formatDate(new Date().toISOString())}`;
  document.getElementById("executiveKpis").innerHTML = [
    metric("Contratos ativos", kpis.totalActive, "Carteira filtrada"),
    metric("Adimplentes", kpis.totalCurrent, "Inclui quitados", "success"),
    metric("Inadimplentes", kpis.totalDefaulted, "90+ dias", "danger"),
    metric("Em atraso", kpis.totalLate, "Até 89 dias", "warning"),
    metric("Distratados", kpis.totalTerminated, "A partir de 07/05/2026", "closed", "terminatedMetricCard"),
    metric("Recuperável", formatCurrency(kpis.recoverableValue), "Integralizado dos inadimplentes"),
    metric("Carteira", formatCurrency(kpis.totalPortfolio), "Valor total"),
    metric("Inadimplência", formatCurrency(kpis.totalOverdue), "Valor atrasado"),
    metric("% inadimplência", formatPercent(kpis.defaultRate), "Sobre carteira"),
    metric("Ticket médio", formatCurrency(kpis.averageTicket), "Ativos"),
    metric("% distratos", formatPercent(kpis.terminationRate), "Total histórico"),
    metric("Aging médio", `${Math.round(kpis.averageAging)} dias`, `${kpis.aging90Plus} contratos 90+ dias`),
  ].join("");
  bindTerminatedMetricHover();
  renderExecutiveBrief(active, kpis);
  renderCharts(active, productionTerminations, {
    onCategorySelect: (category) => applyDashboardDrilldown("categoryFilter", category),
    onAgingSelect: (aging) => applyDashboardDrilldown("agingFilter", aging),
  });
  renderHeatmap(active);
  renderRanking(active);
  renderInsights(active, productionTerminations);
}

function metric(label, value, helper, tone = "", id = "") {
  const toneClass = tone ? ` metric-card-${tone}` : "";
  const idAttribute = id ? ` id="${id}" tabindex="0"` : "";
  return `<article class="metric-card${toneClass}"${idAttribute}><span>${label}</span><strong>${value}</strong><small>${helper}</small></article>`;
}

function renderExecutiveBrief(contracts, kpis) {
  const categoryRisk = groupByCategory(contracts, "overdueValue").sort((a, b) => b.value - a.value)[0];
  const riskLevel = kpis.aging180Plus >= 40 || kpis.defaultRate >= 0.05
    ? "Crítico"
    : kpis.aging90Plus >= 20 || kpis.defaultRate >= 0.025
      ? "Atenção"
      : "Controlado";
  const riskMessage = riskLevel === "Crítico"
    ? "Priorize contratos com maior valor e atraso superior a 180 dias."
    : riskLevel === "Atenção"
      ? "A carteira exige acompanhamento concentrado nos atrasos acima de 90 dias."
      : "Os indicadores do filtro atual estão dentro de uma faixa administrável.";
  const concentration = categoryRisk && kpis.totalOverdue
    ? categoryRisk.value / kpis.totalOverdue
    : 0;

  document.getElementById("executiveBrief").innerHTML = `
    <article class="brief-lead">
      <span>Leitura executiva</span>
      <strong>Risco ${riskLevel}</strong>
      <small>${riskMessage}</small>
    </article>
    <article class="brief-item">
      <span>Faixa crítica</span>
      <strong>${kpis.aging180Plus} contratos</strong>
      <small>Com mais de 180 dias desde o próximo vencimento.</small>
    </article>
    <article class="brief-item">
      <span>Maior concentração</span>
      <strong>${escapeHtml(categoryRisk?.label || "Sem exposição")}</strong>
      <small>${formatPercent(concentration)} do valor total em atraso.</small>
    </article>
    <article class="brief-item">
      <span>Prioridade financeira</span>
      <strong>${formatCurrency(categoryRisk?.value || 0)}</strong>
      <small>Exposição da categoria mais representativa.</small>
    </article>
  `;
}

function renderTable() {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const rows = state.filtered.slice(start, start + state.pageSize);
  document.getElementById("tableSummary").textContent = `${state.filtered.length} contratos filtrados`;
  document.getElementById("pageIndicator").textContent = `Página ${state.page} de ${totalPages}`;
  document.getElementById("contractsTableBody").innerHTML = rows.map(renderContractRow).join("") || emptyRow(11, "Nenhum contrato encontrado.");
  document.getElementById("selectAllRows").checked = rows.length > 0 && rows.every((row) => state.selected.has(row.contractId));
  bindTableRows();
}

function renderContractRow(contract) {
  const checked = state.selected.has(contract.contractId) ? "checked" : "";
  const writeDisabled = state.canWrite ? "" : "disabled";
  return `
    <tr data-contract-id="${escapeAttr(contract.contractId)}">
      <td><input type="checkbox" class="row-check" ${checked} ${writeDisabled}></td>
      <td><strong>${escapeHtml(contract.contractId)}</strong></td>
      <td class="client-cell">
        <strong class="client-hover-trigger" tabindex="0">${escapeHtml(contract.primaryClient)}</strong>
        <span>${escapeHtml(contract.primaryDocument || contract.primaryPhone || "")}</span>
      </td>
      <td><span class="category-pill category-${categoryClass(contract.category)}">${escapeHtml(contract.category)}</span></td>
      <td>${escapeHtml(contract.product)}</td>
      <td>${formatCurrency(contract.effectivePaidValue)}</td>
      <td>${formatCurrency(contract.overdueValue)}</td>
      <td>${contract.daysOverdue}</td>
      <td><span class="status-badge status-${escapeAttr(slugStatus(contract.appStatus))}">${escapeHtml(contract.appStatus)}</span></td>
      <td><input class="notes-input" value="${escapeAttr(contract.notes || "")}" placeholder="Observações" ${writeDisabled}></td>
      <td>
        ${contract.lastUpdatedAt ? `<span class="last-update">${formatDate(contract.lastUpdatedAt)}</span>` : ""}
        ${state.canWrite ? '<button class="danger-button compact terminate-row-button" type="button">Distratar</button>' : ""}
      </td>
    </tr>
  `;
}

function bindTableRows() {
  document.querySelectorAll("#contractsTableBody tr[data-contract-id]").forEach((row) => {
    const contract = state.contracts.find((item) => item.contractId === row.dataset.contractId);
    row.querySelector(".row-check").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(contract.contractId);
      else state.selected.delete(contract.contractId);
    });
    const terminateButton = row.querySelector(".terminate-row-button");
    terminateButton?.addEventListener("click", () => {
      state.pendingTermination = [contract];
      state.terminationTrigger = terminateButton;
      openTerminateDialog();
    });
    const clientTrigger = row.querySelector(".client-hover-trigger");
    clientTrigger.addEventListener("mouseenter", () => showContractHoverCard(contract, clientTrigger));
    clientTrigger.addEventListener("mousemove", () => positionContractHoverCard(clientTrigger));
    clientTrigger.addEventListener("mouseleave", hideContractHoverCard);
    clientTrigger.addEventListener("focus", () => showContractHoverCard(contract, clientTrigger));
    clientTrigger.addEventListener("blur", hideContractHoverCard);
    row.querySelector(".notes-input").addEventListener("change", (event) => handleNotesChange(contract, event.target.value));
  });
}

async function handleNotesChange(contract, notes) {
  if (!state.canWrite) return;
  await distratos.updateNotes(contract, notes, state.currentUser);
  await reload();
  toast("Observação salva.");
}

function requestBulkTermination() {
  if (!state.canWrite) {
    toast("Seu perfil possui acesso somente para leitura.");
    return;
  }
  const selectedContracts = state.contracts.filter((item) => state.selected.has(item.contractId));
  if (!selectedContracts.length) {
    toast("Selecione pelo menos um contrato.");
    return;
  }
  state.pendingTermination = selectedContracts;
  state.terminationTrigger = document.getElementById("bulkTerminateButton");
  openTerminateDialog();
}

function openTerminationFromHub() {
  if (!state.canWrite) {
    toast("Seu perfil possui acesso somente para leitura.");
    return;
  }
  state.pendingTermination = [];
  state.editingTermination = null;
  state.terminationTrigger = document.getElementById("newTerminationButton");
  openTerminateDialog({ selectContract: true });
}

function openTerminateDialog() {
  const selectContract = arguments[0]?.selectContract === true;
  const editContract = arguments[0]?.editContract || null;
  state.editingTermination = editContract;
  const isEditing = Boolean(editContract);
  const contractField = document.getElementById("terminationContractField");
  const contractSelect = document.getElementById("terminationContractSelect");
  contractField.hidden = !selectContract;
  contractSelect.innerHTML = [
    '<option value="">Selecione um contrato ativo</option>',
    ...state.contracts
      .slice()
      .sort((a, b) => String(a.primaryClient).localeCompare(String(b.primaryClient), "pt-BR"))
      .map((contract) => `<option value="${escapeAttr(contract.contractId)}">${escapeHtml(contract.primaryClient)} · ${escapeHtml(contract.contractId)}</option>`),
  ].join("");

  document.getElementById("terminationReason").value = "";
  document.getElementById("terminationApproach").value = "";
  document.getElementById("terminationObservation").value = "";
  document.getElementById("terminationDate").value = localDateInputValue();
  document.getElementById("terminationReasonError").hidden = true;
  document.getElementById("terminationFinancialError").hidden = true;
  document.getElementById("terminationFinancialWarning").hidden = true;
  document.getElementById("hasRetention").checked = false;
  document.getElementById("hasRefund").checked = false;
  document.getElementById("retentionTotal").checked = false;
  document.getElementById("retainedValue").value = "";
  document.getElementById("refundValue").value = "";
  document.getElementById("terminationEditJustification").value = "";
  document.getElementById("terminationEditJustificationField").hidden = !isEditing;
  document.getElementById("terminateDialogTitle").textContent = isEditing ? "Editar distrato" : "Confirmar distrato";
  document.getElementById("terminateDialogDescription").textContent = isEditing
    ? "A alteração será registrada no histórico de auditoria."
    : "Esta operação removerá o contrato dos indicadores ativos.";
  document.getElementById("confirmTerminationButton").textContent = isEditing ? "Salvar alterações" : "Confirmar Distrato";

  if (isEditing) {
    state.pendingTermination = [editContract];
    const reasonSelect = document.getElementById("terminationReason");
    if (editContract.terminationReason && ![...reasonSelect.options].some((option) => option.value === editContract.terminationReason)) {
      reasonSelect.add(new Option(editContract.terminationReason, editContract.terminationReason));
    }
    document.getElementById("terminationReason").value = editContract.terminationReason || "";
    document.getElementById("terminationApproach").value = editContract.terminationApproach || "";
    document.getElementById("terminationObservation").value = editContract.terminationObservation || "";
    document.getElementById("terminationDate").value = String(editContract.terminatedAt || "").slice(0, 10);
    document.getElementById("hasRetention").checked = Boolean(editContract.hasRetention);
    document.getElementById("retainedValue").value = editContract.hasRetention
      ? formatMoneyForInput(editContract.retainedValue)
      : "";
    document.getElementById("retentionTotal").checked = Boolean(editContract.retentionTotal);
    document.getElementById("hasRefund").checked = Boolean(editContract.hasRefund);
    document.getElementById("refundValue").value = editContract.hasRefund
      ? formatMoneyForInput(editContract.refundValue)
      : "";
  }
  syncTerminationFinancialFields();
  renderTerminationContractSummary();
  document.getElementById("terminateDialog").showModal();
}

async function handleTerminationSubmit(event) {
  event.preventDefault();
  const reason = document.getElementById("terminationReason").value.trim();
  const approach = document.getElementById("terminationApproach").value;
  const observation = document.getElementById("terminationObservation").value.trim();
  const terminationDate = document.getElementById("terminationDate").value;
  if (!reason || !approach) {
    document.getElementById("terminationReasonError").textContent = !reason
      ? "Selecione o motivo para confirmar o distrato."
      : "Selecione se a abordagem foi ativa ou receptiva.";
    document.getElementById("terminationReasonError").hidden = false;
    document.getElementById(!reason ? "terminationReason" : "terminationApproach").focus();
    return;
  }
  if (!state.pendingTermination.length) {
    document.getElementById("terminationFinancialError").textContent = "Selecione o contrato que será distratado.";
    document.getElementById("terminationFinancialError").hidden = false;
    return;
  }
  if (!terminationDate) {
    document.getElementById("terminationFinancialError").textContent = "Informe a data do distrato.";
    document.getElementById("terminationFinancialError").hidden = false;
    return;
  }
  const hasRetention = document.getElementById("hasRetention").checked;
  const hasRefund = document.getElementById("hasRefund").checked;
  const retentionTotal = document.getElementById("retentionTotal").checked;
  const retainedValue = hasRetention ? toNumber(document.getElementById("retainedValue").value) : 0;
  const refundValue = hasRefund ? toNumber(document.getElementById("refundValue").value) : 0;
  const financialError = document.getElementById("terminationFinancialError");
  if ((hasRetention && retainedValue <= 0) || (hasRefund && refundValue <= 0)) {
    financialError.textContent = "Preencha corretamente os valores financeiros selecionados.";
    financialError.hidden = false;
    return;
  }
  if (state.pendingTermination.length > 1 && (hasRetention || hasRefund)) {
    financialError.textContent = "Retenção e reembolso devem ser lançados individualmente para cada contrato.";
    financialError.hidden = false;
    return;
  }
  const editJustification = document.getElementById("terminationEditJustification").value.trim();
  if (state.editingTermination && !editJustification) {
    financialError.textContent = "Informe a justificativa obrigatória para salvar a edição.";
    financialError.hidden = false;
    document.getElementById("terminationEditJustification").focus();
    return;
  }
  updateTerminationFinancialWarning();

  if (state.editingTermination) {
    await distratos.editTermination(state.editingTermination, reason, state.currentUser, {
      approach,
      observation,
      hasRetention,
      retainedValue,
      retentionTotal,
      hasRefund,
      refundValue,
      terminationDate,
      editJustification,
    });
    document.getElementById("terminateDialog").close();
    state.pendingTermination = [];
    state.editingTermination = null;
    await reload();
    toast("Distrato atualizado e alteração registrada.");
    return;
  }

  for (const contract of state.pendingTermination) {
    await distratos.terminate(contract, reason, state.currentUser, {
      approach,
      observation,
      hasRetention,
      retainedValue,
      retentionTotal,
      hasRefund,
      refundValue,
      terminationDate,
      userId: state.currentUserId,
    });
    state.selected.delete(contract.contractId);
  }
  document.getElementById("terminateDialog").close();
  state.pendingTermination = [];
  state.editingTermination = null;
  state.terminationTrigger = null;
  await reload();
  toast("Distrato registrado e indicadores atualizados.");
}

function cancelTermination() {
  document.getElementById("terminateDialog").close();
  document.getElementById("terminationReason").value = "";
  document.getElementById("terminationReasonError").hidden = true;
  document.getElementById("terminationFinancialError").hidden = true;
  document.getElementById("terminationFinancialWarning").hidden = true;
  state.pendingTermination = [];
  state.editingTermination = null;
  const trigger = state.terminationTrigger;
  state.terminationTrigger = null;
  trigger?.focus();
}

function syncTerminationFinancialFields() {
  const hasRetention = document.getElementById("hasRetention").checked;
  const hasRefund = document.getElementById("hasRefund").checked;
  document.getElementById("retainedValueField").hidden = !hasRetention;
  document.getElementById("retentionTotalField").hidden = !hasRetention || state.pendingTermination.length !== 1;
  document.getElementById("refundValueField").hidden = !hasRefund;
  document.getElementById("retainedValue").disabled = !hasRetention;
  document.getElementById("refundValue").disabled = !hasRefund;
  document.getElementById("retentionTotal").disabled = !hasRetention || state.pendingTermination.length !== 1;
  if (!hasRetention || state.pendingTermination.length !== 1) {
    document.getElementById("retentionTotal").checked = false;
  }
  document.getElementById("terminationFinancialError").hidden = true;
  updateTerminationFinancialWarning();
}

function handleTerminationContractSelection(event) {
  const contract = state.contracts.find((item) => item.contractId === event.target.value);
  state.pendingTermination = contract ? [contract] : [];
  document.getElementById("terminationFinancialError").hidden = true;
  syncTerminationFinancialFields();
  renderTerminationContractSummary();
}

function renderTerminationContractSummary() {
  const contract = state.pendingTermination.length === 1 ? state.pendingTermination[0] : null;
  const summary = document.getElementById("terminationContractSummary");
  if (!contract) {
    summary.innerHTML = "";
    summary.hidden = true;
    return;
  }
  summary.hidden = false;
  summary.innerHTML = `
    <strong>${escapeHtml(contract.primaryClient || "Cliente não informado")}</strong>
    <span>Contrato ${escapeHtml(contract.contractId)} · ${escapeHtml(contract.product || "Produto não informado")}</span>
    <small>Integralizado: ${formatCurrency(contract.effectivePaidValue)}</small>
  `;
}

function handleRetentionTotalChange(event) {
  if (!event.target.checked) return;
  const contract = state.pendingTermination.length === 1 ? state.pendingTermination[0] : null;
  if (!contract) return;
  document.getElementById("hasRetention").checked = true;
  document.getElementById("retainedValue").value = formatMoneyForInput(contract.effectivePaidValue);
  syncTerminationFinancialFields();
}

function formatMoneyForInput(value) {
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toNumber(value));
}

function updateTerminationFinancialWarning() {
  const warning = document.getElementById("terminationFinancialWarning");
  const contract = state.pendingTermination.length === 1 ? state.pendingTermination[0] : null;
  if (!contract) {
    warning.hidden = true;
    return;
  }
  const retainedValue = document.getElementById("hasRetention").checked
    ? toNumber(document.getElementById("retainedValue").value)
    : 0;
  const refundValue = document.getElementById("hasRefund").checked
    ? toNumber(document.getElementById("refundValue").value)
    : 0;
  const informedTotal = retainedValue + refundValue;
  const integralized = Math.max(0, toNumber(contract.effectivePaidValue));
  const excess = informedTotal - integralized;
  if (excess <= 0) {
    warning.hidden = true;
    return;
  }
  document.getElementById("terminationFinancialWarningText").textContent =
    `Retenção + reembolso somam ${formatCurrency(informedTotal)}, superando o integralizado de ${formatCurrency(integralized)} em ${formatCurrency(excess)}.`;
  warning.hidden = false;
}

function handleMoneyInput(event) {
  const input = event.target;
  const cursorAtEnd = input.selectionStart === input.value.length;
  let value = input.value.replace(/[^\d,.]/g, "");
  const commaIndex = value.lastIndexOf(",");
  if (commaIndex >= 0) {
    const integerPart = value.slice(0, commaIndex).replace(/[.,]/g, "");
    const decimalPart = value.slice(commaIndex + 1).replace(/\D/g, "").slice(0, 2);
    value = `${integerPart},${decimalPart}`;
  } else {
    value = value.replace(/\./g, "");
  }
  input.value = value;
  if (cursorAtEnd) input.setSelectionRange(value.length, value.length);
  updateTerminationFinancialWarning();
}

function formatMoneyInput(event) {
  const input = event.target;
  if (!input.value.trim()) return;
  const value = toNumber(input.value);
  input.value = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  updateTerminationFinancialWarning();
}

function localDateInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function renderTerminatedTable() {
  populateTerminationReasonFilter();
  const contracts = getFilteredTerminations();
  const totals = calculateTerminationTotals(contracts);
  document.getElementById("terminatedSummary").textContent = `${contracts.length} de ${state.terminated.length} registros`;
  document.getElementById("terminationKpis").innerHTML = [
    metric("Distratos", totals.count, "No período filtrado", "closed"),
    metric("Recuperado", formatCurrency(totals.retained), "Valor efetivamente retido", "success"),
    metric("Reembolsado", formatCurrency(totals.refunded), "Valor devolvido ao cliente", "warning"),
    metric("Integralizado", formatCurrency(totals.integralized), "Antes do distrato"),
    metric("Retenção média", formatCurrency(totals.averageRetention), "Por distrato"),
    metric("% de retenção", formatPercent(totals.retentionRate), "Sobre o integralizado"),
  ].join("");
  document.getElementById("terminationConsolidated").innerHTML = terminationConsolidatedMarkup(contracts);
  document.getElementById("terminatedTableBody").innerHTML = contracts.map((contract) => `
    <tr>
      <td><strong>${escapeHtml(contract.contractId)}</strong></td>
      <td>${escapeHtml(contract.primaryClient)}</td>
      <td>${formatCurrency(contract.effectivePaidValue)}</td>
      <td>${formatDate(contract.terminatedAt)}</td>
      <td><span class="status-badge ${contract.isDefaultTermination === false ? "termination-other" : "termination-default"}">${escapeHtml(contract.terminationReason || "Não informado")}</span></td>
      <td>${approachLabel(contract.terminationApproach)}</td>
      <td>${contract.hasRetention ? formatCurrency(contract.retainedValue) : "Não houve"}</td>
      <td>${contract.hasRefund ? formatCurrency(contract.refundValue) : "Não houve"}</td>
      <td class="termination-observation-cell">${escapeHtml(contract.terminationObservation || "-")}</td>
      <td>${escapeHtml(contract.terminatedBy || "-")}</td>
      <td class="termination-row-actions">
        <div>
          ${canEditTermination(contract) ? `<button class="secondary-button compact edit-termination-button" type="button" data-id="${escapeAttr(contract.contractId)}">Editar</button>` : ""}
          ${state.canWrite ? `<button class="ghost-button compact restore-button" type="button" data-id="${escapeAttr(contract.contractId)}">Restaurar</button>` : ""}
        </div>
      </td>
    </tr>
  `).join("") || emptyRow(11, "Nenhum distrato encontrado para estes filtros.");
  document.querySelectorAll(".edit-termination-button").forEach((button) => {
    button.addEventListener("click", () => {
      const contract = state.terminated.find((item) => item.contractId === button.dataset.id);
      state.terminationTrigger = button;
      openTerminateDialog({ editContract: contract });
    });
  });
  document.querySelectorAll(".restore-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const contract = state.terminated.find((item) => item.contractId === button.dataset.id);
      await distratos.restore(contract, state.currentUser);
      await reload();
      toast("Contrato restaurado.");
    });
  });
}

function populateTerminationReasonFilter() {
  const select = document.getElementById("terminationReasonFilter");
  const current = select.value || "all";
  const reasons = byUnique(state.terminated.map((item) => item.terminationReason).filter(Boolean));
  select.innerHTML = [
    '<option value="all">Todos</option>',
    ...reasons.map((reason) => `<option value="${escapeAttr(reason)}">${escapeHtml(reason)}</option>`),
  ].join("");
  select.value = [...select.options].some((option) => option.value === current) ? current : "all";
}

function getFilteredTerminations() {
  const query = document.getElementById("terminationSearch").value.trim().toLowerCase();
  const reason = document.getElementById("terminationReasonFilter").value;
  const approach = document.getElementById("terminationApproachFilter").value;
  const start = document.getElementById("terminationStartDate").value;
  const end = document.getElementById("terminationEndDate").value;
  return state.terminated
    .filter((contract) => {
      const haystack = `${contract.primaryClient || ""} ${contract.contractId || ""}`.toLowerCase();
      const date = String(contract.terminatedAt || "").slice(0, 10);
      if (query && !haystack.includes(query)) return false;
      if (reason !== "all" && contract.terminationReason !== reason) return false;
      if (approach !== "all" && (contract.terminationApproach || "nao_informada") !== approach) return false;
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    })
    .sort((a, b) => String(b.terminatedAt || "").localeCompare(String(a.terminatedAt || "")));
}

function calculateTerminationTotals(contracts) {
  const integralized = contracts.reduce((total, item) => total + Math.max(0, toNumber(item.effectivePaidValue)), 0);
  const retained = contracts.reduce((total, item) => total + (item.hasRetention ? Math.max(0, toNumber(item.retainedValue)) : 0), 0);
  const refunded = contracts.reduce((total, item) => total + (item.hasRefund ? Math.max(0, toNumber(item.refundValue)) : 0), 0);
  return {
    count: contracts.length,
    integralized,
    retained,
    refunded,
    averageRetention: contracts.length ? retained / contracts.length : 0,
    retentionRate: integralized ? retained / integralized : 0,
  };
}

function terminationConsolidatedMarkup(contracts) {
  const reasonCounts = countTerminationValues(contracts, (item) => item.terminationReason || "Não informado");
  const approachCounts = countTerminationValues(contracts, (item) => approachLabel(item.terminationApproach));
  return `
    <div>
      <span>Motivos</span>
      <div class="termination-breakdown-list">${breakdownItems(reasonCounts)}</div>
    </div>
    <div>
      <span>Abordagens</span>
      <div class="termination-breakdown-list">${breakdownItems(approachCounts)}</div>
    </div>
  `;
}

function countTerminationValues(contracts, selector) {
  const counts = new Map();
  contracts.forEach((contract) => {
    const key = selector(contract);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function breakdownItems(entries) {
  return entries.length
    ? entries.map(([label, value]) => `<span><strong>${escapeHtml(label)}</strong>${value}</span>`).join("")
    : "<small>Nenhum registro no filtro atual.</small>";
}

function approachLabel(value) {
  return {
    ativa: "Ativa",
    receptiva: "Receptiva",
    nao_informada: "Não informada",
  }[value] || "Não informada";
}

function canEditTermination(contract) {
  if (!state.canWrite) return false;
  if (state.currentRole === "admin") return true;
  if (state.currentUserId) return contract.terminatedById === state.currentUserId;
  return Boolean(contract.terminatedBy) && contract.terminatedBy === state.currentUser;
}

function clearTerminationFilters() {
  ["terminationSearch", "terminationStartDate", "terminationEndDate"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("terminationReasonFilter").value = "all";
  document.getElementById("terminationApproachFilter").value = "all";
  renderTerminatedTable();
}

function renderHistoricalTerminatedTable() {
  document.getElementById("historicalTerminatedSummary").textContent = `${state.historicalTerminated.length} registros`;
  document.getElementById("historicalTerminatedTableBody").innerHTML = state.historicalTerminated.map((contract) => `
    <tr>
      <td><strong>${escapeHtml(contract.contractId)}</strong></td>
      <td>${escapeHtml(contract.primaryClient || "-")}</td>
      <td>${formatCurrency(contract.effectivePaidValue)}</td>
      <td>${formatDate(contract.sourceTerminationDate)}</td>
      <td>${escapeHtml(contract.sourceTerminationReason || "Não informado")}</td>
      <td>${escapeHtml(contract.sourceTerminationOrigin || "Base importada")}</td>
    </tr>
  `).join("") || emptyRow(6, "Nenhum distrato histórico identificado até o momento.");
}

function renderReversions() {
  const linked = state.reversions.filter((contract) => contract.linkedActiveContractId);
  const unlinked = state.reversions.length - linked.length;
  document.getElementById("reversionsSummary").textContent = `${state.reversions.length} registros históricos`;
  document.getElementById("reversionKpis").innerHTML = [
    metric("Revertidos", state.reversions.length, "Fora da carteira ativa"),
    metric("Vinculados", linked.length, "Origem identificada", "success"),
    metric("Sem vínculo", unlinked, "Revisar origem reversão", unlinked ? "warning" : "success"),
    metric("Taxa de vínculo", formatPercent(state.reversions.length ? linked.length / state.reversions.length : 1), "Rastreabilidade"),
  ].join("");
  document.getElementById("reversionsTableBody").innerHTML = state.reversions.map((contract) => `
    <tr>
      <td><strong>${escapeHtml(contract.contractId)}</strong></td>
      <td>${escapeHtml(contract.primaryClient || "-")}</td>
      <td>${escapeHtml(contract.originReversal || "-")}</td>
      <td>${escapeHtml(contract.linkedActiveContractId || "Não localizado")}</td>
      <td>${escapeHtml(contract.linkedActiveClient || "-")}</td>
      <td>${formatDate(contract.sourceReversalDate)}</td>
      <td>${formatCurrency(contract.effectivePaidValue)}</td>
      <td><span class="status-badge ${contract.linkedActiveContractId ? "health-ok" : "health-warning"}">${contract.linkedActiveContractId ? "Vinculado" : "Pendente"}</span></td>
    </tr>
  `).join("") || emptyRow(8, "Nenhum contrato revertido identificado.");
}

function renderDataHealth() {
  const alerts = buildDataHealthAlerts();
  const critical = alerts.filter((alert) => alert.level === "critical");
  const warnings = alerts.filter((alert) => alert.level === "warning");
  const informative = alerts.filter((alert) => alert.level === "info");
  const totalRecords = Math.max(
    1,
    state.contracts.length + state.historicalTerminated.length + state.reversions.length + state.sourceExceptions.length,
  );
  const impact = alerts.reduce((total, alert) => {
    const weight = alert.level === "critical" ? 1.5 : alert.level === "warning" ? 0.65 : 0.15;
    return total + Math.min(alert.count, totalRecords) * weight;
  }, 0);
  const score = Math.max(0, Math.round(100 - (impact / totalRecords) * 100));
  const scoreLabel = score >= 90 ? "Base saudável" : score >= 75 ? "Atenção moderada" : score >= 55 ? "Revisão recomendada" : "Risco elevado";

  document.getElementById("healthUpdatedAt").textContent = `Analisado em ${formatDate(new Date().toISOString())}`;
  document.getElementById("healthScore").textContent = `${score}%`;
  document.getElementById("healthScoreLabel").textContent = scoreLabel;
  const scoreFill = document.getElementById("healthScoreFill");
  scoreFill.style.width = `${score}%`;
  scoreFill.dataset.level = score >= 90 ? "good" : score >= 75 ? "attention" : "risk";
  document.getElementById("healthKpis").innerHTML = [
    metric("Críticos", critical.length, `${critical.reduce((total, item) => total + item.count, 0)} registros afetados`, critical.length ? "danger" : "success"),
    metric("Atenção", warnings.length, `${warnings.reduce((total, item) => total + item.count, 0)} registros afetados`, warnings.length ? "warning" : "success"),
    metric("Informativos", informative.length, "Oportunidades de melhoria"),
    metric("Exceções", state.sourceExceptions.length, "Status não classificado", state.sourceExceptions.length ? "danger" : "success"),
  ].join("");
  document.getElementById("healthAlerts").innerHTML = alerts.map((alert) => `
    <article class="health-alert health-alert-${alert.level}">
      <div class="health-alert-marker">${alert.level === "critical" ? "!" : alert.level === "warning" ? "△" : "i"}</div>
      <div>
        <div class="health-alert-title">
          <strong>${escapeHtml(alert.title)}</strong>
          <span>${alert.count} ${alert.count === 1 ? "registro" : "registros"}</span>
        </div>
        <p>${escapeHtml(alert.detail)}</p>
        <small><strong>Ação:</strong> ${escapeHtml(alert.action)}</small>
      </div>
    </article>
  `).join("") || `
    <article class="health-alert health-alert-success">
      <div class="health-alert-marker">✓</div>
      <div><strong>Nenhum alerta relevante</strong><p>A estrutura atual está consistente com as regras de negócio configuradas.</p></div>
    </article>
  `;
}

function buildDataHealthAlerts() {
  const alerts = [];
  const notExplicitlyActive = state.contracts.filter((contract) => normalizeReportText(contract.sourceStatus) !== "ativo");
  const missingClients = state.contracts.filter((contract) => !String(contract.primaryClient || "").trim());
  const overdueWithoutDate = state.contracts.filter((contract) => toNumber(contract.overdueValue) > 0 && !contract.nextDueDate);
  const negativeAdjustments = [...state.contracts, ...state.historicalTerminated, ...state.reversions]
    .filter((contract) => (
      contract.sourceFinancialAdjustments?.totalUpdatedValue < 0
      || contract.sourceFinancialAdjustments?.overdueValue < 0
    ));
  const unlinkedReversions = state.reversions.filter((contract) => !contract.linkedActiveContractId);
  const reversionsWithoutOrigin = state.reversions.filter((contract) => !String(contract.originReversal || "").trim());
  const terminationsWithoutDate = state.historicalTerminated.filter((contract) => !contract.sourceTerminationDate);
  const terminationsWithoutReason = state.historicalTerminated.filter((contract) => !String(contract.sourceTerminationReason || "").trim());

  addHealthAlert(alerts, "critical", "Status incompatível na carteira ativa", notExplicitlyActive.length,
    "Existem contratos na área ativa sem status de origem igual a Ativo. Eles podem distorcer toda a carteira.",
    "Reaplique a base atual para concluir a segregação automática.");
  addHealthAlert(alerts, "critical", "Status de origem não reconhecido", state.sourceExceptions.length,
    "Esses registros foram preservados, mas ficaram fora dos indicadores porque não são Ativo, Cancelado ou Revertido.",
    "Confira os valores da coluna Status e informe novos padrões válidos para classificação.");
  addHealthAlert(alerts, "critical", "Inadimplência sem próximo vencimento", overdueWithoutDate.length,
    "O aging não pode ser calculado com segurança quando há valor em atraso sem data de próximo vencimento.",
    "Corrija a data na base de origem antes da próxima atualização.");
  addHealthAlert(alerts, "warning", "Reversões sem vínculo com contrato ativo", unlinkedReversions.length,
    "A reversão foi armazenada como histórico, porém a Origem Reversão não permitiu localizar o contrato atual.",
    "Padronize a Origem Reversão com o identificador do contrato relacionado.");
  addHealthAlert(alerts, "warning", "Reversões sem origem informada", reversionsWithoutOrigin.length,
    "Sem a origem, não é possível reconstruir a trajetória entre contrato antigo e contrato atual.",
    "Preencha a coluna Origem Reversão na fonte.");
  addHealthAlert(alerts, "warning", "Clientes ativos sem nome", missingClients.length,
    "A ausência do cliente prejudica busca, cobrança, conferência e relatórios.",
    "Complemente o cessionário principal na base de contratos.");
  addHealthAlert(alerts, "warning", "Ajustes financeiros negativos", negativeAdjustments.length,
    "Os valores originais foram preservados, mas neutralizados nos indicadores para não reduzir carteira ou inadimplência.",
    "Confirme se representam crédito, estorno ou ajuste e crie uma classificação financeira na origem.");
  addHealthAlert(alerts, "info", "Distratos históricos sem data", terminationsWithoutDate.length,
    "Esses registros não entram corretamente em análises mensais e coortes de distrato.",
    "Preencha a data de cancelamento quando disponível.");
  addHealthAlert(alerts, "info", "Distratos históricos sem motivo", terminationsWithoutReason.length,
    "A ausência do motivo limita análises de causa e prevenção.",
    "Padronize os motivos de cancelamento na fonte.");
  return alerts;
}

function addHealthAlert(alerts, level, title, count, detail, action) {
  if (count > 0) alerts.push({ level, title, count, detail, action });
}

function bindTerminatedMetricHover() {
  const card = document.getElementById("terminatedMetricCard");
  if (!card) return;
  const show = () => showTerminationSummary(card);
  card.addEventListener("mouseenter", show);
  card.addEventListener("mouseleave", hideContractHoverCard);
  card.addEventListener("focus", show);
  card.addEventListener("blur", hideContractHoverCard);
}

function showTerminationSummary(trigger) {
  const card = document.getElementById("contractHoverCard");
  const production = getProductionTerminations();
  const manualDefault = production.filter((item) => item.isDefaultTermination !== false).length;
  const manualOther = production.filter((item) => item.isDefaultTermination === false).length;
  const historicalWithDate = state.historicalTerminated.filter((item) => item.sourceTerminationDate).length;
  card.innerHTML = `
    <div class="hover-card-header">
      <div>
        <strong>Resumo dos distratos</strong>
        <span>Produção atual e histórico identificado nas bases</span>
      </div>
    </div>
    <div class="hover-card-grid">
      ${hoverDetail("Sua produção", `${production.length} desde 07/05/2026`)}
      ${hoverDetail("Por inadimplência", manualDefault)}
      ${hoverDetail("Outros motivos", manualOther)}
      ${hoverDetail("Históricos importados", state.historicalTerminated.length)}
      ${hoverDetail("Históricos com data", historicalWithDate)}
      ${hoverDetail("Integralizado histórico", formatCurrency(state.historicalTerminated.reduce((total, item) => total + toNumber(item.effectivePaidValue), 0)))}
    </div>
  `;
  card.hidden = false;
  positionContractHoverCard(trigger);
}

function getProductionTerminations() {
  const productionStart = new Date("2026-05-07T00:00:00");
  return state.terminated.filter((item) => {
    const date = new Date(item.terminatedAt);
    return !Number.isNaN(date.getTime()) && date >= productionStart;
  });
}

function renderHeatmap(contracts) {
  const rows = getHeatmapData(contracts);
  document.getElementById("heatmapGrid").innerHTML = rows.map((item) => {
    const alpha = 0.38 + item.intensity * 0.62;
    return `
      <div class="heat-cell" style="background: rgba(157, 42, 79, ${alpha})">
        <span>${escapeHtml(item.category)}</span>
        <strong>${escapeHtml(item.product)}</strong>
        <span>${item.labelValue}</span>
      </div>
    `;
  }).join("") || `<div class="heat-cell"><strong>Sem inadimplência no filtro atual</strong></div>`;
}

function renderRanking(contracts) {
  const rows = getTopDefaulted(contracts, 20);
  document.getElementById("rankingTable").innerHTML = rows.map((contract, index) => `
    <div class="ranking-item" data-contract-id="${escapeAttr(contract.contractId)}" tabindex="0">
      <strong>${index + 1}</strong>
      <div>
        <strong>${escapeHtml(contract.primaryClient)}</strong>
        <span>${escapeHtml(contract.contractId)} · ${escapeHtml(contract.category)} · ${contract.daysOverdue} dias</span>
      </div>
      <strong>${formatCurrency(contract.overdueValue)}</strong>
    </div>
  `).join("") || `<div class="insight-item">Sem inadimplentes para o filtro atual.</div>`;
  document.querySelectorAll(".ranking-item[data-contract-id]").forEach((item) => {
    const openContract = () => {
      const contract = state.contracts.find((row) => row.contractId === item.dataset.contractId);
      if (!contract) return;
      switchTab("operational");
      document.getElementById("globalSearch").value = contract.contractId;
      state.page = 1;
      renderAll();
      setTimeout(() => document.querySelector(`[data-contract-id="${CSS.escape(contract.contractId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    };
    item.addEventListener("click", openContract);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openContract();
      }
    });
  });
}

function applyDashboardDrilldown(filterId, value) {
  document.getElementById(filterId).value = value;
  state.page = 1;
  renderAll();
  toast(`Filtro aplicado: ${value}.`);
}

function showContractHoverCard(contract, trigger) {
  const card = document.getElementById("contractHoverCard");
  card.innerHTML = `
    <div class="hover-card-header">
      <div>
        <strong>${escapeHtml(contract.primaryClient)}</strong>
        <span>Contrato ${escapeHtml(contract.contractId)} · ${escapeHtml(contract.property || "-")} / ${escapeHtml(contract.quota || "-")}</span>
      </div>
      <span class="status-badge status-${escapeAttr(slugStatus(contract.appStatus))}">${escapeHtml(contract.appStatus)}</span>
    </div>
    <div class="hover-card-grid">
      ${hoverDetail("Cessionário 2", contract.secondaryClient || "Não informado")}
      ${hoverDetail("Produto", contract.product || "-")}
      ${hoverDetail("Valor do contrato", formatCurrency(contract.totalUpdatedValue))}
      ${hoverDetail("Valor em atraso", formatCurrency(contract.overdueValue))}
      ${hoverDetail("Próximo vencimento", formatDate(contract.nextDueDate))}
      ${hoverDetail("Aging", `${contract.daysOverdue} dias`)}
      ${hoverDetail("Telefone principal", contract.primaryPhone || "Não informado")}
      ${hoverDetail("Saldo restante", formatCurrency(contract.remainingBalance))}
    </div>
  `;
  card.hidden = false;
  positionContractHoverCard(trigger);
}

function hoverDetail(label, value) {
  return `<div class="hover-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function categoryClass(category) {
  const normalized = String(category || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (normalized.includes("diamante")) return "diamond";
  if (normalized.includes("ouro")) return "gold";
  if (normalized.includes("prata")) return "silver";
  if (normalized.includes("bronze")) return "bronze";
  return "neutral";
}

function positionContractHoverCard(trigger) {
  const card = document.getElementById("contractHoverCard");
  if (card.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 10;
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  let left = rect.right + margin;
  let top = rect.top - 14;
  if (left + cardWidth > window.innerWidth - margin) left = rect.left - cardWidth - margin;
  if (top + cardHeight > window.innerHeight - margin) top = window.innerHeight - cardHeight - margin;
  card.style.left = `${Math.max(margin, left)}px`;
  card.style.top = `${Math.max(margin, top)}px`;
}

function hideContractHoverCard() {
  document.getElementById("contractHoverCard").hidden = true;
}

function renderInsights(contracts, terminatedContracts) {
  document.getElementById("insightsList").innerHTML = generateInsights(contracts, terminatedContracts)
    .map((insight) => `<div class="insight-item">${escapeHtml(insight)}</div>`)
    .join("");
}

async function handleUpload(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const { contracts, validation, columnAnalysis, sheetName } = await parseWorkbookFile(file);
    const previousExtraHeaders = new Set(
      [...state.contracts, ...state.historicalTerminated, ...state.reversions, ...state.sourceExceptions]
        .flatMap((contract) => Object.keys(contract.sourceExtras || {}))
        .map(normalizeReportText),
    );
    const analyzedColumns = {
      ...columnAnalysis,
      newExtras: columnAnalysis.extras.filter((item) => !previousExtraHeaders.has(normalizeReportText(item.header))),
    };
    const currentSourceTotal = state.contracts.length + state.historicalTerminated.length + state.reversions.length + state.sourceExceptions.length;
    const importData = {
      contracts,
      validation,
      columnAnalysis: analyzedColumns,
      sheetName,
      currentSourceTotal,
      fileName: file.name,
      previousSnapshot: {
        active: state.contracts.length,
        historical: state.historicalTerminated.length,
        reverted: state.reversions.length,
        exceptions: state.sourceExceptions.length,
        overdueValue: state.contracts.reduce((total, contract) => total + Math.max(0, toNumber(contract.overdueValue)), 0),
      },
    };
    const restartAssessment = assessRestartRequirement(importData);
    state.pendingImport = validation.ok ? { ...importData, restartAssessment } : null;
    if (!validation.ok) {
      showImportReport({ validation, columnAnalysis: analyzedColumns, sheetName, currentSourceTotal, fileName: file.name });
      return;
    }
    showImportReport({
      validation,
      columnAnalysis: analyzedColumns,
      sheetName,
      currentSourceTotal,
      fileName: file.name,
      restartAssessment,
    });
  } catch (error) {
    state.pendingImport = null;
    showImportReport({
      validation: { errors: [error.message], warnings: [], totalRows: 0 },
      columnAnalysis: { mapped: [], usefulExtras: [], unknownExtras: [] },
      sheetName: "Erro",
      currentSourceTotal: state.contracts.length + state.historicalTerminated.length + state.reversions.length + state.sourceExceptions.length,
      fileName: file.name,
    });
  }
}

function showImportReport({
  validation,
  columnAnalysis = { mapped: [], usefulExtras: [], unknownExtras: [] },
  sheetName,
  currentSourceTotal = 0,
  fileName = "",
  mergeReport,
  restartAssessment = { required: false, reasons: [] },
}) {
  const delta = validation.totalRows - currentSourceTotal;
  const volumeLine = delta === 0
    ? `<div class="report-line success">Quantidade de registros mantida: ${validation.totalRows}.</div>`
    : delta > 0
      ? `<div class="report-line info">A nova base possui ${delta} registros a mais (${currentSourceTotal} → ${validation.totalRows}).</div>`
      : `<div class="report-line warning">A nova base possui ${Math.abs(delta)} registros a menos (${currentSourceTotal} → ${validation.totalRows}). Contratos ausentes não serão apagados automaticamente.</div>`;
  const lines = [
    `<div class="report-line ${validation.errors.length ? "error" : "success"}">Arquivo: ${escapeHtml(fileName)} · Aba: ${escapeHtml(sheetName)} · ${validation.totalRows} linhas.</div>`,
    volumeLine,
    validation.statusCounts
      ? `<div class="report-line info"><strong>Classificação:</strong> ${validation.statusCounts.active} ativos · ${validation.statusCounts.terminated} cancelados/distratados · ${validation.statusCounts.reverted} revertidos · ${validation.statusCounts.unknown} exceções.</div>`
      : "",
    ...(validation.ignoredRows || []).map((item) => `
      <div class="report-line warning">
        <strong>Linha ${item.line} ignorada com segurança</strong><br>
        ${escapeHtml(item.identifier)} · ${escapeHtml(item.reason)}
      </div>
    `),
    ...validation.errors.map((error) => `<div class="report-line error">${escapeHtml(error)}</div>`),
    ...validation.warnings.slice(0, 30).map((warning) => `<div class="report-line warning">${escapeHtml(warning)}</div>`),
    `<div class="report-heading">Estrutura interpretada</div>`,
    `<div class="report-line success">${columnAnalysis.mapped.length} colunas reconhecidas e conectadas ao sistema.</div>`,
    columnAnalysis.newExtras?.length
      ? `<div class="report-line info">${columnAnalysis.newExtras.length} campos são novos em relação aos dados já carregados.</div>`
      : `<div class="report-line success">Nenhum campo adicional novo em relação à estrutura já conhecida.</div>`,
    ...columnAnalysis.usefulExtras.map((item) => `
      <div class="report-line info">
        <strong>${escapeHtml(item.header)}</strong><br>${escapeHtml(item.contribution)}
      </div>
    `),
    ...columnAnalysis.unknownExtras.map((item) => `
      <div class="report-line">
        <strong>${escapeHtml(item.header)}</strong><br>${escapeHtml(item.contribution)}
      </div>
    `),
  ];
  if (mergeReport) {
    lines.push(`<div class="report-line success">Atualização concluída: ${mergeReport.inserted} ativos inseridos, ${mergeReport.updated} ativos atualizados, ${mergeReport.historicalTerminationsDetected} distratos históricos e ${mergeReport.reversionsDetected || 0} reversões segregadas.</div>`);
  }
  if (restartAssessment.required) {
    lines.push(
      `<div class="report-heading">Reinício necessário</div>`,
      ...restartAssessment.reasons.map((reason) => `<div class="report-line warning">${escapeHtml(reason)}</div>`),
    );
  } else if (validation.ok && !mergeReport) {
    lines.push(`<div class="report-line success">Esta atualização pode ser aplicada e recalculada sem fechar o sistema.</div>`);
  }
  document.getElementById("importDialogTitle").textContent = "Relatório de atualização";
  document.getElementById("importReport").innerHTML = lines.join("");
  const confirmButton = document.getElementById("confirmImportButton");
  const restartButton = document.getElementById("restartImportButton");
  confirmButton.disabled = false;
  confirmButton.textContent = "Aplicar base e recalcular";
  restartButton.disabled = false;
  restartButton.textContent = "Aplicar e reiniciar";
  confirmButton.hidden = !validation.ok || Boolean(mergeReport) || restartAssessment.required;
  restartButton.hidden = !validation.ok || Boolean(mergeReport) || !restartAssessment.required;
  document.getElementById("cancelImportButton").hidden = Boolean(mergeReport) || !validation.ok;
  document.getElementById("closeImportButton").hidden = validation.ok && !mergeReport;
  const dialog = document.getElementById("importDialog");
  if (!dialog.open) dialog.showModal();
}

function assessRestartRequirement(importData) {
  const reasons = [];
  if (importData.validation?.requiresRestart) {
    reasons.push("A estrutura desta base exige uma migração interna antes do recálculo.");
  }
  return { required: reasons.length > 0, reasons };
}

async function confirmImport(forceRestart = false) {
  if (!state.pendingImport) return;
  const pending = state.pendingImport;
  const button = document.getElementById(forceRestart ? "restartImportButton" : "confirmImportButton");
  button.disabled = true;
  button.textContent = "Aplicando e recalculando...";
  try {
    const mergeReport = await db.mergeContracts(pending.contracts, {
      fileName: pending.fileName,
      sheetName: pending.sheetName,
      totalRows: pending.validation.totalRows,
      sourceRows: pending.validation.sourceRows,
      ignoredRows: pending.validation.ignoredRows,
      previousRows: pending.currentSourceTotal,
      rowDelta: pending.validation.totalRows - pending.currentSourceTotal,
      usefulExtraColumns: pending.columnAnalysis.usefulExtras.map((item) => item.header),
      unclassifiedExtraColumns: pending.columnAnalysis.unknownExtras.map((item) => item.header),
    });
    const postImportReport = buildPostImportReport(pending, mergeReport, forceRestart);
    state.pendingImport = null;
    if (forceRestart) {
      sessionStorage.setItem("villamor-post-import-report", JSON.stringify(postImportReport));
      document.getElementById("importDialog").close();
      window.location.reload();
      return;
    }
    await reload();
    showPostImportReport(postImportReport);
    toast("Nova base aplicada e indicadores recalculados.");
  } catch (error) {
    button.disabled = false;
    button.textContent = forceRestart ? "Aplicar e reiniciar" : "Aplicar base e recalcular";
    toast(`Não foi possível aplicar a base: ${error.message}`);
  }
}

function buildPostImportReport(pending, mergeReport, restarted) {
  const contracts = pending.contracts;
  const historical = contracts.filter((contract) => contract.sourceTerminated);
  const reverted = contracts.filter((contract) => contract.sourceReverted);
  const active = contracts.filter((contract) => normalizeReportText(contract.sourceStatus) === "ativo");
  const exceptions = contracts.filter((contract) => (
    normalizeReportText(contract.sourceStatus) !== "ativo"
    && !contract.sourceTerminated
    && !contract.sourceReverted
  ));
  const missing = {
    client: contracts.filter((contract) => !String(contract.primaryClient || "").trim()).length,
    dueDate: contracts.filter((contract) => !contract.nextDueDate).length,
  };
  const adjusted = {
    totalValue: contracts.filter((contract) => contract.sourceFinancialAdjustments?.totalUpdatedValue < 0).length,
    overdueValue: contracts.filter((contract) => contract.sourceFinancialAdjustments?.overdueValue < 0).length,
  };
  const delta = pending.validation.totalRows - pending.currentSourceTotal;
  const allHeaders = [
    ...pending.columnAnalysis.mapped.map((item) => item.header),
    ...pending.columnAnalysis.usefulExtras.map((item) => item.header),
    ...pending.columnAnalysis.unknownExtras.map((item) => item.header),
  ].map(normalizeReportText);
  const suggestions = [];

  if (allHeaders.some((header) => ["estado", "cidade", "municipio", "uf"].some((term) => header.includes(term)))) {
    suggestions.push("Os dados geográficos podem virar um painel de inadimplência e distratos por região.");
  }
  if (historical.length) {
    suggestions.push("As datas e os motivos dos cancelamentos podem alimentar evolução mensal, coortes e ranking de motivos de distrato.");
  }
  if (reverted.length) {
    suggestions.push(`Foram identificados ${reverted.length} contratos revertidos. Eles foram retirados da carteira ativa e armazenados como histórico de alterações contratuais.`);
  }
  if (pending.columnAnalysis.unknownExtras.length) {
    suggestions.push(`${pending.columnAnalysis.unknownExtras.length} campos ainda não possuem uso confiável. Vale revisar os nomes e exemplos para decidir quais entram nos próximos indicadores.`);
  }
  if (missing.dueDate) {
    suggestions.push("Há contratos sem próximo vencimento; eles ficam fora de uma leitura completa de aging e merecem conferência na origem.");
  }
  if (!suggestions.length) {
    suggestions.push("A estrutura está bem coberta pelos indicadores atuais. O próximo ganho provável é comparar a evolução entre importações.");
  }

  return {
    fileName: pending.fileName,
    totalRows: pending.validation.totalRows,
    previousRows: pending.currentSourceTotal,
    previousSnapshot: pending.previousSnapshot,
    delta,
    active: active.length,
    historical: historical.length,
    reverted: reverted.length,
    exceptions: exceptions.length,
    missing,
    adjusted,
    usefulExtras: pending.columnAnalysis.usefulExtras,
    newExtras: pending.columnAnalysis.newExtras || [],
    unknownExtras: pending.columnAnalysis.unknownExtras,
    ignoredRows: pending.validation.ignoredRows || [],
    suggestions,
    mergeReport,
    restarted,
  };
}

function showPostImportReport(report) {
  const deltaText = report.delta === 0
    ? "O volume total permaneceu estável."
    : report.delta > 0
      ? `A base cresceu ${report.delta} registros em relação à referência anterior.`
      : `A base veio com ${Math.abs(report.delta)} registros a menos; os registros locais preservados não foram apagados automaticamente.`;
  const missingItems = [
    ["cliente principal", report.missing.client],
    ["próximo vencimento", report.missing.dueDate],
  ].filter(([, count]) => count > 0);
  const lines = [
    `<div class="report-line success"><strong>Atualização concluída.</strong><br>${escapeHtml(report.fileName)} · ${report.totalRows} registros processados${report.restarted ? " após reinício do sistema" : " sem necessidade de reinício"}.</div>`,
    `<div class="report-heading">Mudanças na base de dados</div>`,
    `<div class="report-line info">Ativos: ${report.previousSnapshot?.active ?? 0} → ${report.active} · Distratos históricos: ${report.previousSnapshot?.historical ?? 0} → ${report.historical} · Revertidos: ${report.previousSnapshot?.reverted ?? 0} → ${report.reverted} · Exceções: ${report.previousSnapshot?.exceptions ?? 0} → ${report.exceptions}.</div>`,
    `<div class="report-heading">Principais pontos</div>`,
    `<div class="report-line info">${escapeHtml(deltaText)}</div>`,
    `<div class="report-line success">${report.active} contratos com status Ativo, ${report.historical} distratos históricos e ${report.reverted} reversões separados da carteira atual.</div>`,
    `<div class="report-line success">${report.mergeReport.inserted} contratos inseridos, ${report.mergeReport.updated} atualizados e ${report.mergeReport.preservedTerminated} distratos da sua produção preservados.</div>`,
  ];
  if (report.ignoredRows.length) {
    lines.push(`<div class="report-line warning">${report.ignoredRows.length} linha de total foi reconhecida por múltiplos critérios e não foi importada como contrato.</div>`);
  }
  if (report.exceptions) {
    lines.push(`<div class="report-line warning">${report.exceptions} registros possuem status não reconhecido e foram preservados em Alertas de Dados, fora dos indicadores.</div>`);
  }
  if (report.mergeReport.unlinkedReversions) {
    lines.push(`<div class="report-line warning">${report.mergeReport.unlinkedReversions} reversões não puderam ser vinculadas a um contrato ativo pela Origem Reversão.</div>`);
  }

  if (missingItems.length) {
    lines.push(
      `<div class="report-heading">Atenção na qualidade dos dados</div>`,
      ...missingItems.map(([label, count]) => `<div class="report-line warning">${count} registros sem ${escapeHtml(label)}.</div>`),
    );
  }
  if (report.adjusted?.totalValue || report.adjusted?.overdueValue) {
    lines.push(
      `<div class="report-heading">Ajustes financeiros interpretados</div>`,
      `<div class="report-line warning">${report.adjusted.totalValue} valores totais negativos e ${report.adjusted.overdueValue} valores em atraso negativos foram preservados na origem e neutralizados nos indicadores.</div>`,
    );
  }
  if (report.usefulExtras.length) {
    lines.push(
      `<div class="report-heading">Dados adicionais com potencial</div>`,
      ...report.usefulExtras.map((item) => `<div class="report-line info"><strong>${escapeHtml(item.header)}</strong><br>${escapeHtml(item.contribution)}</div>`),
    );
  }
  if (report.newExtras.length) {
    lines.push(
      `<div class="report-heading">Novidades desta base</div>`,
      `<div class="report-line info">${report.newExtras.map((item) => escapeHtml(item.header)).join(", ")}.</div>`,
    );
  }
  lines.push(
    `<div class="report-heading">Apontamentos para evolução</div>`,
    ...report.suggestions.map((suggestion) => `<div class="report-line">${escapeHtml(suggestion)}</div>`),
  );
  if (report.unknownExtras.length) {
    lines.push(`<div class="report-line warning">Campos aguardando interpretação: ${report.unknownExtras.map((item) => escapeHtml(item.header)).join(", ")}.</div>`);
  }

  document.getElementById("importDialogTitle").textContent = "Atualização da base e evolução do sistema";
  document.getElementById("importReport").innerHTML = lines.join("");
  document.getElementById("confirmImportButton").hidden = true;
  document.getElementById("restartImportButton").hidden = true;
  document.getElementById("cancelImportButton").hidden = true;
  document.getElementById("closeImportButton").hidden = false;
  const dialog = document.getElementById("importDialog");
  if (!dialog.open) dialog.showModal();
}

function showSystemEvolutionReport(report) {
  const healthAlerts = buildDataHealthAlerts();
  const activeOverdue = state.contracts.reduce((total, contract) => total + Math.max(0, toNumber(contract.overdueValue)), 0);
  const lines = [
    `<div class="report-line success"><strong>Atualização e manutenção concluídas.</strong><br>O sistema revisou a base local antes de carregar os indicadores.</div>`,
    `<div class="report-heading">Resumo atual da base</div>`,
    `<div class="report-line info">${state.contracts.length} ativos · ${state.historicalTerminated.length} distratos históricos · ${state.reversions.length} revertidos · ${state.sourceExceptions.length} exceções.</div>`,
    `<div class="report-line info">Valor em atraso da carteira ativa: ${formatCurrency(activeOverdue)}.</div>`,
    `<div class="report-heading">Correção aplicada</div>`,
    `<div class="report-line warning">${report.removedSummaryRows} linha de total legada foi removida da carteira ativa: ${report.removedIdentifiers.map((item) => escapeHtml(item)).join(", ")}.</div>`,
    `<div class="report-heading">Mudanças e evoluções</div>`,
    ...report.changes.map((change) => `<div class="report-line info">${escapeHtml(change)}</div>`),
    `<div class="report-heading">Pontos importantes</div>`,
    ...report.observations.map((observation) => `<div class="report-line">${escapeHtml(observation)}</div>`),
    `<div class="report-heading">Saúde dos dados</div>`,
    healthAlerts.length
      ? `<div class="report-line warning">${healthAlerts.length} pontos de atenção estão detalhados na aba Alertas de Dados.</div>`
      : `<div class="report-line success">Nenhum alerta relevante foi identificado na base atual.</div>`,
    `<div class="report-line success">A carteira e os indicadores já foram recalculados após esta limpeza.</div>`,
  ];
  document.getElementById("importDialogTitle").textContent = "Atualização da base e evolução do sistema";
  document.getElementById("importReport").innerHTML = lines.join("");
  document.getElementById("confirmImportButton").hidden = true;
  document.getElementById("restartImportButton").hidden = true;
  document.getElementById("cancelImportButton").hidden = true;
  document.getElementById("closeImportButton").hidden = false;
  const dialog = document.getElementById("importDialog");
  if (!dialog.open) dialog.showModal();
}

function normalizeReportText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cancelImport() {
  state.pendingImport = null;
  document.getElementById("importDialog").close();
}

function closeImportDialog() {
  state.pendingImport = null;
  document.getElementById("importDialog").close();
}

function printTerminationReport(type) {
  const contracts = getFilteredTerminations();
  if (!contracts.length) {
    toast("Não há distratos no filtro atual para gerar o relatório.");
    return;
  }
  const totals = calculateTerminationTotals(contracts);
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    toast("O navegador bloqueou a abertura do relatório. Libere pop-ups para este site.");
    return;
  }
  reportWindow.opener = null;
  const period = terminationPeriodLabel();
  const logoUrl = new URL("assets/logo.png", window.location.href).href;
  const title = type === "formal" ? "Relatório Formal de Distratos" : "Resumo Executivo de Distratos";
  const body = type === "formal"
    ? formalTerminationReportMarkup(contracts, totals)
    : executiveTerminationReportMarkup(contracts, totals);
  reportWindow.document.write(`<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(title)}</title>
        <style>${terminationReportStyles()}</style>
      </head>
      <body>
        <header>
          <img src="${escapeAttr(logoUrl)}" alt="Villamor">
          <div><span>VILLAMOR · GESTÃO DA INADIMPLÊNCIA</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(period)} · Emitido em ${escapeHtml(formatDate(new Date().toISOString()))}</p></div>
        </header>
        ${body}
        <footer>Documento gerado pelo VILLAMOR INADIMPLÊNCIA · Recuperado corresponde ao valor efetivamente retido.</footer>
        <script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));<\/script>
      </body>
    </html>`);
  reportWindow.document.close();
}

function formalTerminationReportMarkup(contracts, totals) {
  return `
    <section class="summary-grid">
      ${reportMetric("Distratos", totals.count)}
      ${reportMetric("Recuperado", formatCurrency(totals.retained))}
      ${reportMetric("Reembolsado", formatCurrency(totals.refunded))}
      ${reportMetric("Integralizado", formatCurrency(totals.integralized))}
      ${reportMetric("Retenção média", formatCurrency(totals.averageRetention))}
      ${reportMetric("% de retenção", formatPercent(totals.retentionRate))}
    </section>
    <table>
      <thead><tr><th>Contrato / Cliente</th><th>Data</th><th>Motivo</th><th>Abordagem</th><th>Integralizado</th><th>Retido</th><th>Reembolso</th><th>Responsável</th></tr></thead>
      <tbody>${contracts.map((contract) => `
        <tr>
          <td><strong>${escapeHtml(contract.contractId)}</strong><br>${escapeHtml(contract.primaryClient || "-")}</td>
          <td>${escapeHtml(formatDate(contract.terminatedAt))}</td>
          <td>${escapeHtml(contract.terminationReason || "Não informado")}<small>${escapeHtml(contract.terminationObservation || "")}</small></td>
          <td>${escapeHtml(approachLabel(contract.terminationApproach))}</td>
          <td>${escapeHtml(formatCurrency(contract.effectivePaidValue))}</td>
          <td>${escapeHtml(contract.hasRetention ? formatCurrency(contract.retainedValue) : "-")}</td>
          <td>${escapeHtml(contract.hasRefund ? formatCurrency(contract.refundValue) : "-")}</td>
          <td>${escapeHtml(contract.terminatedBy || "-")}</td>
        </tr>`).join("")}
      </tbody>
    </table>
    ${reportBreakdowns(contracts)}
  `;
}

function executiveTerminationReportMarkup(contracts, totals) {
  const reasons = countTerminationValues(contracts, (item) => item.terminationReason || "Não informado");
  const approaches = countTerminationValues(contracts, (item) => approachLabel(item.terminationApproach));
  const largestRetention = contracts
    .filter((item) => item.hasRetention)
    .sort((a, b) => toNumber(b.retainedValue) - toNumber(a.retainedValue))[0];
  const receptive = contracts.filter((item) => item.terminationApproach === "receptiva").length;
  return `
    <section class="hero-summary">
      <div><span>VISÃO DO PERÍODO</span><h2>${totals.count} distratos acompanhados</h2><p>${formatPercent(contracts.length ? receptive / contracts.length : 0)} tiveram origem receptiva.</p></div>
      <strong>${escapeHtml(formatCurrency(totals.retained))}<small>recuperado por retenção</small></strong>
    </section>
    <section class="summary-grid executive">
      ${reportMetric("Integralizado", formatCurrency(totals.integralized))}
      ${reportMetric("Reembolsado", formatCurrency(totals.refunded))}
      ${reportMetric("Retenção média", formatCurrency(totals.averageRetention))}
      ${reportMetric("Taxa de retenção", formatPercent(totals.retentionRate))}
    </section>
    <section class="report-columns">
      <article><h3>Principais motivos</h3>${reportBars(reasons, contracts.length)}</article>
      <article><h3>Origem da abordagem</h3>${reportBars(approaches, contracts.length)}</article>
    </section>
    <section class="attention-box">
      <h3>Destaques do período</h3>
      <p>Motivo mais recorrente: <strong>${escapeHtml(reasons[0]?.[0] || "Não informado")}</strong>, com ${reasons[0]?.[1] || 0} registros.</p>
      <p>Maior retenção registrada: <strong>${escapeHtml(largestRetention ? formatCurrency(largestRetention.retainedValue) : "Não houve")}</strong>${largestRetention ? ` no contrato ${escapeHtml(largestRetention.contractId)}.` : "."}</p>
      <p>Ponto de atenção: ${totals.refunded > totals.retained ? "o total reembolsado supera o recuperado por retenções." : "o recuperado por retenções é igual ou superior aos reembolsos do período."}</p>
    </section>
  `;
}

function reportMetric(label, value) {
  return `<article class="report-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function reportBreakdowns(contracts) {
  const reasons = countTerminationValues(contracts, (item) => item.terminationReason || "Não informado");
  const approaches = countTerminationValues(contracts, (item) => approachLabel(item.terminationApproach));
  return `<section class="report-columns"><article><h3>Quantidade por motivo</h3>${reportBars(reasons, contracts.length)}</article><article><h3>Quantidade por abordagem</h3>${reportBars(approaches, contracts.length)}</article></section>`;
}

function reportBars(entries, total) {
  return entries.map(([label, value]) => `
    <div class="report-bar"><div><span>${escapeHtml(label)}</span><strong>${value}</strong></div><i style="width:${total ? (value / total) * 100 : 0}%"></i></div>
  `).join("") || "<p>Sem dados.</p>";
}

function terminationPeriodLabel() {
  const start = document.getElementById("terminationStartDate").value;
  const end = document.getElementById("terminationEndDate").value;
  if (start && end) return `Período de ${formatDate(start)} a ${formatDate(end)}`;
  if (start) return `A partir de ${formatDate(start)}`;
  if (end) return `Até ${formatDate(end)}`;
  return "Todos os lançamentos a partir de 07/05/2026";
}

function terminationReportStyles() {
  return `
    @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;color:#29191e;font:12px Arial,sans-serif;background:#fff}header{display:flex;align-items:center;gap:16px;padding-bottom:14px;border-bottom:3px solid #a62552}header img{width:64px;height:64px;border-radius:8px;object-fit:cover}header span{font-size:10px;font-weight:700;color:#a62552}h1{margin:3px 0;font-size:24px}header p{margin:0;color:#6f6267}.summary-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:16px 0}.summary-grid.executive{grid-template-columns:repeat(4,1fr)}.report-metric{padding:12px;border:1px solid #dfd5d9;border-bottom:4px solid #a62552;border-radius:6px}.report-metric span{display:block;color:#75666c;font-size:10px;text-transform:uppercase}.report-metric strong{display:block;margin-top:6px;font-size:17px}table{width:100%;border-collapse:collapse;font-size:9px}th{padding:7px;background:#3c2029;color:#fff;text-align:left}td{padding:7px;border-bottom:1px solid #e5dde0;vertical-align:top}td small{display:block;margin-top:3px;color:#766970}.report-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}.report-columns article,.attention-box,.hero-summary{padding:16px;border:1px solid #ded3d7;border-radius:7px}h3{margin:0 0 12px}.report-bar{margin:9px 0}.report-bar div{display:flex;justify-content:space-between}.report-bar i{display:block;height:5px;margin-top:4px;border-radius:3px;background:linear-gradient(90deg,#98244c,#e25c72)}.hero-summary{display:flex;justify-content:space-between;align-items:center;margin:16px 0;background:#342027;color:#fff}.hero-summary span{font-size:10px;color:#f09bad}.hero-summary h2{margin:5px 0;font-size:24px}.hero-summary p{margin:0;color:#dacbd0}.hero-summary>strong{font-size:28px;color:#ffb3c2;text-align:right}.hero-summary>strong small{display:block;font-size:10px;color:#fff}.attention-box{margin-top:16px;background:#fff8fa}.attention-box p{margin:8px 0}footer{margin-top:18px;padding-top:8px;border-top:1px solid #ddd;color:#776a6f;font-size:9px;text-align:center}@media print{button{display:none}}`;
}

async function captureDashboard() {
  switchTab("executive");
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (!window.html2canvas) {
    toast("Biblioteca de captura ainda não carregou.");
    return;
  }
  const area = document.getElementById("dashboardCaptureArea");
  document.body.classList.add("is-capturing");
  try {
    const darkMode = document.documentElement.dataset.theme === "dark";
    const canvas = await window.html2canvas(area, {
      scale: 2,
      backgroundColor: darkMode ? "#171214" : "#f7eef2",
      useCORS: true,
    });
    canvas.toBlob((blob) => {
      downloadBlob(blob, `Dashboard_Inadimplencia_${filenameDate()}.jpg`);
    }, "image/jpeg", 0.95);
  } finally {
    document.body.classList.remove("is-capturing");
  }
}

async function changeUser() {
  if (db.requiresAuthentication) {
    await db.signOut();
    window.location.reload();
    return;
  }
  const nextUser = prompt("Nome do usuário local", state.currentUser);
  if (!nextUser?.trim()) return;
  state.currentUser = nextUser.trim();
  document.getElementById("currentUserLabel").textContent = state.currentUser;
  await db.setSetting("currentUser", state.currentUser);
  toast("Usuário local atualizado.");
}

async function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  await db.setSetting("theme", nextTheme);
  renderExecutive();
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.getElementById("themeToggle").setAttribute("aria-pressed", String(dark));
  document.getElementById("themeToggleLabel").textContent = dark ? "Modo claro" : "Modo escuro";
  document.querySelector(".theme-toggle-icon").textContent = dark ? "☀" : "◐";
}

function clearFilters() {
  document.getElementById("globalSearch").value = "";
  ["categoryFilter", "groupFilter", "statusFilter", "agingFilter", "valueFilter"].forEach((id) => {
    document.getElementById(id).value = "all";
  });
  state.page = 1;
  renderAll();
}

function toggleSelectPage(event) {
  const start = (state.page - 1) * state.pageSize;
  const rows = state.filtered.slice(start, start + state.pageSize);
  rows.forEach((row) => {
    if (event.target.checked) state.selected.add(row.contractId);
    else state.selected.delete(row.contractId);
  });
  renderTable();
}

function emptyRow(cols, message) {
  return `<tr><td colspan="${cols}">${message}</td></tr>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#039;");
}

function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  document.getElementById("toastHost").appendChild(item);
  setTimeout(() => item.remove(), 3600);
}
