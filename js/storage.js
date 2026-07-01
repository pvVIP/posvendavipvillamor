const FALLBACK_KEY = "villamor-inadimplencia-state";

export class LocalFallbackStorage {
  constructor() {
    this.state = this.readState();
  }

  readState() {
    try {
      return JSON.parse(localStorage.getItem(FALLBACK_KEY)) || {};
    } catch {
      return {};
    }
  }

  writeState() {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(this.state));
  }

  async getStore(name) {
    return this.state[name] || [];
  }

  async setStore(name, rows) {
    this.state[name] = rows;
    this.writeState();
  }

  async put(name, record, key = "id") {
    const rows = await this.getStore(name);
    const index = rows.findIndex((item) => item[key] === record[key]);
    if (index >= 0) rows[index] = record;
    else rows.push(record);
    await this.setStore(name, rows);
  }

  async delete(name, id, key = "id") {
    await this.setStore(name, (await this.getStore(name)).filter((item) => item[key] !== id));
  }
}

export class IndexedDbStorage {
  constructor(dbName = "villamor-inadimplencia", version = 5) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this.fallback = new LocalFallbackStorage();
  }

  async open() {
    if (!("indexedDB" in window)) return null;
    if (this.db) return this.db;

    return new Promise((resolve) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = () => {
        const db = request.result;
        this.ensureStore(db, "contracts", "contractId");
        this.ensureStore(db, "terminatedContracts", "contractId");
        this.ensureStore(db, "sourceTerminations", "contractId");
        this.ensureStore(db, "sourceReversions", "contractId");
        this.ensureStore(db, "sourceExceptions", "contractId");
        this.ensureStore(db, "treatmentReviews", "caseId");
        this.ensureStore(db, "auditLogs", "id");
        this.ensureStore(db, "importLogs", "id");
        this.ensureStore(db, "settings", "key");
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onerror = () => resolve(null);
    });
  }

  ensureStore(db, storeName, keyPath) {
    if (!db.objectStoreNames.contains(storeName)) {
      db.createObjectStore(storeName, { keyPath });
    }
  }

  async withStore(storeName, mode, callback) {
    const db = await this.open();
    if (!db) return callback(null);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const result = callback(store);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getAll(storeName) {
    const db = await this.open();
    if (!db) return this.fallback.getStore(storeName);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async setAll(storeName, rows) {
    const db = await this.open();
    if (!db) return this.fallback.setStore(storeName, rows);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      store.clear();
      rows.forEach((row) => store.put(row));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async put(storeName, row) {
    const db = await this.open();
    if (!db) return this.fallback.put(storeName, row, fallbackKeyFor(storeName));
    return this.withStore(storeName, "readwrite", (store) => store.put(row));
  }

  async delete(storeName, key) {
    const db = await this.open();
    if (!db) return this.fallback.delete(storeName, key, fallbackKeyFor(storeName));
    return this.withStore(storeName, "readwrite", (store) => store.delete(key));
  }
}

function fallbackKeyFor(storeName) {
  if (["contracts", "terminatedContracts", "sourceTerminations", "sourceReversions", "sourceExceptions"].includes(storeName)) return "contractId";
  if (storeName === "treatmentReviews") return "caseId";
  if (storeName === "settings") return "key";
  return "id";
}
