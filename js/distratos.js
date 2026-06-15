import { STATUS, todayIso } from "./utils.js";

export class DistratoService {
  constructor(database) {
    this.database = database;
  }

  async terminate(contract, reason, user, financial = {}) {
    if (typeof this.database.terminateContract === "function") {
      await this.database.terminateContract(contract.contractId, reason, financial);
      return;
    }

    const now = todayIso();
    const terminatedAt = financial.terminationDate
      ? `${financial.terminationDate}T12:00:00`
      : now;
    const isDefaultTermination = reason === "Inadimplência";
    const terminationClassification = isDefaultTermination ? "Inadimplência" : "Outros motivos";
    const terminationStatus = isDefaultTermination ? STATUS.TERMINATED : STATUS.TERMINATED_OTHER;
    const terminated = {
      ...contract,
      previousStatus: contract.appStatus,
      manualStatus: terminationStatus,
      isDefaultTermination,
      terminationClassification,
      terminationReason: reason,
      terminationObservation: financial.observation || "",
      terminationApproach: financial.approach || "nao_informada",
      terminatedAt,
      terminatedBy: user,
      terminatedById: financial.userId || null,
      lastUpdatedAt: now,
      localUser: user,
      hasRetention: Boolean(financial.hasRetention),
      retainedValue: financial.hasRetention ? Number(financial.retainedValue || 0) : 0,
      retentionTotal: Boolean(financial.retentionTotal),
      hasRefund: Boolean(financial.hasRefund),
      refundValue: financial.hasRefund ? Number(financial.refundValue || 0) : 0,
      reconciliationStatus: "manual_pending",
      sourceConfirmedAt: null,
      sourceConfirmationDate: null,
      sourceConfirmationReason: null,
      sourceConfirmationPayload: null,
    };

    await this.database.deleteContract(contract.contractId);
    await this.database.putTerminated(terminated);
    await this.database.addAuditLog({
      contractId: contract.contractId,
      action: "terminate",
      user,
      reason,
      previousStatus: contract.appStatus,
      nextStatus: terminationStatus,
      terminationClassification,
      terminationObservation: terminated.terminationObservation,
      terminationApproach: terminated.terminationApproach,
      hasRetention: terminated.hasRetention,
      retainedValue: terminated.retainedValue,
      retentionTotal: terminated.retentionTotal,
      hasRefund: terminated.hasRefund,
      refundValue: terminated.refundValue,
      terminatedAt,
    });
  }

  async editTermination(contract, reason, user, financial = {}) {
    if (typeof this.database.editTermination === "function") {
      await this.database.editTermination(contract.contractId, reason, financial);
      return;
    }

    const now = todayIso();
    const previous = {
      terminationReason: contract.terminationReason,
      terminationObservation: contract.terminationObservation,
      terminationApproach: contract.terminationApproach,
      terminatedAt: contract.terminatedAt,
      retainedValue: contract.retainedValue,
      refundValue: contract.refundValue,
    };
    const isDefaultTermination = reason === "Inadimplência";
    const historyEntry = {
      editedAt: now,
      editedBy: user,
      justification: financial.editJustification,
      previous,
    };
    const updated = {
      ...contract,
      terminationReason: reason,
      terminationObservation: financial.observation || "",
      terminationApproach: financial.approach,
      terminationClassification: isDefaultTermination ? "Inadimplência" : "Outros motivos",
      isDefaultTermination,
      terminatedAt: financial.terminationDate ? `${financial.terminationDate}T12:00:00` : contract.terminatedAt,
      hasRetention: Boolean(financial.hasRetention),
      retainedValue: financial.hasRetention ? Number(financial.retainedValue || 0) : 0,
      retentionTotal: Boolean(financial.retentionTotal),
      hasRefund: Boolean(financial.hasRefund),
      refundValue: financial.hasRefund ? Number(financial.refundValue || 0) : 0,
      lastEditedAt: now,
      lastEditedBy: user,
      lastEditJustification: financial.editJustification,
      terminationEditHistory: [...(contract.terminationEditHistory || []), historyEntry],
      lastUpdatedAt: now,
    };
    await this.database.putTerminated(updated);
    await this.database.addAuditLog({
      contractId: contract.contractId,
      action: "edit-termination",
      user,
      justification: financial.editJustification,
      previous,
      next: updated,
    });
  }

  async restore(contract, user) {
    if (typeof this.database.restoreContract === "function") {
      await this.database.restoreContract(contract.contractId);
      return;
    }

    const restored = {
      ...contract,
      manualStatus: null,
      terminationReason: null,
      terminationObservation: null,
      terminationApproach: null,
      terminatedAt: null,
      terminatedBy: null,
      terminatedById: null,
      previousStatus: null,
      hasRetention: false,
      retainedValue: 0,
      retentionTotal: false,
      hasRefund: false,
      refundValue: 0,
      terminationEditHistory: [],
      lastEditedAt: null,
      lastEditedBy: null,
      lastEditJustification: null,
      reconciliationStatus: null,
      sourceConfirmedAt: null,
      sourceConfirmationDate: null,
      sourceConfirmationReason: null,
      sourceConfirmationPayload: null,
      lastUpdatedAt: todayIso(),
      localUser: user,
    };

    await this.database.deleteTerminated(contract.contractId);
    await this.database.putContract(restored);
    await this.database.addAuditLog({
      contractId: contract.contractId,
      action: "restore",
      user,
      nextStatus: restored.manualStatus || "Derivado pela base",
    });
  }

  async updateStatus(contract, nextStatus, user) {
    if (typeof this.database.updateContractStatus === "function") {
      await this.database.updateContractStatus(contract.contractId, nextStatus);
      return;
    }

    const previousStatus = contract.appStatus;
    const updated = {
      ...contract,
      manualStatus: nextStatus,
      previousStatus,
      lastUpdatedAt: todayIso(),
      localUser: user,
    };
    await this.database.putContract(updated);
    await this.database.addAuditLog({
      contractId: contract.contractId,
      action: "status-change",
      user,
      previousStatus,
      nextStatus,
    });
  }

  async updateNotes(contract, notes, user) {
    if (typeof this.database.updateContractNotes === "function") {
      await this.database.updateContractNotes(contract.contractId, notes);
      return;
    }

    await this.database.putContract({
      ...contract,
      notes,
      lastUpdatedAt: todayIso(),
      localUser: user,
    });
  }
}
