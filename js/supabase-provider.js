import { Database } from "./database.js?v=20260610-7";
import { SupabaseClient } from "./supabase-client.js?v=20260610-1";
import { enrichContract, todayIso } from "./utils.js";

export class SupabaseProvider extends Database {
  constructor(config) {
    super();
    this.client = new SupabaseClient(config.supabaseUrl, config.supabasePublishableKey);
    this.profile = null;
  }

  get requiresAuthentication() {
    return true;
  }

  hasSession() {
    return Boolean(this.client.session?.access_token);
  }

  async signIn(email, password) {
    await this.client.signIn(email, password);
    return this.loadProfile();
  }

  async signUp(email, password, displayName) {
    return this.client.signUp(email, password, displayName);
  }

  async signOut() {
    this.profile = null;
    await this.client.signOut();
  }

  async init() {
    if (!this.hasSession()) throw providerError("AUTH_REQUIRED", "Entre para acessar o sistema.");
    await this.loadProfile();
  }

  async loadProfile() {
    const userId = this.client.session?.user?.id;
    if (!userId) throw providerError("AUTH_REQUIRED", "Sua sessão expirou. Entre novamente.");
    const rows = await this.client.selectAll(
      "profiles",
      `id=eq.${encodeURIComponent(userId)}&select=id,display_name,role,is_active`,
    );
    this.profile = rows[0] || null;
    if (!this.profile) throw providerError("PROFILE_MISSING", "Perfil ainda não provisionado.");
    if (!this.profile.is_active) {
      throw providerError("ACCOUNT_PENDING", "Seu acesso aguarda aprovação de um administrador.");
    }
    return this.profile;
  }

  getIdentity() {
    return {
      name: this.profile?.display_name || this.client.session?.user?.email || "Usuário",
      email: this.client.session?.user?.email || "",
      role: this.profile?.role || "viewer",
      canWrite: ["admin", "operator"].includes(this.profile?.role),
    };
  }

  async getContracts() {
    const rows = await this.client.selectAll("contracts", "select=payload");
    return rows.map((row) => enrichContract(row.payload));
  }

  async setContracts(contracts) {
    await this.replaceCollection("contracts", contracts, contractRow);
  }

  async getTerminatedContracts() {
    const rows = await this.client.selectAll(
      "terminations",
      "select=contract_snapshot,terminated_at,reason,is_default_termination,has_retention,retained_value,has_refund,refund_value",
    );
    return rows.map((row) => enrichContract({
      ...row.contract_snapshot,
      terminatedAt: row.terminated_at,
      terminationReason: row.reason,
      isDefaultTermination: row.is_default_termination,
      hasRetention: row.has_retention,
      retainedValue: Number(row.retained_value || 0),
      hasRefund: row.has_refund,
      refundValue: Number(row.refund_value || 0),
    }));
  }

  async setTerminatedContracts(contracts) {
    await this.replaceCollection("terminations", contracts, terminationRow);
  }

  async getSourceTerminations() {
    return this.getPayloadCollection("source_terminations");
  }

  async getSourceReversions() {
    return this.getPayloadCollection("source_reversions");
  }

  async getSourceExceptions() {
    return this.getPayloadCollection("source_exceptions");
  }

  async setSourceTerminations(contracts) {
    await this.replaceCollection("source_terminations", contracts, sourceTerminationRow);
  }

  async setSourceReversions(contracts) {
    await this.replaceCollection("source_reversions", contracts, (contract) => ({
      contract_id: contract.contractId,
      payload: cleanContract(contract),
      origin_reversal: contract.originReversal || null,
      linked_active_contract_id: contract.linkedActiveContractId || null,
      reversal_date: dateOnly(contract.sourceReversalDate),
      imported_at: todayIso(),
    }));
  }

  async setSourceExceptions(contracts) {
    await this.replaceCollection("source_exceptions", contracts, (contract) => ({
      contract_id: contract.contractId,
      payload: cleanContract(contract),
      reason: contract.sourceStatus || "Status não classificado",
      imported_at: todayIso(),
    }));
  }

  async getPayloadCollection(table) {
    const rows = await this.client.selectAll(table, "select=payload");
    return rows.map((row) => enrichContract(row.payload));
  }

  async putContract(contract) {
    await this.client.upsert("contracts", [contractRow(contract)], "contract_id");
  }

  async putTerminated(contract) {
    await this.client.upsert("terminations", [terminationRow(contract)], "contract_id");
  }

  async putSourceTermination(contract) {
    await this.client.upsert("source_terminations", [sourceTerminationRow(contract)], "contract_id");
  }

  async deleteContract(contractId) {
    await this.client.delete("contracts", `contract_id=eq.${encodeURIComponent(contractId)}`);
  }

  async deleteTerminated(contractId) {
    await this.client.delete("terminations", `contract_id=eq.${encodeURIComponent(contractId)}`);
  }

  async getSettings() {
    const rows = await this.client.selectAll("app_settings", "select=key,value");
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async setSetting(key, value) {
    await this.client.upsert("app_settings", [{
      key,
      value,
      updated_by: this.client.session.user.id,
      updated_at: todayIso(),
    }], "key");
  }

  async addAuditLog(payload) {
    await this.client.insert("audit_logs", {
      action: payload.action || "update",
      entity_type: "contract",
      entity_id: payload.contractId || null,
      details: payload,
      user_id: this.client.session.user.id,
      created_at: todayIso(),
    });
  }

  async addImportLog(payload) {
    const metadata = payload.metadata || {};
    await this.client.insert("import_runs", {
      file_name: metadata.fileName || "Atualização de base",
      sheet_name: metadata.sheetName || null,
      source_rows: metadata.sourceRows || payload.inserted + payload.updated || 0,
      valid_rows: metadata.validRows || payload.inserted + payload.updated || 0,
      active_rows: payload.inserted + payload.updated || 0,
      terminated_rows: payload.historicalTerminationsDetected || 0,
      reverted_rows: payload.reversionsDetected || 0,
      exception_rows: payload.sourceExceptions || 0,
      ignored_rows: metadata.ignoredRows || [],
      report: payload,
      imported_by: this.client.session.user.id,
      created_at: todayIso(),
    });
  }

  async replaceCollection(table, contracts, mapper) {
    const existing = await this.client.selectAll(table, "select=contract_id");
    const incomingIds = new Set(contracts.map((contract) => String(contract.contractId)));
    const stale = existing
      .map((row) => String(row.contract_id))
      .filter((id) => !incomingIds.has(id));

    for (let index = 0; index < stale.length; index += 100) {
      const values = stale.slice(index, index + 100)
        .map((id) => `"${id.replaceAll('"', '\\"')}"`)
        .join(",");
      await this.client.delete(table, `contract_id=in.(${values})`);
    }

    if (contracts.length) {
      await this.client.upsert(table, contracts.map(mapper), "contract_id");
    }
  }
}

function contractRow(contract) {
  return {
    contract_id: contract.contractId,
    source_status: contract.sourceStatus || "Ativo",
    primary_client: contract.primaryClient || null,
    secondary_client: contract.secondaryClient || null,
    primary_document: contract.primaryDocument || null,
    secondary_document: contract.secondaryDocument || null,
    primary_phone: contract.primaryPhone || null,
    secondary_phone: contract.secondaryPhone || null,
    product: contract.product || null,
    category: contract.category || null,
    property: contract.property || null,
    quota: contract.quota || null,
    origin_reversal: contract.originReversal || null,
    effective_paid_value: Number(contract.effectivePaidValue || 0),
    remaining_balance: Number(contract.remainingBalance || 0),
    total_updated_value: Number(contract.totalUpdatedValue || 0),
    overdue_value: Number(contract.overdueValue || 0),
    next_due_date: dateOnly(contract.nextDueDate),
    financial_status: contract.financialStatus || null,
    notes: contract.notes || "",
    source_extras: contract.sourceExtras || {},
    imported_at: contract.importedAt || todayIso(),
    source_updated_at: contract.sourceUpdatedAt || todayIso(),
    updated_at: todayIso(),
    payload: cleanContract(contract),
  };
}

function terminationRow(contract) {
  return {
    contract_id: contract.contractId,
    contract_snapshot: cleanContract(contract),
    terminated_at: dateOnly(contract.terminatedAt) || dateOnly(todayIso()),
    reason: contract.terminationReason || "Distrato registrado",
    is_default_termination: contract.isDefaultTermination !== false,
    has_retention: Boolean(contract.hasRetention),
    retained_value: Number(contract.retainedValue || 0),
    has_refund: Boolean(contract.hasRefund),
    refund_value: Number(contract.refundValue || 0),
  };
}

function sourceTerminationRow(contract) {
  return {
    contract_id: contract.contractId,
    payload: cleanContract(contract),
    termination_date: dateOnly(contract.sourceTerminationDate),
    termination_reason: contract.sourceTerminationReason || null,
    imported_at: todayIso(),
  };
}

function cleanContract(contract) {
  const {
    searchText,
    appStatus,
    daysOverdue,
    agingBucket,
    ...payload
  } = contract;
  return payload;
}

function dateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
