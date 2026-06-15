import { IndexedDbStorage } from "./storage.js?v=20260609-5";
import { STATUS, createId, enrichContract, todayIso } from "./utils.js";

export class Database {
  constructor() {
    this.storage = new IndexedDbStorage();
  }

  async init() {
    await this.storage.open();
    const contracts = await this.getContracts();
    if (!contracts.length) {
      const seed = await this.loadSeed();
      const enriched = seed.records.map((contract) => enrichContract({
        ...contract,
        importedAt: seed.generatedAt,
      }));
      await this.storage.setAll("contracts", enriched);
      await this.addImportLog({
        type: "bootstrap",
        inserted: enriched.length,
        updated: 0,
        skipped: 0,
        errors: [],
      });
      return;
    }

    if (this.needsSeedRepair(contracts)) {
      await this.repairFromSeed();
    }
    await this.migrateReversionsFromActiveContracts();
    await this.removeLegacySummaryRows();
  }

  async loadSeed() {
    const response = await fetch("data/basededados.json");
    if (!response.ok) {
      return {
        generatedAt: new Date().toISOString(),
        records: [],
      };
    }
    return response.json();
  }

  needsSeedRepair(contracts) {
    const sample = contracts.slice(0, Math.min(30, contracts.length));
    if (!sample.length) return false;
    const missingClients = sample.filter((contract) => !contract.primaryClient).length;
    const missingDueDates = sample.filter((contract) => !contract.nextDueDate).length;
    return missingClients > sample.length * 0.4 || missingDueDates > sample.length * 0.4;
  }

  async repairFromSeed() {
    const seed = await this.loadSeed();
    if (!seed.records.length) return;
    const seedMap = new Map(seed.records.map((contract) => [contract.contractId, contract]));
    const existingContracts = await this.getContracts();
    const existingTerminated = await this.getTerminatedContracts();

    const repairContract = (existing) => {
      const seedContract = seedMap.get(existing.contractId);
      if (!seedContract) return existing;
      return enrichContract({
        ...existing,
        ...seedContract,
        notes: existing.notes || "",
        manualStatus: [STATUS.TERMINATED, STATUS.TERMINATED_OTHER].includes(existing.manualStatus)
          ? existing.manualStatus
          : null,
        previousStatus: existing.previousStatus || null,
        localUser: existing.localUser || "Operador Local",
        lastUpdatedAt: existing.lastUpdatedAt || null,
        importedAt: existing.importedAt || seed.generatedAt,
      });
    };

    const repaired = existingContracts.map(repairContract);
    const repairedTerminated = existingTerminated.map((existing) => {
      const repairedContract = repairContract(existing);
      return {
        ...repairedContract,
        manualStatus: existing.manualStatus || STATUS.TERMINATED,
        terminationReason: existing.terminationReason || null,
        terminatedAt: existing.terminatedAt || null,
        terminatedBy: existing.terminatedBy || null,
      };
    });

    await this.setContracts(repaired);
    await this.storage.setAll("terminatedContracts", repairedTerminated);
    await this.addImportLog({
      type: "seed-repair",
      inserted: 0,
      updated: repaired.length + repairedTerminated.length,
      skipped: 0,
      errors: [],
    });
  }

  async getContracts() {
    return (await this.storage.getAll("contracts")).map(enrichContract);
  }

  async setContracts(contracts) {
    await this.storage.setAll("contracts", contracts.map(enrichContract));
  }

  async getTerminatedContracts() {
    return (await this.storage.getAll("terminatedContracts")).map(enrichContract);
  }

  async getSourceTerminations() {
    return (await this.storage.getAll("sourceTerminations")).map(enrichContract);
  }

  async getSourceReversions() {
    return (await this.storage.getAll("sourceReversions")).map(enrichContract);
  }

  async getSourceExceptions() {
    return (await this.storage.getAll("sourceExceptions")).map(enrichContract);
  }

  async setTerminatedContracts(contracts) {
    await this.storage.setAll("terminatedContracts", contracts.map(enrichContract));
  }

  async setSourceTerminations(contracts) {
    await this.storage.setAll("sourceTerminations", contracts.map(enrichContract));
  }

  async setSourceReversions(contracts) {
    await this.storage.setAll("sourceReversions", contracts.map(enrichContract));
  }

  async setSourceExceptions(contracts) {
    await this.storage.setAll("sourceExceptions", contracts.map(enrichContract));
  }

  async putContract(contract) {
    await this.storage.put("contracts", enrichContract(contract));
  }

  async putTerminated(contract) {
    await this.storage.put("terminatedContracts", enrichContract(contract));
  }

  async putSourceTermination(contract) {
    await this.storage.put("sourceTerminations", enrichContract(contract));
  }

  async migrateReversionsFromActiveContracts() {
    const contracts = await this.getContracts();
    const misplaced = contracts.filter((contract) => contract.sourceReverted);
    if (!misplaced.length) return;
    const activeContracts = contracts.filter((contract) => !contract.sourceReverted);
    const existing = await this.getSourceReversions();
    const map = new Map(existing.map((contract) => [contract.contractId, contract]));
    linkReversionsToActiveContracts(misplaced, activeContracts).forEach((contract) => map.set(contract.contractId, {
      ...contract,
      sourceUpdatedAt: contract.sourceUpdatedAt || todayIso(),
    }));
    await this.setSourceReversions([...map.values()]);
    await this.setContracts(activeContracts);
  }

  async removeLegacySummaryRows() {
    const contracts = await this.getContracts();
    const sourceExceptions = await this.getSourceExceptions();
    const removedContracts = contracts.filter(isVerifiedLegacySummaryContract);
    const removedExceptions = sourceExceptions.filter(isVerifiedLegacySummaryContract);
    const removedIds = new Set([...removedContracts, ...removedExceptions].map((item) => item.contractId));
    if (!removedIds.size) return;

    await this.setContracts(contracts.filter((contract) => !removedIds.has(contract.contractId)));
    await this.setSourceExceptions(sourceExceptions.filter((contract) => !removedIds.has(contract.contractId)));
    await this.setSetting("pendingSystemEvolutionReport", {
      createdAt: todayIso(),
      title: "Atualização da base e evolução do sistema",
      removedSummaryRows: removedIds.size,
      removedIdentifiers: [...removedIds],
      changes: [
        "Linhas recorrentes de total agora são reconhecidas por múltiplos critérios e ignoradas antes da importação.",
        "Registros de total gravados por versões anteriores foram removidos da carteira ativa.",
        "Somente contratos com status Ativo permanecem nos indicadores operacionais.",
        "Revertidos e cancelados permanecem em históricos separados.",
      ],
      observations: [
        "A limpeza não utiliza apenas a palavra total: exige identificador no padrão Qtd, status vazio, cliente vazio e produto vazio.",
        "As próximas atualizações continuarão exibindo um relatório após a aplicação, mesmo sem reiniciar o sistema.",
      ],
    });
  }

  async deleteContract(contractId) {
    await this.storage.delete("contracts", contractId);
  }

  async deleteTerminated(contractId) {
    await this.storage.delete("terminatedContracts", contractId);
  }

  async getSettings() {
    const settings = await this.storage.getAll("settings");
    return Object.fromEntries(settings.map((item) => [item.key, item.value]));
  }

  async setSetting(key, value) {
    await this.storage.put("settings", { key, value });
  }

  async updateProfile(profile) {
    const current = (await this.getSettings()).profile || {};
    const updated = {
      ...current,
      display_name: profile.displayName,
      job_title: profile.jobTitle || "",
      avatar_url: profile.avatarUrl || "",
    };
    await this.setSetting("profile", updated);
    await this.setSetting("currentUser", updated.display_name);
    return updated;
  }

  async addAuditLog(payload) {
    await this.storage.put("auditLogs", {
      id: createId("audit"),
      createdAt: todayIso(),
      ...payload,
    });
  }

  async addImportLog(payload) {
    await this.storage.put("importLogs", {
      id: createId("import"),
      createdAt: todayIso(),
      ...payload,
    });
  }

  async mergeContracts(incomingContracts, metadata = {}) {
    const current = await this.getContracts();
    const terminated = await this.getTerminatedContracts();
    const currentMap = new Map(current.map((item) => [item.contractId, item]));
    const terminatedMap = new Map(terminated.map((item) => [item.contractId, item]));
    const activeIncoming = incomingContracts.filter((item) => isActiveSourceStatus(item.sourceStatus));
    const sourceTerminations = incomingContracts.filter((item) => item.sourceTerminated);
    const sourceReversions = incomingContracts.filter((item) => item.sourceReverted);
    const sourceExceptions = incomingContracts.filter((item) => (
      !isActiveSourceStatus(item.sourceStatus)
      && !item.sourceTerminated
      && !item.sourceReverted
    ));
    const incomingIds = new Set(incomingContracts.map((item) => item.contractId));
    const activeIds = new Set(activeIncoming.map((item) => item.contractId));
    const linkedReversions = linkReversionsToActiveContracts(sourceReversions, activeIncoming);
    const confirmedTerminations = sourceTerminations.filter((item) => terminatedMap.has(item.contractId));
    const identifiedTerminations = sourceTerminations.filter((item) => !terminatedMap.has(item.contractId));
    const merged = current.filter((item) => !incomingIds.has(item.contractId));
    const report = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      preservedTerminated: 0,
      historicalTerminationsDetected: sourceTerminations.length,
      confirmedTerminations: confirmedTerminations.length,
      identifiedTerminations: identifiedTerminations.length,
      reversionsDetected: linkedReversions.length,
      unlinkedReversions: linkedReversions.filter((item) => !item.linkedActiveContractId).length,
      sourceExceptions: sourceExceptions.length,
      removedFromActive: current.filter((item) => (
        incomingIds.has(item.contractId) && !activeIds.has(item.contractId)
      )).length,
      errors: [],
    };

    activeIncoming.forEach((incoming) => {
      const normalizedIncoming = enrichContract(incoming);
      if (terminatedMap.has(normalizedIncoming.contractId)) {
        report.preservedTerminated += 1;
        return;
      }

      const existing = currentMap.get(normalizedIncoming.contractId);
      if (!existing) {
        merged.push(normalizedIncoming);
        currentMap.set(normalizedIncoming.contractId, normalizedIncoming);
        report.inserted += 1;
        return;
      }

      const preservedInternal = {
        notes: existing.notes || "",
        manualStatus: existing.manualStatus || null,
        previousStatus: existing.previousStatus || null,
        localUser: existing.localUser || "Operador Local",
        lastUpdatedAt: existing.lastUpdatedAt || null,
        importedAt: existing.importedAt || null,
      };
      const updated = enrichContract({
        ...existing,
        ...normalizedIncoming,
        ...preservedInternal,
        sourceUpdatedAt: todayIso(),
      });
      merged.push(updated);
      report.updated += 1;
    });

    await this.setContracts(merged);
    const confirmationTime = todayIso();
    for (const sourceContract of confirmedTerminations) {
      const manual = terminatedMap.get(sourceContract.contractId);
      terminatedMap.set(sourceContract.contractId, enrichContract({
        ...manual,
        reconciliationStatus: "source_confirmed",
        sourceConfirmedAt: confirmationTime,
        sourceConfirmationDate: sourceContract.sourceTerminationDate || null,
        sourceConfirmationReason: sourceContract.sourceTerminationReason || null,
        sourceConfirmationPayload: sourceContract,
        lastUpdatedAt: confirmationTime,
      }));
    }
    await this.setTerminatedContracts([...terminatedMap.values()]);
    await this.setSourceTerminations(identifiedTerminations.map((contract) => enrichContract({
      ...currentMap.get(contract.contractId),
      ...contract,
      sourceTerminationOrigin: contract.sourceTerminationOrigin || "Base importada",
      reconciliationStatus: "source_identified",
      sourceUpdatedAt: todayIso(),
    })));
    await this.setSourceReversions(linkedReversions.map((contract) => enrichContract({
      ...contract,
      sourceUpdatedAt: todayIso(),
    })));
    await this.setSourceExceptions(sourceExceptions.map((contract) => enrichContract({
      ...contract,
      sourceUpdatedAt: todayIso(),
    })));
    await this.addImportLog({ type: "merge", ...report, metadata });
    return report;
  }
}

function isActiveSourceStatus(value) {
  return normalizeSourceValue(value) === "ativo";
}

function linkReversionsToActiveContracts(reversions, activeContracts) {
  const activeById = new Map(activeContracts.map((contract) => [String(contract.contractId), contract]));
  const activeByOrigin = new Map();
  activeContracts.forEach((contract) => {
    const origin = String(contract.originReversal || "").trim();
    if (origin) activeByOrigin.set(origin, contract);
  });

  return reversions.map((reversion) => {
    const origin = String(reversion.originReversal || "").trim();
    const linked = activeById.get(origin) || activeByOrigin.get(String(reversion.contractId)) || null;
    return {
      ...reversion,
      linkedActiveContractId: linked?.contractId || null,
      linkedActiveClient: linked?.primaryClient || null,
      reversalLinkMethod: linked
        ? activeById.has(origin) ? "Origem Reversão aponta para contrato ativo" : "Contrato ativo aponta para esta reversão"
        : null,
    };
  });
}

function normalizeSourceValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isVerifiedLegacySummaryContract(contract) {
  return /^qtd(?:\.|ade)?\s*:\s*\d+\s*$/i.test(String(contract.contractId || "").trim())
    && !String(contract.sourceStatus || "").trim()
    && !String(contract.primaryClient || "").trim()
    && !String(contract.product || "").trim();
}
