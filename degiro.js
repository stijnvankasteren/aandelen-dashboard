/* ─────────────────────────────────────────────────────────
   DEGIRO API Service
   Slaat inloggegevens op in localStorage en communiceert via
   de lokale proxy (fetch_t212_proxy.py) om CORS te omzeilen.

   Endpoints gebaseerd op de inofficiële community-documentatie
   van trader.degiro.nl — zelfde endpoints als de webapp zelf.
   ───────────────────────────────────────────────────────── */

const DEGIRO = (() => {

  const STORAGE_USER = "degiro_username";
  const STORAGE_PASS = "degiro_password";
  const PROXY_BASE   = window.location.port === "8080"
    ? "http://localhost:8081/degiro"
    : "/proxy/degiro";

  // ── Instellingen ──────────────────────────────────────────
  function getUsername()    { return localStorage.getItem(STORAGE_USER) || ""; }
  function getPassword()    { return localStorage.getItem(STORAGE_PASS) || ""; }
  function setUsername(u)   { localStorage.setItem(STORAGE_USER, u.trim()); }
  function setPassword(p)   { localStorage.setItem(STORAGE_PASS, p); }
  function isConfigured()   { return getUsername().length > 0 && getPassword().length > 0; }
  function getSession()     { return localStorage.getItem("degiro_session") || null; }
  function getAccountId()   { return localStorage.getItem("degiro_account_id") || null; }
  function setSession(s)    { localStorage.setItem("degiro_session", s); }
  function setAccountId(id) { localStorage.setItem("degiro_account_id", String(id)); }

  function clearCredentials() {
    localStorage.removeItem(STORAGE_USER);
    localStorage.removeItem(STORAGE_PASS);
    localStorage.removeItem("degiro_session");
    localStorage.removeItem("degiro_account_id");
  }

  // ── HTTP helper (via proxy) ───────────────────────────────
  async function req(method, path, body = null) {
    const sid  = getSession();
    const opts = {
      method,
      headers: {
        "Content-Type":    "application/json",
        "X-Degiro-Session": sid || "",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(PROXY_BASE + path, opts);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`DEGIRO ${res.status}: ${txt.slice(0, 200)}`);
    }
    const ct = res.headers.get("Content-Type") || "";
    return ct.includes("json") ? res.json() : res.text();
  }

  // ── Inloggen ─────────────────────────────────────────────
  // POST /login/secure/login
  // Sessie-ID wordt teruggegeven in de response body (sessionId)
  // én als JSESSIONID cookie — de proxy stuurt het door als header.
  async function login() {
    const res = await fetch(PROXY_BASE + "/login/secure/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username:           getUsername(),
        password:           getPassword(),
        isPassCodeReset:    false,
        isRedirectToMobile: false,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Inloggen mislukt (${res.status}): ${txt.slice(0, 200)}`);
    }

    const data = await res.json();

    // sessionId zit in de response body
    const sid = data?.sessionId || data?.data?.sessionId;
    if (!sid) throw new Error("Geen sessie-ID ontvangen — controleer gebruikersnaam/wachtwoord.");
    setSession(sid);

    // Haal intAccount op via /pa/secure/client
    await _fetchAccountId(sid);

    return sid;
  }

  // GET /pa/secure/client?sessionId=...
  // Geeft clientId en intAccount terug
  async function _fetchAccountId(sid) {
    const data = await req("GET", `/pa/secure/client?sessionId=${sid}`);
    const id   = data?.data?.intAccount ?? data?.intAccount;
    if (id) setAccountId(id);
    return id;
  }

  // ── Account info ──────────────────────────────────────────
  // GET /trading/secure/v5/update/{intAccount};jsessionid={sid}
  async function getAccountInfo() {
    const sid = getSession();
    const aid = getAccountId();
    if (!sid || !aid) throw new Error("Niet ingelogd.");
    return req("GET",
      `/trading/secure/v5/update/${aid};jsessionid=${sid}` +
      `?portfolio=0&totalPortfolio=0&orders=0&cashFunds=0&sessionId=${sid}`
    );
  }

  // ── Posities ──────────────────────────────────────────────
  // Posities zitten in de v5/update response onder portfolio.value
  async function getPortfolio() {
    const data = await getAccountInfo();
    return data?.portfolio?.value || [];
  }

  // ── Transactiegeschiedenis ────────────────────────────────
  // GET /reporting/secure/v4/transactions
  // fromDate / toDate: "DD/MM/YYYY"
  async function getTransactions(fromDate, toDate) {
    const sid = getSession();
    const aid = getAccountId();
    if (!sid || !aid) throw new Error("Niet ingelogd.");
    const data = await req("GET",
      `/reporting/secure/v4/transactions` +
      `?fromDate=${fromDate}&toDate=${toDate}` +
      `&intAccount=${aid}&sessionId=${sid}`
    );
    return data?.data || [];
  }

  // ── Cash account rapport (inclusief dividenden) ───────────
  // GET /reporting/secure/v4/cashAccountReport
  // format=JSON geeft alle kasboekregels terug
  async function getCashReport(fromDate, toDate) {
    const sid = getSession();
    const aid = getAccountId();
    if (!sid || !aid) throw new Error("Niet ingelogd.");
    const data = await req("GET",
      `/reporting/secure/v4/cashAccountReport` +
      `?fromDate=${fromDate}&toDate=${toDate}` +
      `&intAccount=${aid}&sessionId=${sid}&format=JSON`
    );
    return data?.data || [];
  }

  // ── Alle transacties ophalen per jaar ─────────────────────
  async function getAllTransactions(fromYear = 2014) {
    const now     = new Date();
    const results = [];

    for (let y = fromYear; y <= now.getFullYear(); y++) {
      const from = `01/01/${y}`;
      const to   = y === now.getFullYear()
        ? _today()
        : `31/12/${y}`;
      try {
        const items = await getTransactions(from, to);
        results.push(...items);
        if (y < now.getFullYear()) await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.warn(`[DEGIRO] transacties ${y} overgeslagen:`, e.message);
      }
    }
    return results;
  }

  // ── Alle dividenden ophalen per jaar ──────────────────────
  async function getDividends(fromYear = 2014) {
    const now     = new Date();
    const results = [];

    for (let y = fromYear; y <= now.getFullYear(); y++) {
      const from = `01/01/${y}`;
      const to   = y === now.getFullYear() ? _today() : `31/12/${y}`;
      try {
        const items = await getCashReport(from, to);
        // Filter op dividend-regels (description bevat "dividend")
        const divs = items.filter(tx =>
          tx.description?.toLowerCase().includes("dividend")
        );
        results.push(...divs);
        if (y < now.getFullYear()) await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        console.warn(`[DEGIRO] dividenden ${y} overgeslagen:`, e.message);
      }
    }
    return results;
  }

  function _today() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  }

  // ── Publiek ───────────────────────────────────────────────
  return {
    getUsername, getPassword, setUsername, setPassword,
    isConfigured, clearCredentials,
    getSession, getAccountId,
    login, getAccountInfo, getPortfolio,
    getTransactions, getAllTransactions,
    getCashReport, getDividends,
  };
})();
