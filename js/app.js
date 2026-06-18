import { createDataProvider, getDataProviderInfo } from "./data-provider.js?v=20260616-1";
import { DistratoService } from "./distratos.js?v=20260615-1";
import { parseWorkbookFile } from "./upload.js?v=20260616-1";
import { renderCharts } from "./charts.js";
import { generateInsights } from "./insights.js?v=20260609-7";
import {
  STATUS,
  byUnique,
  debounce,
  enrichContract,
  formatCurrency,
  formatDate,
  formatPercent,
  slugStatus,
  toNumber,
} from "./utils.js";
import {
  calculateKpis,
  getActiveContracts,
  getAgingData,
  groupByCategory,
  getHeatmapData,
  getTopDefaulted,
} from "./dashboard.js?v=20260617-1";

const db = createDataProvider();
const NAVIGATION_STORAGE_KEY = "pos-venda-vip-navigation-collapsed";
const state = {
  contracts: [],
  terminated: [],
  historicalTerminated: [],
  activeTerminationConflicts: [],
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
  currentJobTitle: "",
  currentAvatarUrl: "",
  profileAvatarDraft: "",
  annotationContract: null,
  pendingTermination: [],
  editingTermination: null,
  terminationTrigger: null,
  pendingImport: null,
  installPrompt: null,
  canWrite: true,
  authMode: "signin",
  navigationCollapsed: readNavigationPreference(),
  operationalKpisExpanded: false,
  presentationMode: false,
  riskPercentageBasis: "receivable",
  recoverableScenario: "full",
};

const distratos = new DistratoService(db);

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  syncNavigationState(state.navigationCollapsed);
  syncTopbar("operational");
  bindAuthEvents();
  bindEvents();
  setupProgressiveWebApp();
  const authRedirectError = db.consumeAuthRedirectError?.();
  if (authRedirectError) {
    showAuthGate();
    setAuthMessage("Este link de recuperação expirou ou já foi utilizado. Solicite um novo link.");
    return;
  }
  if (db.consumePasswordRecovery?.()) {
    state.authMode = "reset";
    syncAuthMode();
    showAuthGate();
    setAuthMessage("Link confirmado. Crie uma nova senha com pelo menos 15 caracteres.", true);
    return;
  }
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
  const localProfile = settings.profile || {};
  state.currentUser = identity?.name || localProfile.display_name || settings.currentUser || "Operador Local";
  state.currentUserId = identity?.id || null;
  state.currentRole = identity?.role || "operator";
  state.currentJobTitle = identity?.jobTitle || localProfile.job_title || "Sucesso do Cliente";
  state.currentAvatarUrl = identity?.avatarUrl || localProfile.avatar_url || "";
  state.canWrite = identity?.canWrite ?? true;
  syncProfileSummary();
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
  document.getElementById("authForgotButton").addEventListener("click", () => {
    state.authMode = "forgot";
    syncAuthMode();
  });
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
    } else if (state.authMode === "forgot") {
      await db.requestPasswordReset(email, `${window.location.origin}${window.location.pathname}`);
      state.authMode = "signin";
      syncAuthMode();
      setAuthMessage(
        "Se este e-mail estiver cadastrado, enviaremos um link para criar uma nova senha. Verifique também o spam.",
        true,
      );
      return;
    } else if (state.authMode === "reset") {
      const confirmation = document.getElementById("authConfirmPassword").value;
      if (password !== confirmation) throw new Error("As duas senhas precisam ser iguais.");
      await db.updatePassword(password);
      await db.signOut();
      state.authMode = "signin";
      syncAuthMode();
      setAuthMessage("Senha alterada. Entre novamente usando a nova senha.", true);
      return;
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
  document.getElementById(state.authMode === "reset" ? "authPassword" : "authEmail").focus();
}

function hideAuthGate() {
  document.getElementById("authGate").hidden = true;
  document.body.classList.remove("auth-open");
  document.querySelector(".app-shell").removeAttribute("aria-hidden");
  setAuthMessage("");
}

function syncAuthMode() {
  const signup = state.authMode === "signup";
  const forgot = state.authMode === "forgot";
  const reset = state.authMode === "reset";
  const email = document.getElementById("authEmail");
  const password = document.getElementById("authPassword");
  const confirmation = document.getElementById("authConfirmPassword");
  document.getElementById("authNameField").hidden = !signup;
  document.getElementById("authEmailField").hidden = reset;
  document.getElementById("authPasswordField").hidden = forgot;
  document.getElementById("authConfirmPasswordField").hidden = !reset;
  document.getElementById("authForgotButton").hidden = state.authMode !== "signin";
  document.getElementById("authModeButton").hidden = reset;
  document.getElementById("authSubmitButton").textContent = signup
    ? "Criar acesso"
    : forgot
      ? "Enviar link de recuperação"
      : reset
        ? "Salvar nova senha"
        : "Entrar";
  document.getElementById("authModeButton").textContent = state.authMode === "signin"
    ? "Criar primeiro acesso"
    : "Voltar para entrar";
  email.required = !reset;
  password.required = !forgot;
  password.autocomplete = signup || reset ? "new-password" : "current-password";
  confirmation.required = reset;
  if (signup || reset) password.minLength = 15;
  else password.removeAttribute("minlength");
  if (reset) confirmation.minLength = 15;
  else confirmation.removeAttribute("minlength");
  if (!reset) confirmation.value = "";
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
  if (/rate limit|security purposes|over_email_send_rate_limit/i.test(message)) {
    return "O limite temporário de e-mails foi atingido. Aguarde alguns minutos antes de solicitar outro link.";
  }
  if (/password.*15|at least 15|weak password/i.test(message)) {
    return "A nova senha precisa ter pelo menos 15 caracteres.";
  }
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
    button.addEventListener("click", () => {
      switchTab(button.dataset.tabTarget);
      if (window.matchMedia("(max-width: 980px)").matches) {
        setNavigationCollapsed(true, true);
      }
    });
  });
  document.getElementById("navigationToggle").addEventListener("click", () => {
    setNavigationCollapsed(!state.navigationCollapsed, true);
  });
  window.addEventListener("resize", debounce(() => {
    syncNavigationState(state.navigationCollapsed);
    syncResponsiveExecutiveDisclosure();
  }, 120));

  const applyDebounced = debounce(() => {
    state.page = 1;
    renderAll();
    updateFilterDock();
  }, 150);

  ["globalSearch", "categoryFilter", "groupFilter", "statusFilter", "agingFilter", "valueFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("input", applyDebounced);
  });

  document.getElementById("clearFiltersButton").addEventListener("click", clearFilters);
  document.getElementById("filterToggleButton").addEventListener("click", toggleFilterPanel);
  document.querySelectorAll("[data-close-filter-panel]").forEach((button) => {
    button.addEventListener("click", closeFilterPanel);
  });
  document.addEventListener("pointerdown", handleFilterPanelOutsideClick);
  document.addEventListener("keydown", handleFilterPanelKeydown);
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
  document.getElementById("clearSelectionButton").addEventListener("click", clearSelection);
  document.getElementById("operationalKpiToggle").addEventListener("click", toggleOperationalKpis);
  document.getElementById("priorityQueueButton").addEventListener("click", openPriorityQueue);
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
  document.getElementById("terminationContractSearch").addEventListener("input", renderTerminationContractResults);
  document.getElementById("terminationContractSearch").addEventListener("focus", renderTerminationContractResults);
  document.getElementById("terminationContractSearch").addEventListener("keydown", handleTerminationContractSearchKeydown);
  document.getElementById("terminationContractResults").addEventListener("click", handleTerminationContractResultClick);
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
  document.getElementById("executiveReportButton").addEventListener("click", printExecutivePortfolioReport);
  document.getElementById("presentationModeButton").addEventListener("click", togglePresentationMode);
  document.getElementById("presentationExitButton").addEventListener("click", togglePresentationMode);
  document.getElementById("executivePanel").addEventListener("click", handleExecutiveMetricAction);
  document.getElementById("newTerminationButton").addEventListener("click", openTerminationFromHub);
  document.getElementById("formalTerminationReportButton").addEventListener("click", () => printTerminationReport("formal"));
  document.getElementById("executiveTerminationReportButton").addEventListener("click", () => printTerminationReport("executive"));
  document.getElementById("clearTerminationFiltersButton").addEventListener("click", clearTerminationFilters);
  ["terminationSearch", "terminationReasonFilter", "terminationApproachFilter", "terminationOriginFilter", "terminationStartDate", "terminationEndDate"]
    .forEach((id) => document.getElementById(id).addEventListener("input", () => {
      renderTerminatedTable();
      updateFilterDock();
    }));
  document.getElementById("changeUserButton").addEventListener("click", changeUser);
  document.getElementById("editProfileButton").addEventListener("click", openProfileDialog);
  document.getElementById("profileForm").addEventListener("submit", saveProfile);
  document.getElementById("cancelProfileButton").addEventListener("click", closeProfileDialog);
  document.getElementById("profileAvatarInput").addEventListener("change", handleProfileAvatar);
  document.getElementById("closeAnnotationMenuButton").addEventListener("click", closeAnnotationMenu);
  document.getElementById("cancelAnnotationButton").addEventListener("click", syncAnnotationMenu);
  document.getElementById("saveAnnotationButton").addEventListener("click", saveAnnotation);
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("installAppButton").addEventListener("click", installProgressiveWebApp);
  document.querySelector("#executiveAnalytics > summary").addEventListener("click", () => {
    document.getElementById("executiveAnalytics").dataset.userToggled = "true";
  });
  document.addEventListener("pointerdown", handleContractSearchOutsideClick);
  document.addEventListener("pointerdown", handleAnnotationOutsideClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAnnotationMenu();
  });
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
  const activeIds = new Set(state.contracts.map((contract) => contract.contractId));
  const sourceTerminations = (await db.getSourceTerminations()).map(enrichContract);
  state.activeTerminationConflicts = sourceTerminations.filter((contract) => (
    activeIds.has(contract.contractId)
    || normalizeReportText(contract.sourceStatus) === "ativo"
  ));
  const conflictIds = new Set(state.activeTerminationConflicts.map((contract) => contract.contractId));
  state.historicalTerminated = sourceTerminations.filter((contract) => !conflictIds.has(contract.contractId));
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
  renderReversions();
  renderDataHealth();
  renderExecutive();
  updateFilterDock();
  renderActiveFilterChips();
  syncResponsiveExecutiveDisclosure();
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
  const previousTarget = document.body.dataset.activeTab || "operational";
  closeFilterPanel(false);
  document.querySelectorAll(".nav-tab").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === target));
  document.getElementById("operationalPanel").classList.toggle("active", target === "operational");
  document.getElementById("terminationsPanel").classList.toggle("active", target === "terminations");
  document.getElementById("reversionsPanel").classList.toggle("active", target === "reversions");
  document.getElementById("healthPanel").classList.toggle("active", target === "health");
  document.getElementById("executivePanel").classList.toggle("active", target === "executive");
  document.body.dataset.activeTab = target;
  if (previousTarget !== target) window.scrollTo({ top: 0, behavior: "auto" });
  syncTopbar(target);
  updateFilterDock();
  renderActiveFilterChips();
  if (target !== "executive" && state.presentationMode) togglePresentationMode(false);
  if (target === "executive") {
    setTimeout(() => {
      renderExecutive();
      syncResponsiveExecutiveDisclosure();
    }, 80);
  }
}

const TOPBAR_CONTENT = {
  operational: {
    eyebrow: "Operação da carteira",
    title: "Operacionalização",
    description: "Priorize contratos, registre contexto e acompanhe a exposição financeira.",
  },
  terminations: {
    eyebrow: "Controle auditado",
    title: "Central de distratos",
    description: "Registre encerramentos, retenções e reembolsos com rastreabilidade.",
  },
  reversions: {
    eyebrow: "Histórico contratual",
    title: "Reversões",
    description: "Consulte vínculos entre contratos antigos e a carteira ativa.",
  },
  health: {
    eyebrow: "Governança da informação",
    title: "Alertas de dados",
    description: "Identifique inconsistências antes que elas afetem indicadores e decisões.",
  },
  executive: {
    eyebrow: "Visão estratégica",
    title: "Painel da Inadimplência",
    description: "Risco, exposição e prioridades da carteira em uma leitura objetiva.",
  },
};

function syncTopbar(target) {
  const content = TOPBAR_CONTENT[target] || TOPBAR_CONTENT.operational;
  document.getElementById("topbarEyebrow").textContent = content.eyebrow;
  document.getElementById("topbarTitle").textContent = content.title;
  document.getElementById("topbarDescription").textContent = content.description;
  document.querySelectorAll(".contextual-action").forEach((element) => {
    element.hidden = !String(element.dataset.tabs || "").split(" ").includes(target);
  });
}

function readNavigationPreference() {
  try {
    const stored = localStorage.getItem(NAVIGATION_STORAGE_KEY);
    if (stored === null) return window.matchMedia("(max-width: 980px)").matches;
    return stored === "true";
  } catch {
    return window.matchMedia("(max-width: 980px)").matches;
  }
}

function setNavigationCollapsed(collapsed, persist = false) {
  state.navigationCollapsed = Boolean(collapsed);
  syncNavigationState(state.navigationCollapsed);
  if (!persist) return;
  try {
    localStorage.setItem(NAVIGATION_STORAGE_KEY, String(state.navigationCollapsed));
  } catch {
    // A navegação continua funcional quando o navegador bloqueia o armazenamento local.
  }
}

function syncNavigationState(collapsed) {
  document.body.classList.toggle("navigation-collapsed", collapsed);
  const toggle = document.getElementById("navigationToggle");
  if (!toggle) return;
  const mobile = window.matchMedia("(max-width: 980px)").matches;
  const label = collapsed
    ? "Abrir menu de navegação"
    : mobile
      ? "Recolher menu para cima"
      : "Recolher menu para a lateral";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

const FILTER_TAB_CONFIG = {
  operational: { panelId: "globalFilterPanel", label: "filtros da carteira" },
  executive: { panelId: "globalFilterPanel", label: "filtros da carteira" },
  terminations: { panelId: "terminationFilterPanel", label: "filtros de distratos" },
};

function activeFilterConfig() {
  return FILTER_TAB_CONFIG[document.body.dataset.activeTab || "operational"] || null;
}

function toggleFilterPanel() {
  const button = document.getElementById("filterToggleButton");
  if (button.getAttribute("aria-expanded") === "true") {
    closeFilterPanel();
    return;
  }
  const config = activeFilterConfig();
  if (!config) return;
  closeFilterPanel(false);
  const panel = document.getElementById(config.panelId);
  panel.hidden = false;
  panel.classList.add("is-open");
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", config.panelId);
  button.setAttribute("aria-label", `Fechar ${config.label}`);
  document.body.classList.add("filter-panel-open");
  panel.querySelector("input, select, button")?.focus({ preventScroll: true });
}

function closeFilterPanel(restoreFocus = true) {
  document.querySelectorAll(".filter-popover").forEach((panel) => {
    panel.classList.remove("is-open");
    panel.hidden = true;
  });
  const button = document.getElementById("filterToggleButton");
  if (!button) return;
  const wasOpen = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", "false");
  document.body.classList.remove("filter-panel-open");
  const config = activeFilterConfig();
  button.setAttribute("aria-label", config ? `Abrir ${config.label}` : "Abrir filtros");
  if (restoreFocus && wasOpen && !button.hidden) button.focus({ preventScroll: true });
}

function handleFilterPanelOutsideClick(event) {
  const button = document.getElementById("filterToggleButton");
  if (button.getAttribute("aria-expanded") !== "true") return;
  const panel = document.querySelector(".filter-popover.is-open");
  if (panel?.contains(event.target) || button.contains(event.target)) return;
  closeFilterPanel(false);
}

function handleFilterPanelKeydown(event) {
  if (event.key === "Escape" && document.getElementById("filterToggleButton").getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    closeFilterPanel();
  }
}

function updateFilterDock() {
  const config = activeFilterConfig();
  const button = document.getElementById("filterToggleButton");
  if (!button) return;
  button.hidden = !config;
  document.body.classList.toggle("filter-dock-active", Boolean(config));
  if (!config) {
    closeFilterPanel(false);
    return;
  }
  button.setAttribute("aria-controls", config.panelId);
  button.setAttribute("aria-label", `${button.getAttribute("aria-expanded") === "true" ? "Fechar" : "Abrir"} ${config.label}`);
  const count = config.panelId === "terminationFilterPanel" ? activeTerminationFilterCount() : activePortfolioFilterCount();
  const badge = document.getElementById("filterActiveCount");
  badge.textContent = String(count);
  badge.hidden = count === 0;
  button.classList.toggle("has-active-filters", count > 0);
  renderActiveFilterChips();
}

function renderActiveFilterChips() {
  const host = document.getElementById("activeFilterChips");
  const config = activeFilterConfig();
  if (!config) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }

  const filters = config.panelId === "terminationFilterPanel"
    ? terminationFilterDescriptors()
    : portfolioFilterDescriptors();
  host.hidden = filters.length === 0;
  host.innerHTML = filters.map((filter) => `
    <button type="button" class="filter-chip" data-filter-id="${escapeAttr(filter.id)}" aria-label="Remover filtro ${escapeAttr(filter.label)}">
      <span>${escapeHtml(filter.label)}</span>
      <span aria-hidden="true">×</span>
    </button>
  `).join("");
  host.querySelectorAll("[data-filter-id]").forEach((button) => {
    button.addEventListener("click", () => clearSingleFilter(button.dataset.filterId));
  });
}

function portfolioFilterDescriptors() {
  const descriptors = [];
  const search = document.getElementById("globalSearch").value.trim();
  if (search) descriptors.push({ id: "globalSearch", label: `Busca: ${search}` });
  [
    ["categoryFilter", "Categoria"],
    ["groupFilter", "Grupo"],
    ["statusFilter", "Status"],
    ["agingFilter", "Atraso"],
    ["valueFilter", "Valor"],
  ].forEach(([id, label]) => {
    const element = document.getElementById(id);
    if (element.value !== "all") descriptors.push({ id, label: `${label}: ${selectedOptionLabel(element)}` });
  });
  return descriptors;
}

function terminationFilterDescriptors() {
  const descriptors = [];
  const search = document.getElementById("terminationSearch").value.trim();
  if (search) descriptors.push({ id: "terminationSearch", label: `Busca: ${search}` });
  [
    ["terminationReasonFilter", "Motivo"],
    ["terminationApproachFilter", "Abordagem"],
    ["terminationOriginFilter", "Origem"],
  ].forEach(([id, label]) => {
    const element = document.getElementById(id);
    if (element.value !== "all") descriptors.push({ id, label: `${label}: ${selectedOptionLabel(element)}` });
  });
  const start = document.getElementById("terminationStartDate").value;
  const end = document.getElementById("terminationEndDate").value;
  if (start) descriptors.push({ id: "terminationStartDate", label: `Desde: ${formatDate(start)}` });
  if (end) descriptors.push({ id: "terminationEndDate", label: `Até: ${formatDate(end)}` });
  return descriptors;
}

function clearSingleFilter(id) {
  const element = document.getElementById(id);
  if (!element) return;
  element.value = element.tagName === "SELECT" ? "all" : "";
  state.page = 1;
  if (id.startsWith("termination")) {
    renderTerminatedTable();
    updateFilterDock();
    return;
  }
  renderAll();
}

function activePortfolioFilterCount() {
  return [
    document.getElementById("globalSearch").value.trim(),
    ...["categoryFilter", "groupFilter", "statusFilter", "agingFilter", "valueFilter"]
      .map((id) => document.getElementById(id).value === "all" ? "" : document.getElementById(id).value),
  ].filter(Boolean).length;
}

function activeTerminationFilterCount() {
  return [
    document.getElementById("terminationSearch").value.trim(),
    document.getElementById("terminationReasonFilter").value === "all" ? "" : document.getElementById("terminationReasonFilter").value,
    document.getElementById("terminationApproachFilter").value === "all" ? "" : document.getElementById("terminationApproachFilter").value,
    document.getElementById("terminationOriginFilter").value === "all" ? "" : document.getElementById("terminationOriginFilter").value,
    document.getElementById("terminationStartDate").value,
    document.getElementById("terminationEndDate").value,
  ].filter(Boolean).length;
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
    metric("Contratos Ativos", kpis.totalActive, "Carteira filtrada", "brand", "", "operational-primary-kpi"),
    metric("Inadimplentes", kpis.totalDefaulted, formatPercent(kpis.totalActive ? kpis.totalDefaulted / kpis.totalActive : 0), "danger", "", "operational-primary-kpi"),
    metric("Aging 90+ Dias", kpis.aging90Plus, "Prioridade alta", "warning", "", "operational-primary-kpi"),
    metric("Aging 180+ Dias", kpis.aging180Plus, "Risco crítico", "danger", "", "operational-primary-kpi"),
    metric("Aging Médio", `${Math.round(kpis.averageAging)} dias`, "Pela data próximo vencimento", "brand", "", "operational-primary-kpi"),
    metric("Potencial Recuperável", formatCurrency(kpis.recoverableValue), "Integralizado dos inadimplentes", "navy", "", "operational-primary-kpi"),
  ].join("");
  document.getElementById("operationalKpis").classList.add("show-all");
  const toggle = document.getElementById("operationalKpiToggle");
  toggle.hidden = true;
  toggle.setAttribute("aria-expanded", "true");
}

function renderExecutive() {
  const active = getActiveContracts(state.filtered);
  const defaultTerminations = getProductionTerminations();
  const kpis = calculateKpis(active, defaultTerminations);
  const percentageBasisIsReceivable = state.riskPercentageBasis === "receivable";
  const overdueRate = percentageBasisIsReceivable ? kpis.overdueRateReceivable : kpis.defaultRate;
  const defaultedRate = percentageBasisIsReceivable ? kpis.defaultedRateReceivable : kpis.defaultedRatePortfolio;
  const percentageBasisLabel = percentageBasisIsReceivable ? "saldo a receber" : "carteira total";
  const alternatePercentageBasisLabel = percentageBasisIsReceivable ? "carteira total" : "saldo a receber";
  const conservativeRecovery = state.recoverableScenario === "conservative";
  const displayedRecoverable = conservativeRecovery ? kpis.recoverableValue * 0.5 : kpis.recoverableValue;
  const categoryRisk = groupByCategory(active, "overdueValue").sort((a, b) => b.value - a.value)[0];
  const categoryConcentration = categoryRisk && kpis.totalOverdue ? categoryRisk.value / kpis.totalOverdue : 0;
  const topDefaulted = getTopDefaulted(active, 1)[0];
  const healthAlerts = buildDataHealthAlerts();
  const criticalHealthAlerts = healthAlerts.filter((alert) => alert.level === "critical").length;
  document.getElementById("dashboardDate").textContent = `Atualizado em ${formatDate(new Date().toISOString())}`;
  document.getElementById("executivePrimaryKpis").innerHTML = [
    metric("Contratos Ativos", kpis.totalActive, "Carteira filtrada", "brand"),
    metric("Adimplentes", kpis.totalCurrent, "Inclui quitados", "success"),
    metric("Em Atraso", kpis.totalLate, "Até 89 dias", "warning"),
    metric("Inadimplentes", kpis.totalDefaulted, "90+ dias", "danger"),
  ].join("");
  document.getElementById("executivePortfolioKpis").innerHTML = [
    metric("Carteira Total", formatCurrency(kpis.totalPortfolio), "Valor total atualizado", "brand"),
    metric("Carteira Integralizada", formatCurrency(kpis.totalIntegralized), "Valor já pago pelos clientes", "success"),
    metric("Saldo a Receber", formatCurrency(kpis.totalReceivable), "Valor ainda previsto para recebimento", "navy"),
  ].join("");
  document.getElementById("executiveRiskKpis").innerHTML = [
    metric("Valor em Atraso", formatCurrency(kpis.totalOverdue), "Todos os contratos com atraso", "warning"),
    metric("Valor Inadimplente 90+", formatCurrency(kpis.totalDefaultedOverdue), "Somente contratos com 90+ dias", "danger"),
    metricToggle(
      "% Em Atraso",
      formatPercent(overdueRate),
      `Sobre ${percentageBasisLabel} · clique para ${alternatePercentageBasisLabel}`,
      "warning",
      "risk-percentage-basis",
      !percentageBasisIsReceivable,
    ),
    metricToggle(
      "% Inadimplência 90+",
      formatPercent(defaultedRate),
      `Sobre ${percentageBasisLabel} · clique para ${alternatePercentageBasisLabel}`,
      "danger",
      "risk-percentage-basis",
      !percentageBasisIsReceivable,
    ),
    metric("Aging Médio", `${Math.round(kpis.averageAging)} dias`, `${kpis.aging90Plus} contratos 90+ dias`, "brand"),
    metric("Aging 180+", `${kpis.aging180Plus} contratos`, "Faixa de maior criticidade", "danger"),
  ].join("");
  document.getElementById("executiveRecoveryKpis").innerHTML = [
    metric("Distratos por Inadimplência", kpis.totalTerminated, `Usuário: ${state.currentUser}`, "closed", "terminatedMetricCard"),
    metric("Recuperado", formatCurrency(kpis.retainedTotal), "Valor efetivamente retido", "cyan"),
    metricToggle(
      conservativeRecovery ? "Cenário Conservador 50%" : "Potencial Recuperável",
      formatCurrency(displayedRecoverable),
      conservativeRecovery ? "Metade do potencial · clique para valor total" : "Integralizado dos inadimplentes · clique para cenário 50%",
      "navy",
      "recoverable-scenario",
      conservativeRecovery,
    ),
    metric("% Distratos", formatPercent(kpis.terminationRate), "Distratos por inadimplência", "closed"),
  ].join("");
  document.getElementById("executiveComplementaryKpis").innerHTML = [
    metric("Ticket Médio", formatCurrency(kpis.averageTicket), "Contratos ativos", "brand"),
    metric("Faixa Crítica", `${kpis.aging180Plus} contratos`, "Mais de 180 dias", "danger"),
    metric("Concentração por Categoria", formatPercent(categoryConcentration), categoryRisk?.label || "Sem exposição", "warning"),
    metric("Top Inadimplentes", formatCurrency(topDefaulted?.overdueValue || 0), "Maior exposição individual 90+", "danger"),
    metricToggle(
      "Alertas de Dados",
      healthAlerts.length,
      criticalHealthAlerts ? `${criticalHealthAlerts} críticos · abrir detalhes` : "Abrir saúde dos dados",
      criticalHealthAlerts ? "danger" : healthAlerts.length ? "warning" : "success",
      "open-data-health",
      false,
    ),
  ].join("");
  bindTerminatedMetricHover();
  renderExecutiveBrief(active, kpis);
  renderCharts(active, defaultTerminations, {
    onCategorySelect: (category) => applyDashboardDrilldown("categoryFilter", category),
    onAgingSelect: (aging) => applyDashboardDrilldown("agingFilter", aging),
  });
  renderHeatmap(active);
  renderRanking(active);
  renderInsights(active, defaultTerminations);
}

function metric(label, value, helper, tone = "", id = "", className = "") {
  const toneClass = tone ? ` metric-card-${tone}` : "";
  const extraClass = className ? ` ${className}` : "";
  const idAttribute = id ? ` id="${id}" tabindex="0"` : "";
  return `<article class="metric-card${toneClass}${extraClass}"${idAttribute}><span>${label}</span><strong>${value}</strong><small>${helper}</small></article>`;
}

function metricToggle(label, value, helper, tone, action, pressed = false) {
  const toneClass = tone ? ` metric-card-${tone}` : "";
  return `
    <button
      class="metric-card metric-card-toggle${toneClass}"
      type="button"
      data-metric-action="${action}"
      aria-pressed="${pressed}"
      aria-label="${escapeAttr(`${label}. ${value}. ${helper}`)}"
    >
      <span>${label}</span>
      <strong>${value}</strong>
      <small>${helper}</small>
      <i aria-hidden="true">↔</i>
    </button>
  `;
}

function handleExecutiveMetricAction(event) {
  const trigger = event.target.closest("[data-metric-action]");
  if (!trigger) return;
  const action = trigger.dataset.metricAction;
  if (action === "risk-percentage-basis") {
    state.riskPercentageBasis = state.riskPercentageBasis === "receivable" ? "portfolio" : "receivable";
    renderExecutive();
    return;
  }
  if (action === "recoverable-scenario") {
    state.recoverableScenario = state.recoverableScenario === "full" ? "conservative" : "full";
    renderExecutive();
    return;
  }
  if (action === "open-data-health") {
    switchTab("health");
  }
}

function toggleOperationalKpis() {
  state.operationalKpisExpanded = !state.operationalKpisExpanded;
  renderOperationalKpis();
}

function openPriorityQueue() {
  document.getElementById("statusFilter").value = STATUS.DEFAULTED;
  document.getElementById("agingFilter").value = "180+";
  state.sortKey = "overdueValue";
  state.sortDirection = "desc";
  state.page = 1;
  renderAll();
  document.querySelector(".table-shell")?.scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Fila crítica aberta: inadimplentes com mais de 180 dias, priorizados por valor.");
}

function renderExecutiveBrief(contracts, kpis) {
  const categoryRisk = groupByCategory(contracts, "overdueValue").sort((a, b) => b.value - a.value)[0];
  const riskLevel = kpis.aging180Plus >= 40 || kpis.defaultedRateReceivable >= 0.05
    ? "Crítico"
    : kpis.aging90Plus >= 20 || kpis.defaultedRateReceivable >= 0.025
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
      <span>Faixa Crítica</span>
      <strong>${kpis.aging180Plus} contratos</strong>
      <small>Com mais de 180 dias desde o próximo vencimento.</small>
    </article>
    <article class="brief-item">
      <span>Maior Concentração</span>
      <strong>${escapeHtml(categoryRisk?.label || "Sem exposição")}</strong>
      <small>${formatPercent(concentration)} do valor total em atraso.</small>
    </article>
    <article class="brief-item">
      <span>Prioridade Financeira</span>
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
  document.getElementById("contractsMobileList").innerHTML = rows.map(renderMobileContractCard).join("")
    || '<div class="mobile-empty-state">Nenhum contrato encontrado.</div>';
  document.getElementById("selectAllRows").checked = rows.length > 0 && rows.every((row) => state.selected.has(row.contractId));
  bindTableRows();
  bindMobileContractCards();
  renderSelectionBar();
}

function renderContractRow(contract) {
  const checked = state.selected.has(contract.contractId) ? "checked" : "";
  const writeDisabled = state.canWrite ? "" : "disabled";
  return `
    <tr data-contract-id="${escapeAttr(contract.contractId)}" class="${state.selected.has(contract.contractId) ? "is-selected" : ""}">
      <td><input type="checkbox" class="row-check" ${checked} ${writeDisabled}></td>
      <td><strong>${escapeHtml(contractDisplayCode(contract))}</strong></td>
      <td><span class="contract-localizer">${escapeHtml(contractLocalizer(contract))}</span></td>
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
      <td class="operational-row-actions">
        <div class="operational-action-group">
          ${state.canWrite ? '<button class="danger-button compact terminate-row-button" type="button">Distratar</button>' : ""}
          ${contract.notes ? '<button class="annotation-marker" type="button" aria-label="Exibir anotação" title="Exibir anotação"><span aria-hidden="true">●</span></button>' : ""}
        </div>
      </td>
    </tr>
  `;
}

function renderMobileContractCard(contract) {
  const checked = state.selected.has(contract.contractId) ? "checked" : "";
  const writeDisabled = state.canWrite ? "" : "disabled";
  return `
    <article class="mobile-contract-card ${state.selected.has(contract.contractId) ? "is-selected" : ""}" data-contract-id="${escapeAttr(contract.contractId)}">
      <div class="mobile-contract-card-head">
        <label class="mobile-contract-select">
          <input type="checkbox" class="mobile-row-check" ${checked} ${writeDisabled} aria-label="Selecionar contrato ${escapeAttr(contractDisplayCode(contract))}">
        </label>
        <button class="mobile-contract-summary" type="button" aria-expanded="false">
          <span>
            <strong>${escapeHtml(contract.primaryClient || "Cliente não informado")}</strong>
            <small>Contrato ${escapeHtml(contractDisplayCode(contract))} · Localizador ${escapeHtml(contractLocalizer(contract))}</small>
          </span>
          <span class="mobile-contract-risk">
            <strong>${formatCurrency(contract.overdueValue)}</strong>
            <small>${contract.daysOverdue} dias</small>
          </span>
        </button>
      </div>
      <div class="mobile-contract-details" hidden>
        <dl>
          <div><dt>Status</dt><dd><span class="status-badge status-${escapeAttr(slugStatus(contract.appStatus))}">${escapeHtml(contract.appStatus)}</span></dd></div>
          <div><dt>Grupo</dt><dd>${escapeHtml(contract.product)}</dd></div>
          <div><dt>Localizador</dt><dd>${escapeHtml(contractLocalizer(contract))}</dd></div>
          <div><dt>Integralizado</dt><dd>${formatCurrency(contract.effectivePaidValue)}</dd></div>
          <div><dt>Documento</dt><dd>${escapeHtml(contract.primaryDocument || "-")}</dd></div>
        </dl>
        <div class="mobile-contract-actions">
          ${state.canWrite ? '<button class="annotation-mobile-button secondary-button" type="button">Anotação</button>' : ""}
          ${state.canWrite ? '<button class="danger-button mobile-terminate-button" type="button">Distratar contrato</button>' : ""}
          ${contract.notes ? '<button class="annotation-marker" type="button" aria-label="Exibir anotação" title="Exibir anotação"><span aria-hidden="true">●</span></button>' : ""}
        </div>
      </div>
    </article>
  `;
}

function bindTableRows() {
  document.querySelectorAll("#contractsTableBody tr[data-contract-id]").forEach((row) => {
    const contract = state.contracts.find((item) => item.contractId === row.dataset.contractId);
    row.querySelector(".row-check").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(contract.contractId);
      else state.selected.delete(contract.contractId);
      row.classList.toggle("is-selected", event.target.checked);
      syncSelectionInputs(contract.contractId);
      renderSelectionBar();
    });
    const terminateButton = row.querySelector(".terminate-row-button");
    terminateButton?.addEventListener("click", () => {
      state.pendingTermination = [contract];
      state.terminationTrigger = terminateButton;
      openTerminateDialog();
    });
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, input, a, select, textarea")) return;
      event.stopPropagation();
      selectContractForAnnotation(contract, row);
    });
    const clientTrigger = row.querySelector(".client-hover-trigger");
    clientTrigger.addEventListener("mouseenter", () => showContractHoverCard(contract, clientTrigger));
    clientTrigger.addEventListener("mousemove", () => positionContractHoverCard(clientTrigger));
    clientTrigger.addEventListener("mouseleave", hideContractHoverCard);
    clientTrigger.addEventListener("focus", () => showContractHoverCard(contract, clientTrigger));
    clientTrigger.addEventListener("blur", hideContractHoverCard);
    row.querySelector(".annotation-marker")?.addEventListener("click", (event) => {
      event.stopPropagation();
      selectContractForAnnotation(contract, event.currentTarget);
    });
  });
}

function bindMobileContractCards() {
  document.querySelectorAll(".mobile-contract-card[data-contract-id]").forEach((card) => {
    const contract = state.contracts.find((item) => item.contractId === card.dataset.contractId);
    const summary = card.querySelector(".mobile-contract-summary");
    const details = card.querySelector(".mobile-contract-details");
    summary.addEventListener("click", () => {
      const expanded = summary.getAttribute("aria-expanded") === "true";
      summary.setAttribute("aria-expanded", String(!expanded));
      details.hidden = expanded;
    });
    card.querySelector(".mobile-row-check").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(contract.contractId);
      else state.selected.delete(contract.contractId);
      card.classList.toggle("is-selected", event.target.checked);
      syncSelectionInputs(contract.contractId);
      renderSelectionBar();
    });
    card.querySelector(".mobile-terminate-button")?.addEventListener("click", () => {
      state.pendingTermination = [contract];
      state.terminationTrigger = card.querySelector(".mobile-terminate-button");
      openTerminateDialog();
    });
    card.querySelector(".annotation-mobile-button")?.addEventListener("click", (event) => {
      selectContractForAnnotation(contract, event.currentTarget);
    });
    card.querySelector(".annotation-marker")?.addEventListener("click", (event) => {
      selectContractForAnnotation(contract, event.currentTarget);
    });
  });
}

async function handleNotesChange(contract, notes, statusElement = null) {
  if (!state.canWrite) return false;
  setNoteStatus(statusElement, "Salvando...");
  try {
    await distratos.updateNotes(contract, notes, state.currentUser);
    contract.notes = notes;
    const stored = state.contracts.find((item) => item.contractId === contract.contractId);
    if (stored) stored.notes = notes;
    setNoteStatus(statusElement, "Salvo", "success");
    return true;
  } catch (error) {
    setNoteStatus(statusElement, "Falha ao salvar", "error");
    toast(`Não foi possível salvar a observação: ${error.message}`);
    return false;
  }
}

function selectContractForAnnotation(contract, trigger) {
  document.querySelectorAll(".is-annotating").forEach((element) => element.classList.remove("is-annotating"));
  document.querySelectorAll(`[data-contract-id="${CSS.escape(contract.contractId)}"]`)
    .forEach((element) => element.classList.add("is-annotating"));
  state.annotationContract = contract;
  syncAnnotationMenu();
  positionAnnotationMenu(trigger);
}

function syncAnnotationMenu() {
  const menu = document.getElementById("annotationActionMenu");
  const contract = state.annotationContract;
  if (!contract) {
    menu.hidden = true;
    return;
  }
  document.getElementById("annotationMenuClient").textContent = contract.primaryClient || "Cliente não informado";
  document.getElementById("annotationMenuContract").textContent = `Contrato ${contractDisplayCode(contract)} · Localizador ${contractLocalizer(contract)}`;
  const preview = document.getElementById("annotationMenuPreview");
  preview.textContent = contract.notes || "Este contrato ainda não possui anotação.";
  preview.classList.toggle("is-empty", !contract.notes);
  document.getElementById("annotationEditor").hidden = true;
  const actions = document.getElementById("annotationMenuActions");
  actions.innerHTML = contract.notes
    ? `
      <button class="secondary-button compact annotation-edit-button" type="button">Alterar Anotação</button>
      <button class="ghost-button compact annotation-remove-button" type="button">Remover Anotação</button>
    `
    : '<button class="primary-button compact annotation-add-button" type="button">Adicionar Anotação</button>';
  actions.querySelector(".annotation-add-button, .annotation-edit-button")?.addEventListener("click", openAnnotationEditor);
  actions.querySelector(".annotation-remove-button")?.addEventListener("click", removeAnnotation);
  menu.hidden = false;
}

function openAnnotationEditor() {
  const contract = state.annotationContract;
  if (!contract) return;
  document.getElementById("annotationText").value = contract.notes || "";
  document.getElementById("annotationEditor").hidden = false;
  document.getElementById("annotationMenuActions").innerHTML = "";
  document.getElementById("annotationText").focus();
}

async function saveAnnotation() {
  const contract = state.annotationContract;
  if (!contract) return;
  const notes = document.getElementById("annotationText").value.trim();
  const saved = await handleNotesChange(contract, notes);
  if (!saved) return;
  toast(notes ? "Anotação salva." : "Anotação removida.");
  closeAnnotationMenu();
  renderTable();
}

async function removeAnnotation() {
  const contract = state.annotationContract;
  if (!contract || !window.confirm("Remover a anotação deste contrato?")) return;
  const saved = await handleNotesChange(contract, "");
  if (!saved) return;
  toast("Anotação removida.");
  closeAnnotationMenu();
  renderTable();
}

function closeAnnotationMenu() {
  document.getElementById("annotationActionMenu").hidden = true;
  document.querySelectorAll(".is-annotating").forEach((element) => element.classList.remove("is-annotating"));
  state.annotationContract = null;
}

function positionAnnotationMenu(trigger) {
  const menu = document.getElementById("annotationActionMenu");
  if (!trigger || menu.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 12;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - width - margin);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) top = rect.top - height - 8;
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function handleAnnotationOutsideClick(event) {
  const menu = document.getElementById("annotationActionMenu");
  if (menu.hidden || menu.contains(event.target) || event.target.closest(".annotation-marker, .annotation-mobile-button")) return;
  closeAnnotationMenu();
}

function setNoteStatus(element, message, tone = "") {
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
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

function renderSelectionBar() {
  const bar = document.getElementById("bulkSelectionBar");
  const count = state.selected.size;
  bar.hidden = count === 0 || !state.canWrite;
  document.getElementById("bulkSelectionCount").textContent = `${count} ${count === 1 ? "contrato selecionado" : "contratos selecionados"}`;
}

function clearSelection() {
  state.selected.clear();
  renderTable();
}

function syncSelectionInputs(contractId) {
  const selected = state.selected.has(contractId);
  document.querySelectorAll(`[data-contract-id="${CSS.escape(contractId)}"] .row-check, [data-contract-id="${CSS.escape(contractId)}"] .mobile-row-check`)
    .forEach((input) => {
      input.checked = selected;
    });
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
  const contractSearch = document.getElementById("terminationContractSearch");
  contractField.hidden = !selectContract;
  contractSelect.innerHTML = [
    '<option value="">Selecione um contrato ativo</option>',
    ...state.contracts
      .slice()
      .sort((a, b) => String(a.primaryClient).localeCompare(String(b.primaryClient), "pt-BR"))
      .map((contract) => `<option value="${escapeAttr(contract.contractId)}">${escapeHtml(contract.primaryClient)} · ${escapeHtml(contractDisplayCode(contract))}</option>`),
  ].join("");
  contractSelect.value = "";
  contractSearch.value = "";
  document.getElementById("terminationContractResults").hidden = true;

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
  if (selectContract) {
    renderTerminationContractResults();
    setTimeout(() => contractSearch.focus(), 0);
  }
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
  document.getElementById("terminationContractResults").hidden = true;
  document.getElementById("terminationContractSearch").value = "";
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

function renderTerminationContractResults() {
  const field = document.getElementById("terminationContractField");
  const host = document.getElementById("terminationContractResults");
  if (field.hidden) {
    host.hidden = true;
    return;
  }
  const query = normalizeSearchValue(document.getElementById("terminationContractSearch").value);
  const matches = state.contracts
    .filter((contract) => !query || normalizeSearchValue([
      contract.primaryClient,
      contract.contractCode,
      contract.localizer,
      contract.contractId,
      contract.sourceNumber,
      contract.primaryDocument,
      contract.primaryPhone,
      contract.product,
    ].join(" ")).includes(query))
    .sort((a, b) => {
      if (query) {
        const aStarts = normalizeSearchValue(`${a.primaryClient} ${contractDisplayCode(a)} ${contractLocalizer(a)}`).startsWith(query) ? 1 : 0;
        const bStarts = normalizeSearchValue(`${b.primaryClient} ${contractDisplayCode(b)} ${contractLocalizer(b)}`).startsWith(query) ? 1 : 0;
        if (aStarts !== bStarts) return bStarts - aStarts;
      }
      return toNumber(b.overdueValue) - toNumber(a.overdueValue);
    })
    .slice(0, 8);

  host.innerHTML = matches.map((contract, index) => `
    <button type="button" role="option" data-contract-result="${escapeAttr(contract.contractId)}" aria-selected="false">
      <span>
        <strong>${escapeHtml(contract.primaryClient || "Cliente não informado")}</strong>
        <small>${escapeHtml(contractDisplayCode(contract))} · Localizador ${escapeHtml(contractLocalizer(contract))}</small>
      </span>
      <span>
        <strong>${formatCurrency(contract.overdueValue)}</strong>
        <small>${contract.daysOverdue} dias</small>
      </span>
      ${index === 0 ? '<span class="sr-only">Primeiro resultado</span>' : ""}
    </button>
  `).join("") || '<p class="contract-search-empty">Nenhum contrato encontrado.</p>';
  host.hidden = false;
}

function handleTerminationContractResultClick(event) {
  const button = event.target.closest("[data-contract-result]");
  if (!button) return;
  selectTerminationContract(button.dataset.contractResult);
}

function selectTerminationContract(contractId) {
  const contract = state.contracts.find((item) => item.contractId === contractId);
  if (!contract) return;
  const select = document.getElementById("terminationContractSelect");
  select.value = contractId;
  document.getElementById("terminationContractSearch").value = `${contract.primaryClient} · ${contractDisplayCode(contract)}`;
  document.getElementById("terminationContractResults").hidden = true;
  handleTerminationContractSelection({ target: select });
}

function handleTerminationContractSearchKeydown(event) {
  const host = document.getElementById("terminationContractResults");
  if (event.key === "Escape") {
    host.hidden = true;
    return;
  }
  if (event.key !== "Enter") return;
  const firstResult = host.querySelector("[data-contract-result]");
  if (!firstResult) return;
  event.preventDefault();
  selectTerminationContract(firstResult.dataset.contractResult);
}

function handleContractSearchOutsideClick(event) {
  const field = document.getElementById("terminationContractField");
  if (field.hidden || field.contains(event.target)) return;
  document.getElementById("terminationContractResults").hidden = true;
}

function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function contractLocalizer(contract) {
  return String(contract?.localizer || contract?.contractId || "-");
}

function contractDisplayCode(contract) {
  const directCode = String(contract?.contractCode || "").trim();
  if (directCode) return directCode;
  const localizer = contractLocalizer(contract);
  const sourceMatch = [
    ...state.historicalTerminated,
    ...state.reversions,
    ...state.sourceExceptions,
    ...state.contracts,
  ].find((item) => contractLocalizer(item) === localizer && String(item.contractCode || "").trim());
  return String(sourceMatch?.contractCode || contract?.contractId || "-");
}

function linkedContractDisplayCode(localizer) {
  const linked = state.contracts.find((contract) => contractLocalizer(contract) === String(localizer || ""));
  return linked ? contractDisplayCode(linked) : String(localizer || "");
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
    <span>Contrato ${escapeHtml(contractDisplayCode(contract))} · Localizador ${escapeHtml(contractLocalizer(contract))}</span>
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
  const allTerminations = getUnifiedTerminations();
  const contracts = getFilteredTerminations();
  const totals = calculateTerminationTotals(contracts);
  document.getElementById("terminatedSummary").textContent = `${contracts.length} de ${allTerminations.length} registros`;
  document.getElementById("terminationKpis").innerHTML = [
    metric("Distratos", totals.count, "No período filtrado", "closed"),
    metric("Recuperado", formatCurrency(totals.retained), "Valor efetivamente retido", "success"),
    metric("Reembolsado", formatCurrency(totals.refunded), "Valor devolvido ao cliente", "warning"),
  ].join("");
  document.getElementById("terminationConsolidated").innerHTML = terminationConsolidatedMarkup(contracts);
  document.getElementById("terminatedTableBody").innerHTML = contracts.map((contract) => `
    <tr>
      <td><strong>${escapeHtml(contractDisplayCode(contract))}</strong><br><small>Localizador ${escapeHtml(contractLocalizer(contract))}</small></td>
      <td>${escapeHtml(contract.primaryClient || "-")}</td>
      <td>${formatCurrency(contract.effectivePaidValue)}</td>
      <td>${formatDate(contract.terminatedAt)}</td>
      <td><span class="status-badge ${contract.isDefaultTermination === false ? "termination-other" : "termination-default"}">${escapeHtml(contract.terminationReason || "Não informado")}</span></td>
      <td>${approachLabel(contract.terminationApproach)}</td>
      <td>${contract.hasRetention ? formatCurrency(contract.retainedValue) : "Não houve"}</td>
      <td>${contract.hasRefund ? formatCurrency(contract.refundValue) : "Não houve"}</td>
      <td>${escapeHtml(contract.terminatedBy || "-")}</td>
      <td><span class="reconciliation-badge reconciliation-${escapeAttr(contract.reconciliationStatus)}">${escapeHtml(reconciliationLabel(contract.reconciliationStatus))}</span></td>
      <td class="termination-row-actions">
        <div>
          ${canEditTermination(contract) ? `<button class="secondary-button compact edit-termination-button" type="button" data-id="${escapeAttr(contract.contractId)}">Editar</button>` : ""}
          ${state.canWrite && !contract.sourceOnlyTermination ? `<button class="ghost-button compact restore-button" type="button" data-id="${escapeAttr(contract.contractId)}">Restaurar</button>` : ""}
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
  const reasons = byUnique(getUnifiedTerminations().map((item) => item.terminationReason).filter(Boolean));
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
  const origin = document.getElementById("terminationOriginFilter").value;
  const start = document.getElementById("terminationStartDate").value;
  const end = document.getElementById("terminationEndDate").value;
  return getUnifiedTerminations()
    .filter((contract) => {
      const haystack = `${contract.primaryClient || ""} ${contractDisplayCode(contract)} ${contractLocalizer(contract)}`.toLowerCase();
      const date = String(contract.terminatedAt || "").slice(0, 10);
      if (query && !haystack.includes(query)) return false;
      if (reason !== "all" && contract.terminationReason !== reason) return false;
      if (approach !== "all" && (contract.terminationApproach || "nao_informada") !== approach) return false;
      if (origin !== "all" && contract.reconciliationStatus !== origin) return false;
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

function reconciliationLabel(value) {
  return {
    manual_pending: "Lançado no Pós-Venda VIP",
    source_confirmed: "Confirmado pela Atualização",
    source_identified: "Identificado na Atualização",
  }[value] || "Origem Não Informada";
}

function canEditTermination(contract) {
  if (!state.canWrite) return false;
  if (contract.sourceOnlyTermination) return false;
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
  document.getElementById("terminationOriginFilter").value = "all";
  renderTerminatedTable();
  updateFilterDock();
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
      <td><strong>${escapeHtml(contractDisplayCode(contract))}</strong><br><small>Localizador ${escapeHtml(contractLocalizer(contract))}</small></td>
      <td>${escapeHtml(contract.primaryClient || "-")}</td>
      <td>${escapeHtml(contract.originReversal || "-")}</td>
      <td>${escapeHtml(linkedContractDisplayCode(contract.linkedActiveContractId) || "Não localizado")}</td>
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
    state.contracts.length + state.historicalTerminated.length + state.reversions.length + state.sourceExceptions.length + state.activeTerminationConflicts.length,
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
  const activeTerminationConflicts = state.activeTerminationConflicts || [];
  const sourceContracts = [...state.contracts, ...state.historicalTerminated, ...state.reversions, ...state.sourceExceptions];
  const codeCounts = new Map();
  sourceContracts.forEach((contract) => {
    if (!contract.hasContractCodeSource) return;
    const code = String(contract.contractCode || "").trim();
    if (code) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
  });
  const duplicatedContractCodeRows = [...codeCounts.values()]
    .filter((count) => count > 1)
    .reduce((total, count) => total + count, 0);

  addHealthAlert(alerts, "critical", "Status incompatível na carteira ativa", notExplicitlyActive.length,
    "Existem contratos na área ativa sem status de origem igual a Ativo. Eles podem distorcer toda a carteira.",
    "Reaplique a base atual para concluir a segregação automática.");
  addHealthAlert(alerts, "critical", "Status de origem não reconhecido", state.sourceExceptions.length,
    "Esses registros foram preservados, mas ficaram fora dos indicadores porque não são Ativo, Cancelado ou Revertido.",
    "Confira os valores da coluna Status e informe novos padrões válidos para classificação.");
  addHealthAlert(alerts, "critical", "Distratos conflitantes com carteira ativa", activeTerminationConflicts.length,
    `Existem registros no histórico de distratos que também constam como ativos. O sistema bloqueou a exibição desses distratos. Exemplos: ${conflictExamples(activeTerminationConflicts)}.`,
    "Reaplique a base atual para limpar a origem e confira a coluna Status na base de contratos.");
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
  addHealthAlert(alerts, "warning", "Códigos de contrato duplicados", duplicatedContractCodeRows,
    "O CÓDIGO é exibido como número do contrato, mas aparece em mais de um registro da base. Os localizadores únicos impedem que os dados sejam misturados.",
    "Revise os códigos repetidos na origem e use o localizador para confirmar qual registro está sendo tratado.");
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

function conflictExamples(contracts) {
  return contracts.slice(0, 3)
    .map((contract) => `${contractDisplayCode(contract)} / Localizador ${contractLocalizer(contract)}`)
    .join(", ") || "não informado";
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
  const unified = getUnifiedTerminations();
  const confirmed = unified.filter((item) => item.reconciliationStatus === "source_confirmed").length;
  const identified = unified.filter((item) => item.reconciliationStatus === "source_identified").length;
  const pending = unified.filter((item) => item.reconciliationStatus === "manual_pending").length;
  card.innerHTML = `
    <div class="hover-card-header">
      <div>
        <strong>Resumo dos Distratos</strong>
        <span>Conciliação entre o Pós-Venda VIP e as bases atualizadas</span>
      </div>
    </div>
    <div class="hover-card-grid">
      ${hoverDetail("Distratos Inadimplência", production.length)}
      ${hoverDetail("Confirmados pela Atualização", confirmed)}
      ${hoverDetail("Identificados na Atualização", identified)}
      ${hoverDetail("Aguardando Confirmação", pending)}
      ${hoverDetail("Total Conciliado", unified.length)}
      ${hoverDetail("Recuperado", formatCurrency(production.reduce((total, item) => total + (item.hasRetention ? toNumber(item.retainedValue) : 0), 0)))}
    </div>
  `;
  card.hidden = false;
  positionContractHoverCard(trigger);
}

function getProductionTerminations() {
  const productionStart = new Date("2026-05-06T00:00:00");
  return state.terminated.filter((item) => {
    const date = new Date(item.terminatedAt);
    return item.isDefaultTermination !== false
      && !Number.isNaN(date.getTime())
      && date >= productionStart;
  });
}

function getUnifiedTerminations() {
  const manualIds = new Set(state.terminated.map((item) => item.contractId));
  const activeIds = new Set(state.contracts.map((item) => item.contractId));
  const manual = state.terminated.map((item) => ({
    ...item,
    reconciliationStatus: item.reconciliationStatus || "manual_pending",
    sourceOnlyTermination: false,
  }));
  const identified = state.historicalTerminated
    .filter((item) => !manualIds.has(item.contractId) && !activeIds.has(item.contractId) && normalizeReportText(item.sourceStatus) !== "ativo")
    .map((item) => {
      const reason = item.sourceTerminationReason || "Não informado";
      return enrichContract({
        ...item,
        terminatedAt: item.sourceTerminationDate || item.sourceUpdatedAt || null,
        terminationReason: reason,
        terminationObservation: "",
        terminationApproach: "nao_informada",
        isDefaultTermination: normalizeReportText(reason).includes("inadimpl"),
        hasRetention: false,
        retainedValue: 0,
        hasRefund: false,
        refundValue: 0,
        reconciliationStatus: "source_identified",
        sourceOnlyTermination: true,
      });
    });
  return [...manual, ...identified];
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
        <span>${escapeHtml(contractDisplayCode(contract))} · ${escapeHtml(contract.category)} · ${contract.daysOverdue} dias</span>
      </div>
      <strong>${formatCurrency(contract.overdueValue)}</strong>
    </div>
  `).join("") || `<div class="insight-item">Sem inadimplentes para o filtro atual.</div>`;
  document.querySelectorAll(".ranking-item[data-contract-id]").forEach((item) => {
    const openContract = () => {
      const contract = state.contracts.find((row) => row.contractId === item.dataset.contractId);
      if (!contract) return;
      switchTab("operational");
      document.getElementById("globalSearch").value = contractDisplayCode(contract);
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
        <span>Contrato ${escapeHtml(contractDisplayCode(contract))} · Localizador ${escapeHtml(contractLocalizer(contract))}</span>
      </div>
      <span class="status-badge status-${escapeAttr(slugStatus(contract.appStatus))}">${escapeHtml(contract.appStatus)}</span>
    </div>
    <div class="hover-card-grid">
      ${hoverDetail("Cessionário 2", contract.secondaryClient || "Não informado")}
      ${hoverDetail("Produto", contract.product || "-")}
      ${hoverDetail("Localizador", contractLocalizer(contract))}
      ${hoverDetail("Estado", contract.clientState || "Não informado")}
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
    lines.push(`<div class="report-line success">Atualização concluída: ${mergeReport.inserted} ativos inseridos, ${mergeReport.updated} ativos atualizados, ${mergeReport.confirmedTerminations || 0} distratos confirmados, ${mergeReport.identifiedTerminations || 0} distratos identificados e ${mergeReport.reversionsDetected || 0} reversões segregadas.</div>`);
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
    contractCodeHealth: pending.validation.contractCodeHealth || {},
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
    `<div class="report-line info">Ativos: ${report.previousSnapshot?.active ?? 0} → ${report.active} · Cancelamentos na fonte: ${report.previousSnapshot?.historical ?? 0} → ${report.historical} · Revertidos: ${report.previousSnapshot?.reverted ?? 0} → ${report.reverted} · Exceções: ${report.previousSnapshot?.exceptions ?? 0} → ${report.exceptions}.</div>`,
    `<div class="report-heading">Principais pontos</div>`,
    `<div class="report-line info">${escapeHtml(deltaText)}</div>`,
    `<div class="report-line success">${report.active} contratos com status Ativo, ${report.historical} cancelamentos na fonte e ${report.reverted} reversões separados da carteira atual.</div>`,
    `<div class="report-line success">${report.mergeReport.inserted} contratos inseridos, ${report.mergeReport.updated} atualizados e ${report.mergeReport.preservedTerminated} distratos do Pós-Venda VIP preservados.</div>`,
  ];
  if (report.mergeReport.confirmedTerminations) {
    lines.push(`<div class="report-line success"><strong>${report.mergeReport.confirmedTerminations} distratos confirmados através da atualização.</strong><br>Os lançamentos já existentes no Pós-Venda VIP foram conciliados pelo localizador, sem duplicação.</div>`);
  }
  if (report.mergeReport.identifiedTerminations) {
    lines.push(`<div class="report-line info"><strong>${report.mergeReport.identifiedTerminations} distratos identificados na atualização.</strong><br>Eles foram incluídos na aba Distratos como registros originados na base.</div>`);
  }
  if (report.ignoredRows.length) {
    lines.push(`<div class="report-line warning">${report.ignoredRows.length} linha de total foi reconhecida por múltiplos critérios e não foi importada como contrato.</div>`);
  }
  if (report.contractCodeHealth?.duplicatedCodes) {
    lines.push(`<div class="report-line warning">${report.contractCodeHealth.duplicatedCodes} códigos de contrato estão duplicados em ${report.contractCodeHealth.duplicateRows} registros. O localizador foi preservado como chave técnica segura.</div>`);
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
  const filterSummary = terminationFilterSummary();
  const logoUrl = new URL("assets/shortcut-logo.png", window.location.href).href;
  const title = type === "formal" ? "Relatório de Distratos" : "Resumo Executivo de Distratos";
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
          <div><span>VILLAMOR · PÓS-VENDA VIP</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(filterSummary)} · Emitido em ${escapeHtml(formatDate(new Date().toISOString()))}</p></div>
        </header>
        ${body}
        <footer>Documento gerado pelo PÓS-VENDA VIP · Recuperado corresponde ao valor efetivamente retido.</footer>
        <script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));<\/script>
      </body>
    </html>`);
  reportWindow.document.close();
}

function formalTerminationReportMarkup(contracts, totals) {
  return `
    <section class="summary-grid">
      ${reportMetric("Distratos", totals.count, "closed")}
      ${reportMetric("Recuperado", formatCurrency(totals.retained), "recovered")}
      ${reportMetric("Reembolsado", formatCurrency(totals.refunded), "refund")}
    </section>
    <table>
      <thead><tr><th>Contrato / Cliente</th><th>Data</th><th>Motivo</th><th>Abordagem</th><th>Retido</th><th>Reembolso</th><th>Responsável</th></tr></thead>
      <tbody>${contracts.map((contract) => `
        <tr>
          <td><strong>${escapeHtml(contractDisplayCode(contract))}</strong><br>${escapeHtml(contract.primaryClient || "-")}</td>
          <td>${escapeHtml(formatDate(contract.terminatedAt))}</td>
          <td>${escapeHtml(contract.terminationReason || "Não informado")}<small>${escapeHtml(contract.terminationObservation || "")}</small></td>
          <td>${escapeHtml(approachLabel(contract.terminationApproach))}</td>
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
      ${reportMetric("Distratos", totals.count, "closed")}
      ${reportMetric("Recuperado", formatCurrency(totals.retained), "recovered")}
      ${reportMetric("Reembolsado", formatCurrency(totals.refunded), "refund")}
    </section>
    <section class="report-columns">
      <article><h3>Principais motivos</h3>${reportBars(reasons, contracts.length)}</article>
      <article><h3>Origem da abordagem</h3>${reportBars(approaches, contracts.length)}</article>
    </section>
    <section class="attention-box">
      <h3>Destaques do período</h3>
      <p>Motivo mais recorrente: <strong>${escapeHtml(reasons[0]?.[0] || "Não informado")}</strong>, com ${reasons[0]?.[1] || 0} registros.</p>
      <p>Maior retenção registrada: <strong>${escapeHtml(largestRetention ? formatCurrency(largestRetention.retainedValue) : "Não houve")}</strong>${largestRetention ? ` no contrato ${escapeHtml(contractDisplayCode(largestRetention))}.` : "."}</p>
      <p>Ponto de atenção: ${totals.refunded > totals.retained ? "o total reembolsado supera o recuperado por retenções." : "o recuperado por retenções é igual ou superior aos reembolsos do período."}</p>
    </section>
  `;
}

function reportMetric(label, value, tone = "", helper = "") {
  const toneClass = tone ? ` tone-${tone}` : "";
  return `<article class="report-metric${toneClass}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${helper ? `<small>${escapeHtml(helper)}</small>` : ""}</article>`;
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

function terminationFilterSummary() {
  const start = document.getElementById("terminationStartDate").value;
  const end = document.getElementById("terminationEndDate").value;
  const reason = selectedOptionLabel("terminationReasonFilter", "all");
  const approach = selectedOptionLabel("terminationApproachFilter", "all");
  const search = document.getElementById("terminationSearch").value.trim();
  const filters = [];
  if (start && end) filters.push(`Período: ${formatDate(start)} a ${formatDate(end)}`);
  else if (start) filters.push(`Período: a partir de ${formatDate(start)}`);
  else if (end) filters.push(`Período: até ${formatDate(end)}`);
  if (reason) filters.push(`Motivo: ${reason}`);
  if (approach) filters.push(`Abordagem: ${approach}`);
  if (search) filters.push(`Busca: ${search}`);
  return filters.length ? filters.join(" · ") : "Sem filtros adicionais";
}

function terminationReportStyles() {
  return `
    @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;color:#29191e;font:12px Arial,sans-serif;background:#fff}header{display:flex;align-items:center;gap:16px;padding-bottom:14px;border-bottom:3px solid #a62552}header img{width:64px;height:64px;border-radius:8px;object-fit:cover}header span{font-size:10px;font-weight:700;color:#a62552}h1{margin:3px 0;font-size:24px}header p{margin:0;color:#6f6267}.summary-grid,.summary-grid.executive{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}.report-metric{padding:12px;border:1px solid #dfd5d9;border-bottom:4px solid #a62552;border-radius:6px;background:#fff}.report-metric span{display:block;color:#8f2349;font-size:10px;font-weight:700;text-transform:uppercase}.report-metric strong{display:block;margin-top:6px;font-size:17px}.report-metric small{display:block;margin-top:5px;color:#75666c;font-size:9px}.report-metric.tone-recovered{border-color:#b8e5cf;border-bottom-color:#079455;background:#f1fbf6}.report-metric.tone-recovered span{color:#087a49}.report-metric.tone-refund{border-color:#f0d78b;border-bottom-color:#d39b00;background:#fff9e8}.report-metric.tone-refund span{color:#9b7000}.report-metric.tone-closed{border-color:#d3d5d7;border-bottom-color:#7d858c;background:linear-gradient(135deg,#f1f2f2,#fffdf6)}.report-metric.tone-closed span{color:#596168}table{width:100%;border-collapse:collapse;font-size:9px}th{padding:7px;background:#3c2029;color:#fff;text-align:left}td{padding:7px;border-bottom:1px solid #e5dde0;vertical-align:top}td small{display:block;margin-top:3px;color:#766970}.report-columns{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}.report-columns article,.attention-box,.hero-summary{padding:16px;border:1px solid #ded3d7;border-radius:7px}h3{margin:0 0 12px}.report-bar{margin:9px 0}.report-bar div{display:flex;justify-content:space-between}.report-bar i{display:block;height:5px;margin-top:4px;border-radius:3px;background:linear-gradient(90deg,#98244c,#e25c72)}.hero-summary{display:flex;justify-content:space-between;align-items:center;margin:16px 0;background:#342027;color:#fff}.hero-summary span{font-size:10px;color:#f09bad}.hero-summary h2{margin:5px 0;font-size:24px}.hero-summary p{margin:0;color:#dacbd0}.hero-summary>strong{font-size:28px;color:#70d9a6;text-align:right}.hero-summary>strong small{display:block;font-size:10px;color:#fff}.attention-box{margin-top:16px;background:#fff8fa}.attention-box p{margin:8px 0}footer{margin-top:18px;padding-top:8px;border-top:1px solid #ddd;color:#776a6f;font-size:9px;text-align:center}@media print{button{display:none}}`;
}

function printExecutivePortfolioReport() {
  const active = getActiveContracts(state.filtered);
  const terminations = getProductionTerminations();
  const kpis = calculateKpis(active, terminations);
  const aging = getAgingData(active);
  const reportWindow = window.open("", "_blank");
  if (!reportWindow) {
    toast("O navegador bloqueou a abertura do relatório. Libere pop-ups para este site.");
    return;
  }
  reportWindow.opener = null;
  const logoUrl = new URL("assets/shortcut-logo.png", window.location.href).href;
  const complianceRate = kpis.totalActive ? kpis.totalCurrent / kpis.totalActive : 0;
  const filterSummary = portfolioFilterSummary();
  reportWindow.document.write(`<!doctype html>
    <html lang="pt-BR">
      <head>
        <meta charset="utf-8">
        <title>Relatório da Inadimplência</title>
        <style>${executivePortfolioReportStyles()}</style>
      </head>
      <body>
        <header>
          <img src="${escapeAttr(logoUrl)}" alt="Villamor">
          <div><span>VILLAMOR · PÓS-VENDA VIP</span><h1>Relatório da Inadimplência</h1><p>Situação Atual da Inadimplência · Emitido em ${escapeHtml(formatDate(new Date().toISOString()))}</p>${filterSummary ? `<small class="report-filter-summary">${escapeHtml(filterSummary)}</small>` : ""}</div>
        </header>
        <section class="executive-metrics">
          ${reportMetric("Contratos Ativos", kpis.totalActive, "", "Carteira filtrada")}
          ${reportMetric("Adimplentes", kpis.totalCurrent, "recovered", "Inclui quitados")}
          ${reportMetric("Em Atraso", kpis.totalLate, "refund", "Até 89 dias")}
          ${reportMetric("Inadimplentes", kpis.totalDefaulted, "danger", "90+ dias")}
          ${reportMetric("Distratos Inadimplência", kpis.totalTerminated, "closed", `Usuário: ${state.currentUser}`)}
          ${reportMetric("Recuperado", formatCurrency(kpis.retainedTotal), "cyan", "Valor efetivamente retido")}
          ${reportMetric("Potencial Recuperável", formatCurrency(kpis.recoverableValue), "navy", "Integralizado dos inadimplentes")}
        </section>
        ${executiveProgressMarkup(complianceRate, kpis.totalCurrent, kpis.totalActive)}
        ${executiveAgingMarkup(aging)}
        <footer>Documento gerado pelo PÓS-VENDA VIP · Indicadores respeitam os filtros ativos no momento da emissão.</footer>
        <script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));<\/script>
      </body>
    </html>`);
  reportWindow.document.close();
}

function portfolioFilterSummary() {
  const search = document.getElementById("globalSearch").value.trim();
  const filters = [
    search ? `Busca: ${search}` : "",
    labeledFilter("categoryFilter", "Categoria"),
    labeledFilter("groupFilter", "Grupo"),
    labeledFilter("statusFilter", "Status"),
    labeledFilter("agingFilter", "Atraso"),
    labeledFilter("valueFilter", "Valor"),
  ].filter(Boolean);
  return filters.length ? `Filtros aplicados: ${filters.join(" · ")}` : "";
}

function labeledFilter(id, label) {
  const value = selectedOptionLabel(id, "all");
  return value ? `${label}: ${value}` : "";
}

function selectedOptionLabel(id, ignoredValue) {
  const select = typeof id === "string" ? document.getElementById(id) : id;
  if (!select || select.value === ignoredValue) return "";
  return select.selectedOptions[0]?.textContent?.trim() || select.value;
}

function executiveProgressMarkup(rate, current, total) {
  const safeRate = Math.max(0, Math.min(1, rate));
  return `
    <section class="portfolio-progress">
      <div>
        <span>PROGRESSO DA CARTEIRA</span>
        <h2>Índice de adimplência</h2>
        <p>${current} contratos adimplentes ou quitados de ${total} contratos ativos.</p>
      </div>
      <strong>${escapeHtml(formatPercent(safeRate))}</strong>
      <div class="progress-track"><i style="width:${safeRate * 100}%"></i></div>
    </section>`;
}

function executiveAgingMarkup(rows) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return `
    <section class="aging-report">
      <div class="aging-heading"><div><span>EXPOSIÇÃO POR TEMPO</span><h2>Aging List</h2></div><small>Quantidade de contratos com valor em atraso</small></div>
      <div class="aging-bars">
        ${rows.map((row) => `
          <article>
            <strong>${row.value}</strong>
            <div class="aging-column"><i style="height:${(row.value / max) * 100}%"></i></div>
            <span>${escapeHtml(row.label)}</span>
            <small>${escapeHtml(formatCurrency(row.amount))}</small>
          </article>`).join("")}
      </div>
    </section>`;
}

function executivePortfolioReportStyles() {
  return `
    @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;color:#22262b;font:11px Arial,sans-serif;background:#fff}header{display:flex;align-items:center;gap:14px;padding-bottom:11px;border-bottom:3px solid #a62552}header img{width:58px;height:58px;border-radius:7px;object-fit:cover}header span,.portfolio-progress span,.aging-heading span{font-size:9px;font-weight:800;color:#a62552}h1{margin:3px 0;font-size:22px}header p,.portfolio-progress p{margin:0;color:#687078}.report-filter-summary{display:block;margin-top:4px;color:#8b596a;font-size:8px;font-weight:700}.executive-metrics{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;margin:12px 0}.report-metric{min-height:72px;padding:9px;border:1px solid #d9dde1;border-bottom:4px solid #a62552;border-radius:5px;background:#fff}.report-metric span{display:block;color:#8f2349;font-size:8px;font-weight:800;text-transform:uppercase}.report-metric strong{display:block;margin-top:5px;font-size:15px}.report-metric small{display:block;margin-top:4px;color:#667079;font-size:8px}.report-metric.tone-recovered{border-color:#b8e5cf;border-bottom-color:#079455;background:#f1fbf6}.report-metric.tone-recovered span{color:#087a49}.report-metric.tone-refund{border-color:#f0d78b;border-bottom-color:#d39b00;background:#fff9e8}.report-metric.tone-refund span{color:#9b7000}.report-metric.tone-danger{border-color:#efbdc7;border-bottom-color:#c72d4c;background:#fff4f6}.report-metric.tone-danger span{color:#b51f40}.report-metric.tone-closed{border-color:#d3d5d7;border-bottom-color:#7d858c;background:linear-gradient(135deg,#f1f2f2,#fffdf6)}.report-metric.tone-closed span{color:#596168}.report-metric.tone-navy{border-color:#9bb6d0;border-bottom-color:#173d63;background:#f1f6fb}.report-metric.tone-navy span{color:#173d63}.report-metric.tone-cyan{border-color:#9ddde5;border-bottom-color:#079bb1;background:#effbfd}.report-metric.tone-cyan span{color:#087f91}.portfolio-progress{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:12px 14px;border:1px solid #d8dde1;border-radius:6px;background:#f8fafb}.portfolio-progress h2,.aging-heading h2{margin:3px 0;font-size:17px}.portfolio-progress>strong{align-self:center;color:#087a49;font-size:25px}.progress-track{grid-column:1/-1;height:11px;overflow:hidden;border-radius:6px;background:#dfe4e7}.progress-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#087a49,#45d79a)}.aging-report{margin-top:10px;padding:11px 14px;border:1px solid #d8dde1;border-radius:6px}.aging-heading{display:flex;align-items:flex-end;justify-content:space-between}.aging-heading small{color:#687078}.aging-bars{display:grid;grid-template-columns:repeat(5,1fr);gap:18px;height:140px;margin-top:8px;padding:4px 18px 0;border-bottom:1px solid #cfd5d9;background:repeating-linear-gradient(to top,transparent 0,transparent 27px,#e8ebed 28px)}.aging-bars article{display:grid;grid-template-rows:15px 1fr 15px 13px;min-width:0;text-align:center}.aging-bars strong{font-size:11px}.aging-column{display:flex;align-items:flex-end;justify-content:center;height:92px}.aging-column i{display:block;width:62%;min-height:2px;border-radius:6px 6px 0 0;background:linear-gradient(180deg,#e36767,#c74451)}.aging-bars span{font-weight:700}.aging-bars small{overflow:hidden;color:#687078;font-size:7px;text-overflow:ellipsis;white-space:nowrap}footer{margin-top:9px;padding-top:6px;border-top:1px solid #ddd;color:#737b82;font-size:8px;text-align:center}@media print{button{display:none}}`;
}

function syncProfileSummary() {
  document.getElementById("currentUserLabel").textContent = state.currentUser;
  document.getElementById("currentUserJobTitle").textContent = state.currentJobTitle || roleLabel(state.currentRole);
  document.getElementById("currentUserAvatar").src = state.currentAvatarUrl || "assets/shortcut-logo.png";
}

function openProfileDialog() {
  state.profileAvatarDraft = state.currentAvatarUrl;
  document.getElementById("profileDisplayName").value = state.currentUser;
  document.getElementById("profileJobTitle").value = state.currentJobTitle;
  document.getElementById("profileAvatarPreview").src = state.currentAvatarUrl || "assets/shortcut-logo.png";
  document.getElementById("profileAvatarInput").value = "";
  document.getElementById("profileDialog").showModal();
}

function closeProfileDialog() {
  document.getElementById("profileDialog").close();
}

async function handleProfileAvatar(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    state.profileAvatarDraft = await resizeProfileImage(file);
    document.getElementById("profileAvatarPreview").src = state.profileAvatarDraft;
  } catch (error) {
    toast(`Não foi possível preparar a foto: ${error.message}`);
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const displayName = document.getElementById("profileDisplayName").value.trim();
  const jobTitle = document.getElementById("profileJobTitle").value.trim();
  if (displayName.length < 2) {
    toast("Informe um nome com pelo menos 2 caracteres.");
    return;
  }
  try {
    const updated = await db.updateProfile({
      displayName,
      jobTitle,
      avatarUrl: state.profileAvatarDraft,
    });
    state.currentUser = updated?.display_name || displayName;
    state.currentJobTitle = updated?.job_title || jobTitle;
    state.currentAvatarUrl = updated?.avatar_url || state.profileAvatarDraft || "";
    syncProfileSummary();
    closeProfileDialog();
    renderExecutive();
    toast("Perfil atualizado.");
  } catch (error) {
    toast(`Não foi possível atualizar o perfil: ${error.message}`);
  }
}

function resizeProfileImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      reject(new Error("use uma imagem PNG, JPG ou WebP."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("não foi possível ler o arquivo."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("a imagem é inválida."));
      image.onload = () => {
        const size = 256;
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        resolve(canvas.toDataURL("image/webp", 0.82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
  syncProfileSummary();
  await db.setSetting("currentUser", state.currentUser);
  toast("Usuário local atualizado.");
}

async function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  await db.setSetting("theme", nextTheme);
  renderExecutive();
}

function togglePresentationMode(force) {
  const next = typeof force === "boolean" ? force : !state.presentationMode;
  state.presentationMode = next;
  document.body.classList.toggle("presentation-mode", next);
  document.getElementById("presentationModeButton").setAttribute("aria-pressed", String(next));
  document.getElementById("presentationModeButton").textContent = next ? "Encerrar apresentação" : "Modo apresentação";
  document.getElementById("presentationExitButton").hidden = !next;
  if (next) {
    document.getElementById("executivePortfolioDetails").open = false;
    document.getElementById("executiveRiskDetails").open = true;
    document.getElementById("executiveRecoveryDetails").open = false;
    document.getElementById("executiveAnalytics").open = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function syncResponsiveExecutiveDisclosure() {
  const analytics = document.getElementById("executiveAnalytics");
  if (!analytics || analytics.dataset.userToggled === "true" || state.presentationMode) return;
  analytics.open = !window.matchMedia("(max-width: 720px)").matches;
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
  updateFilterDock();
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
