/* ─────────────────────────────────────────────────────────
   PortfolioDB — IndexedDB wrapper
   Slaat gebruikers, instellingen, transacties en dividenden op.
   ───────────────────────────────────────────────────────── */

const PortfolioDB = (() => {

  const DB_NAME    = "portfolio-analyse";
  const DB_VERSION = 2;
  const STORE_TX   = "transactions";
  const STORE_DIV  = "dividends";
  const STORE_USR  = "users";
  const STORE_SET  = "settings";

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_TX)) {
          const s = db.createObjectStore(STORE_TX, { keyPath: "id", autoIncrement: true });
          s.createIndex("userId", "userId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DIV)) {
          const s = db.createObjectStore(STORE_DIV, { keyPath: "id", autoIncrement: true });
          s.createIndex("userId", "userId", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_USR)) {
          const s = db.createObjectStore(STORE_USR, { keyPath: "id", autoIncrement: true });
          s.createIndex("username", "username", { unique: true });
        }
        if (!db.objectStoreNames.contains(STORE_SET)) {
          // keyPath = "userId_key" zodat elke gebruiker per sleutel één waarde heeft
          db.createObjectStore(STORE_SET, { keyPath: "pk" });
        }
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Gebruikers ──────────────────────────────────────────

  async function createUser(username, passwordHash) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_USR, "readwrite");
      const store = tx.objectStore(STORE_USR);
      const req   = store.add({ username, passwordHash, createdAt: new Date().toISOString() });
      req.onsuccess = e => resolve(e.target.result); // geeft userId terug
      req.onerror   = () => reject(new Error("Gebruikersnaam al in gebruik."));
    });
  }

  async function findUser(username) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_USR, "readonly");
      const store = tx.objectStore(STORE_USR);
      const idx   = store.index("username");
      const req   = idx.get(username);
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function listUsers() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_USR, "readonly");
      const req = tx.objectStore(STORE_USR).getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  // ── Instellingen per gebruiker ──────────────────────────

  async function saveSetting(userId, key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_SET, "readwrite");
      const store = tx.objectStore(STORE_SET);
      const req   = store.put({ pk: `${userId}_${key}`, userId, key, value });
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function loadSetting(userId, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_SET, "readonly");
      const store = tx.objectStore(STORE_SET);
      const req   = store.get(`${userId}_${key}`);
      req.onsuccess = e => resolve(e.target.result?.value ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function deleteUserSettings(userId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_SET, "readwrite");
      const store = tx.objectStore(STORE_SET);
      const req   = store.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        if (cursor.value.userId === userId) cursor.delete();
        cursor.continue();
      };
      req.onerror = e => reject(e.target.error);
    });
  }

  // ── Transacties per gebruiker ───────────────────────────

  async function saveTransactions(transactions, userId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_TX, "readwrite");
      const store = tx.objectStore(STORE_TX);
      // Verwijder bestaande voor deze gebruiker
      const idx = store.index("userId");
      const req = idx.openCursor(IDBKeyRange.only(userId));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else {
          // Voeg nieuwe toe
          for (const item of transactions) store.add({ ...item, userId });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function loadTransactions(userId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_TX, "readonly");
      const store = tx.objectStore(STORE_TX);
      if (userId !== undefined) {
        const req = store.index("userId").getAll(IDBKeyRange.only(userId));
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      } else {
        const req = store.getAll();
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      }
    });
  }

  // ── Dividenden per gebruiker ────────────────────────────

  async function saveDividends(dividends, userId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_DIV, "readwrite");
      const store = tx.objectStore(STORE_DIV);
      const idx   = store.index("userId");
      const req   = idx.openCursor(IDBKeyRange.only(userId));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else {
          for (const item of dividends) store.add({ ...item, userId });
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function loadDividends(userId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_DIV, "readonly");
      const store = tx.objectStore(STORE_DIV);
      if (userId !== undefined) {
        const req = store.index("userId").getAll(IDBKeyRange.only(userId));
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      } else {
        const req = store.getAll();
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      }
    });
  }

  async function clear(userId) {
    const db = await open();
    if (userId === undefined) {
      // Alles wissen (geen gebruiker opgegeven)
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_TX, STORE_DIV], "readwrite");
        tx.objectStore(STORE_TX).clear();
        tx.objectStore(STORE_DIV).clear();
        tx.oncomplete = () => resolve();
        tx.onerror    = e => reject(e.target.error);
      });
    }
    // Alleen voor deze gebruiker wissen
    await saveTransactions([], userId);
    await saveDividends([], userId);
  }

  async function count(userId) {
    const db = await open();
    const countStore = (storeName) => new Promise((res, rej) => {
      const tx  = db.transaction(storeName, "readonly");
      const req = userId !== undefined
        ? tx.objectStore(storeName).index("userId").count(IDBKeyRange.only(userId))
        : tx.objectStore(storeName).count();
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    const [transactions, dividends] = await Promise.all([
      countStore(STORE_TX),
      countStore(STORE_DIV),
    ]);
    return { transactions, dividends };
  }

  return {
    open,
    // Gebruikers
    createUser, findUser, listUsers,
    // Instellingen
    saveSetting, loadSetting, deleteUserSettings,
    // Data
    saveTransactions, loadTransactions,
    saveDividends, loadDividends,
    clear, count,
  };
})();
