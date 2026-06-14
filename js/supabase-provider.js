import { Database } from "./database.js?v=20260611-1";
import { requestTotpVerification } from "./mfa-dialog.js?v=20260614-1";
import { SupabaseClient } from "./supabase-client.js?v=20260613-3";
import { enrichContract, todayIso } from "./utils.js";

export class SupabaseProvider extends Database {
  constructor(config) {
    super();
    this.client = new SupabaseClient(config.supabaseUrl, config.supabasePublishableKey);
    this.profile = null;
    this.mfaEnrollmentDeferred = false;
  }

  get requiresAuthentication() {
    return true;
  }

  hasSession() {
    return Boolean(this.client.session?.access_token);
  }

  async signIn(email, password) {
    await this.client.signIn(email, password);
    await this.loadProfile();
    await this.ensurePrivilegedMfa();
    return this.profile;
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
    await this.ensurePrivilegedMfa();
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
      id: this.profile?.id || this.client.session?.user?.id || null,
      name: this.profile?.display_name || this.client.session?.user?.email || "Usuário",
      email: this.client.session?.user?.email || "",
      role: this.profile?.role || "viewer",
      canWrite: ["admin", "operator"].includes(this.profile?.role),
      assuranceLevel: this.client.getAssuranceLevel(),
    };
  }

  async getContracts() {
    if (this.profile?.role === "viewer") {
      const rows = await this.client.rpc("viewer_contracts");
      return rows.map((row) => enrichContract(redactedContract(row.payload)));
    }
    const rows = await this.client.selectAll("contracts", "select=payload");
    return rows.map((row) => enrichContract(row.payload));
  }

  async setContracts(contracts) {
    await this.replaceCollection("contracts", contracts, contractRow);
  }

  async getTerminatedContracts() {
    const rows = this.profile?.role === "viewer"
      ? await this.client.rpc("viewer_terminations")
      : await this.client.selectAll(
        "terminations",
        "select=contract_snapshot,terminated_at,reason,reason_category,approach_type,observation,is_default_termination,has_retention,retained_value,retention_total,has_refund,refund_value,created_by,created_at,updated_by,updated_at,edit_history",
      );
    return rows.map((row) => {
      const snapshot = this.profile?.role === "viewer"
        ? redactedContract(row.contract_snapshot)
        : row.contract_snapshot;
      return enrichContract({
        ...snapshot,
        terminatedAt: row.terminated_at,
        terminationReason: row.reason_category || row.reason,
        terminationObservation: row.observation || snapshot?.terminationObservation || "",
        terminationApproach: row.approach_type || snapshot?.terminationApproach || "nao_informada",
        isDefaultTermination: row.is_default_termination,
        hasRetention: row.has_retention,
        retainedValue: Number(row.retained_value || 0),
        retentionTotal: row.retention_total,
        hasRefund: row.has_refund,
        refundValue: Number(row.refund_value || 0),
        terminatedById: row.created_by,
        terminationCreatedAt: row.created_at,
        lastEditedById: row.updated_by,
        lastEditedAt: row.updated_at,
        terminationEditHistory: row.edit_history || [],
      });
    });
  }

  async setTerminatedContracts(contracts) {
    await this.replaceCollection("terminations", contracts, terminationRow);
  }

  async getSourceTerminations() {
    return this.getPayloadCollection("source_terminations", "viewer_source_terminations");
  }

  async getSourceReversions() {
    return this.getPayloadCollection("source_reversions", "viewer_source_reversions");
  }

  async getSourceExceptions() {
    return this.getPayloadCollection("source_exceptions", "viewer_source_exceptions");
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

  async getPayloadCollection(table, viewerRpc) {
    const rows = this.profile?.role === "viewer"
      ? await this.client.rpc(viewerRpc)
      : await this.client.selectAll(table, "select=payload");
    return rows.map((row) => enrichContract(
      this.profile?.role === "viewer" ? redactedContract(row.payload) : row.payload,
    ));
  }

  async ensurePrivilegedMfa() {
    if (!["admin", "operator"].includes(this.profile?.role)) return;
    if (this.client.getAssuranceLevel() === "aal2") return;
    if (this.mfaEnrollmentDeferred) return;

    try {
      const factors = await this.client.listFactors();
      const totpFactors = factors.filter((factor) => (
        (factor.factor_type || factor.type) === "totp"
      ));
      const verifiedFactor = totpFactors.find((factor) => factor.status === "verified");

      if (verifiedFactor) {
        await requestTotpVerification({
          onVerify: async (code) => {
            const challenge = await this.client.challengeMfa(verifiedFactor.id);
            return this.client.verifyMfa(verifiedFactor.id, challenge.id, code);
          },
        });
      } else {
        await Promise.all(
          totpFactors.map((factor) => this.client.unenrollFactor(factor.id).catch(() => null)),
        );
        const factor = await this.client.enrollTotp();
        const result = await requestTotpVerification({
          enrollment: {
            qrCode: factor.totp?.qr_code || "",
            secret: factor.totp?.secret || "",
            uri: factor.totp?.uri || "",
          },
          onVerify: async (code) => {
            const challenge = await this.client.challengeMfa(factor.id);
            return this.client.verifyMfa(factor.id, challenge.id, code);
          },
        });
        if (result?.deferred) {
          this.mfaEnrollmentDeferred = true;
          return;
        }
      }

      if (this.client.getAssuranceLevel() !== "aal2") {
        throw providerError("MFA_REQUIRED", "Nao foi possivel elevar a seguranca desta sessao.");
      }
    } catch (error) {
      await this.signOut();
      throw error;
    }
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
    await this.client.rpc("set_app_setting", {
      p_key: key,
      p_value: value,
    });
  }

  async terminateContract(contractId, reason, financial = {}) {
    await this.client.rpc("terminate_contract_v2", {
      p_contract_id: contractId,
      p_reason_category: reason,
      p_observation: financial.observation || "",
      p_approach_type: financial.approach,
      p_termination_date: dateOnly(financial.terminationDate) || dateOnly(todayIso()),
      p_has_retention: Boolean(financial.hasRetention),
      p_retained_value: financial.hasRetention ? Number(financial.retainedValue || 0) : 0,
      p_retention_total: Boolean(financial.retentionTotal),
      p_has_refund: Boolean(financial.hasRefund),
      p_refund_value: financial.hasRefund ? Number(financial.refundValue || 0) : 0,
    });
  }

  async editTermination(contractId, reason, financial = {}) {
    await this.client.rpc("edit_termination", {
      p_contract_id: contractId,
      p_reason_category: reason,
      p_observation: financial.observation || "",
      p_approach_type: financial.approach,
      p_termination_date: dateOnly(financial.terminationDate),
      p_has_retention: Boolean(financial.hasRetention),
      p_retained_value: financial.hasRetention ? Number(financial.retainedValue || 0) : 0,
      p_retention_total: Boolean(financial.retentionTotal),
      p_has_refund: Boolean(financial.hasRefund),
      p_refund_value: financial.hasRefund ? Number(financial.refundValue || 0) : 0,
      p_edit_justification: financial.editJustification,
    });
  }

  async restoreContract(contractId) {
    await this.client.rpc("restore_contract_v2", {
      p_contract_id: contractId,
    });
  }

  async updateContractStatus(contractId, nextStatus) {
    await this.client.rpc("update_contract_status", {
      p_contract_id: contractId,
      p_next_status: nextStatus,
    });
  }

  async updateContractNotes(contractId, notes) {
    await this.client.rpc("update_contract_notes", {
      p_contract_id: contractId,
      p_notes: notes,
    });
  }

  async mergeContracts(incomingContracts, metadata = {}) {
    return this.client.rpc("import_contract_snapshot", {
      p_contracts: incomingContracts.map(cleanContract),
      p_metadata: metadata,
    });
  }

  async addAuditLog() {
    throw providerError("SERVER_AUDIT_REQUIRED", "A auditoria online deve ser criada pelo banco.");
  }

  async addImportLog() {
    throw providerError("SERVER_AUDIT_REQUIRED", "O log de importação online deve ser criado pelo banco.");
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
    reason_category: contract.terminationReason || "Não informado",
    approach_type: contract.terminationApproach || "nao_informada",
    observation: contract.terminationObservation || "",
    is_default_termination: contract.isDefaultTermination !== false,
    has_retention: Boolean(contract.hasRetention),
    retained_value: Number(contract.retainedValue || 0),
    retention_total: Boolean(contract.retentionTotal),
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

function redactedContract(contract) {
  return {
    ...contract,
    primaryClient: "Dados restritos",
    secondaryClient: "",
    primaryDocument: "",
    secondaryDocument: "",
    primaryPhone: "",
    secondaryPhone: "",
    notes: "",
    sourceExtras: {},
  };
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
