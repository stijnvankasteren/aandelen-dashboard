/* ─────────────────────────────────────────────────────────
   Trading 212 API Service
   Slaat API-sleutel op in localStorage en communiceert via
   een lokale proxy (fetch_t212_proxy.py) om CORS te omzeilen.
   ───────────────────────────────────────────────────────── */

const T212 = (() => {

  const STORAGE_KEY        = "t212_api_key";
  const STORAGE_SECRET     = "t212_api_secret";
  const STORAGE_ENV        = "t212_env"; // "demo" | "live"
  const STORAGE_FIRST_DATE = "t212_first_order_date"; // ISO string
  const PROXY_BASE         = window.location.port === "8080"
    ? "http://localhost:8081/t212"
    : "/proxy/t212";

  // ── Instellingen ──────────────────────────────────────────
  function getApiKey()    { return localStorage.getItem(STORAGE_KEY)    || ""; }
  function getApiSecret() { return localStorage.getItem(STORAGE_SECRET) || ""; }
  function getEnv()       { return localStorage.getItem(STORAGE_ENV)    || "demo"; }
  function setApiKey(k)   { localStorage.setItem(STORAGE_KEY,    k.trim()); }
  function setApiSecret(s){ localStorage.setItem(STORAGE_SECRET, s.trim()); }
  function setEnv(e)      { localStorage.setItem(STORAGE_ENV, e); }
  function isConfigured() { return getApiKey().length > 0 && getApiSecret().length > 0; }

  function getFirstOrderDateCached() {
    const v = localStorage.getItem(STORAGE_FIRST_DATE);
    return v ? new Date(v) : null;
  }
  function setFirstOrderDateCached(date) {
    localStorage.setItem(STORAGE_FIRST_DATE, date.toISOString());
  }

  // ── HTTP helper (via lokale proxy) ────────────────────────
  async function req(method, path, body = null, retries = 3) {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-T212-Key":    getApiKey(),
        "X-T212-Secret": getApiSecret(),
        "X-T212-Env":    getEnv(),
      },
    };
    if (body) opts.body = JSON.stringify(body);

    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(PROXY_BASE + path, opts);
      if (res.status === 429) {
        if (attempt < retries) {
          const wait = (attempt + 1) * 5000;
          console.log(`[T212] Rate limit, wacht ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`T212 API fout ${res.status}: ${txt}`);
      }
      return res.json();
    }
  }

  // ── Account info ──────────────────────────────────────────
  async function getCash() {
    return req("GET", "/equity/account/cash");
  }

  async function getPositions() {
    return req("GET", "/equity/portfolio");
  }

  // ── Instrument zoeken ─────────────────────────────────────
  async function searchInstrument(query) {
    return req("GET", `/equity/instruments?search=${encodeURIComponent(query)}`);
  }

  // ── Orders plaatsen ───────────────────────────────────────
  /**
   * Marktorder
   * @param {string} ticker   Trading 212 instrument ticker (bijv. "AAPL_US_EQ")
   * @param {number} quantity Aantal aandelen
   * @param {"BUY"|"SELL"} side
   */
  async function placeMarketOrder(ticker, quantity, side) {
    return req("POST", "/equity/orders/market", {
      ticker,
      quantity,
      side, // "BUY" | "SELL"
    });
  }

  /**
   * Limitorder
   * @param {string} ticker
   * @param {number} quantity
   * @param {"BUY"|"SELL"} side
   * @param {number} limitPrice
   */
  async function placeLimitOrder(ticker, quantity, side, limitPrice) {
    return req("POST", "/equity/orders/limit", {
      ticker,
      quantity,
      side,
      limitPrice,
      timeValidity: "DAY",
    });
  }

  // ── Open orders ───────────────────────────────────────────
  async function getOrders() {
    return req("GET", "/equity/orders");
  }

  async function cancelOrder(orderId) {
    return req("DELETE", `/equity/orders/${orderId}`);
  }

  // ── Transactiegeschiedenis ────────────────────────────────
  /**
   * Haalt uitgevoerde orders op (geschiedenis).
   * Trading 212 pagineert via cursor. Geeft alle pagina's terug.
   */
  /**
   * @param {number} limit - items per pagina
   * @param {function} onPage - callback(newItems, totalSoFar) na elke pagina
   */
  async function getOrderHistory(limit = 50, onPage = null) {
    const results = [];
    let cursor = null;
    while (true) {
      const path = cursor
        ? `/equity/history/orders?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `/equity/history/orders?limit=${limit}`;
      const page = await req("GET", path);
      const items = page.items || page || [];
      results.push(...items);
      if (onPage) onPage(items, results);
      if (!page.nextPagePath || items.length < limit) break;
      const match = page.nextPagePath.match(/cursor=([^&]+)/);
      if (!match) break;
      cursor = decodeURIComponent(match[1]);
      await new Promise(r => setTimeout(r, 2000));
    }
    return results;
  }

  // ── CSV Export via API ────────────────────────────────────
  /**
   * Vraagt een CSV export aan bij Trading 212.
   * @param {string} dataIncluded  "ORDERS" | "TRANSACTIONS" | "DIVIDENDS"
   * @param {string} timeFrom      ISO datum bijv. "2020-01-01T00:00:00Z"
   * @param {string} timeTo        ISO datum bijv. "2026-12-31T23:59:59Z"
   */
  async function requestCsvExport(dataIncluded = "ALL", timeFrom = "2015-01-01T00:00:00Z", timeTo = null) {
    const to = timeTo || new Date().toISOString();
    const all = dataIncluded === "ALL";
    return req("POST", "/history/exports", {
      dataIncluded: {
        includeDividends:   all || dataIncluded === "DIVIDENDS",
        includeTransactions: all || dataIncluded === "TRANSACTIONS",
        includeOrders:       all || dataIncluded === "ORDERS",
      },
      timeFrom,
      timeTo: to,
    });
  }

  /** Haal lijst van beschikbare exports op */
  async function getExports() {
    return req("GET", "/history/exports");
  }

  /** Download een CSV export via de proxy (omzeilt S3 CORS) */
  async function downloadCsvByLink(url) {
    const s3Base   = window.location.port === "8080"
      ? "http://localhost:8081/s3download"
      : "/proxy/s3download";
    const proxyUrl = `${s3Base}?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`Download mislukt: ${res.status}`);
    return res.text();
  }

  /** Download een CSV export via de proxy (fallback) */
  async function downloadCsvExport(reportId) {
    const opts = {
      method: "GET",
      headers: {
        "X-T212-Key":    getApiKey(),
        "X-T212-Secret": getApiSecret(),
        "X-T212-Env":    getEnv(),
      },
    };
    const res = await fetch(PROXY_BASE + `/history/exports/${reportId}`, opts);
    if (!res.ok) throw new Error(`Download mislukt: ${res.status}`);
    return res.text();
  }

  // ── Dividend geschiedenis ─────────────────────────────────
  async function getDividendHistory(limit = 50) {
    const results = [];
    let cursor = null;
    while (true) {
      const path = cursor
        ? `/history/dividends?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `/history/dividends?limit=${limit}`;
      const page = await req("GET", path);
      const items = page.items || page || [];
      results.push(...items);
      if (!page.nextPagePath || items.length < limit) break;
      const match = page.nextPagePath.match(/cursor=([^&]+)/);
      if (!match) break;
      cursor = decodeURIComponent(match[1]);
    }
    return results;
  }

  // ── Vroegste transactiedatum ──────────────────────────────
  /**
   * Haalt één pagina ordergeschiedenis op en geeft de vroegste datum terug
   * als Date object, of null als er geen data is.
   */
  async function getFirstOrderDate() {
    // Haal de eerste pagina op (50 meest recente orders)
    const page  = await req("GET", "/equity/history/orders?limit=50");
    const items = page?.items || (Array.isArray(page) ? page : []);
    if (items.length === 0) return null;

    // Zoek de vroegste datum in deze pagina (kan niet ouder zijn dan eerste pagina)
    // Helaas geeft T212 geen "oldest first" optie — we gebruiken deze pagina als indicatie.
    // Als er meer pagina's zijn, pagineren we door tot het einde om de echte vroegste te vinden.
    let earliest = null;
    let cursor   = null;

    const processItems = items => {
      for (const tx of items) {
        const d = new Date(tx.dateModified || tx.dateCreated || 0);
        if (d.getFullYear() > 2000 && (!earliest || d < earliest)) {
          earliest = d;
        }
      }
    };

    processItems(items);

    // Pagineer door alle pagina's om de echte vroegste te vinden
    // (elke pagina duurt ~2s door rate limiting, dus max 20 pagina's = 40s)
    let pageData = page;
    let pages    = 0;
    while (pageData?.nextPagePath && pages < 50) {
      const match = pageData.nextPagePath.match(/cursor=([^&]+)/);
      if (!match) break;
      cursor   = decodeURIComponent(match[1]);
      await new Promise(r => setTimeout(r, 2000));
      pageData = await req("GET", `/equity/history/orders?limit=50&cursor=${encodeURIComponent(cursor)}`);
      const nextItems = pageData?.items || (Array.isArray(pageData) ? pageData : []);
      processItems(nextItems);
      pages++;
    }

    return earliest;
  }

  // ── Publiek ───────────────────────────────────────────────
  return {
    getApiKey, getApiSecret, getEnv, setApiKey, setApiSecret, setEnv, isConfigured,
    getFirstOrderDateCached, setFirstOrderDateCached,
    getCash, getPositions,
    searchInstrument,
    placeMarketOrder, placeLimitOrder,
    getOrders, cancelOrder,
    getOrderHistory, getDividendHistory, getFirstOrderDate,
    requestCsvExport, getExports, downloadCsvExport, downloadCsvByLink,
  };
})();
