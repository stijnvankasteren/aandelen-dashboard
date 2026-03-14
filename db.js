/* ─────────────────────────────────────────────────────────
   PortfolioDB — IndexedDB wrapper
   Slaat transacties en dividenden op zodat ze na herstart
   van de browser beschikbaar blijven.
   ───────────────────────────────────────────────────────── */

const PortfolioDB = (() => {

  const DB_NAME    = "portfolio-analyse";
  const DB_VERSION = 1;
  const STORE_TX   = "transactions";
  const STORE_DIV  = "dividends";

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_TX)) {
          db.createObjectStore(STORE_TX, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_DIV)) {
          db.createObjectStore(STORE_DIV, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function saveTransactions(transactions) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_TX, "readwrite");
      const store = tx.objectStore(STORE_TX);
      store.clear();
      for (const item of transactions) store.add(item);
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function saveDividends(dividends) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_DIV, "readwrite");
      const store = tx.objectStore(STORE_DIV);
      store.clear();
      for (const item of dividends) store.add(item);
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function loadTransactions() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_TX, "readonly");
      const store = tx.objectStore(STORE_TX);
      const req   = store.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function loadDividends() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_DIV, "readonly");
      const store = tx.objectStore(STORE_DIV);
      const req   = store.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_TX, STORE_DIV], "readwrite");
      tx.objectStore(STORE_TX).clear();
      tx.objectStore(STORE_DIV).clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function count() {
    const db = await open();
    const [tx, div] = await Promise.all([
      new Promise((res, rej) => {
        const t = db.transaction(STORE_TX, "readonly");
        const r = t.objectStore(STORE_TX).count();
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      }),
      new Promise((res, rej) => {
        const t = db.transaction(STORE_DIV, "readonly");
        const r = t.objectStore(STORE_DIV).count();
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      }),
    ]);
    return { transactions: tx, dividends: div };
  }

  return { open, saveTransactions, saveDividends, loadTransactions, loadDividends, clear, count };
})();
