/* ─────────────────────────────────────────────────────────
   Account pagina & Trade Modal logica
   ───────────────────────────────────────────────────────── */

// ── State ────────────────────────────────────────────────────
let tradeActiveTicker   = null;
let tradeActiveName     = null;
let tradeActivePrice    = null;
let tradeActiveT212Key  = null; // Trading 212 instrument ticker
let tradeSide           = "BUY";


async function saveApiSettings() {
  const key    = document.getElementById("t212-api-key").value.trim();
  const secret = document.getElementById("t212-api-secret").value.trim();
  const env    = document.getElementById("t212-env").value;
  if (!key || !secret) {
    showStatus("Voer zowel de API-sleutel-id als de geheime sleutel in.", "err");
    return;
  }
  T212.setApiKey(key);
  T212.setApiSecret(secret);
  T212.setEnv(env);
  // Sla ook op in server-DB zodat de instellingen op elk apparaat beschikbaar zijn
  try {
    await Auth.saveSettings({ t212_key: key, t212_secret: secret, t212_env: env });
  } catch (e) {
    console.warn("[account] Kon instellingen niet opslaan op server:", e);
  }
  showStatus("Instellingen opgeslagen.", "ok");

  // Start volledige CSV fetch alleen als er nog geen cache is (nieuwe verbinding)
  const csvCheck = await fetch("/proxy/user/csv", {
    headers: { "X-Auth-Token": Auth.getToken() },
  }).catch(() => null);
  if (!csvCheck || !csvCheck.ok || (await csvCheck.clone().text()).trim() === "") {
    showStatus("Instellingen opgeslagen. Historische CSV wordt opgehaald op de achtergrond...", "ok");
    fetch("/proxy/user/csv/full", {
      method: "POST",
      headers: { "X-Auth-Token": Auth.getToken() },
    }).catch(() => {});
  }
}

async function testConnection() {
  if (!T212.isConfigured()) {
    showStatus("Sla eerst een API-sleutel op.", "err");
    return;
  }
  showStatus("Verbinding testen...", "info");
  try {
    const data = await T212.getCash();
    showStatus(
      `Verbinding geslaagd! Beschikbaar saldo: ${formatCurrency(data.free, data.currency || "EUR")}`,
      "ok"
    );
    showAccountInfo(data);
  } catch (e) {
    showStatus(`Verbinding mislukt: ${e.message}`, "err");
  }
}

function clearApiSettings() {
  T212.setApiKey("");
  T212.setApiSecret("");
  document.getElementById("t212-api-key").value    = "";
  document.getElementById("t212-api-secret").value = "";
  document.getElementById("t212-account-info").style.display = "none";
  showStatus("API-sleutels verwijderd.", "info");
}

async function showAccountInfo() {
  const section = document.getElementById("t212-account-info");
  section.style.display = "block";

  // Laad altijd uit gecachede DB — wordt bijgewerkt om 8:00, 12:00 en 17:00
  try {
    const res = await fetch("/proxy/user/positions", {
      headers: { "X-Auth-Token": Auth.getToken() },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById("t212-cash-info").innerHTML =
        `<span style="color:var(--muted);font-size:12px">${err.error || "Nog geen data. Wacht op de volgende refresh (8:00, 12:00 of 17:00)."}</span>`;
      document.getElementById("t212-positions-list").innerHTML = "";
      document.getElementById("t212-orders-list").innerHTML = "";
      return;
    }
    const cache = await res.json();
    const cashData    = cache.cash      || {};
    const positions   = cache.positions || [];
    const fetchedAt   = cache.fetched_at ? new Date(cache.fetched_at).toLocaleString("nl-NL") : "onbekend";

    const grid = document.getElementById("t212-cash-info");
    grid.innerHTML = `
      <div class="account-info-card">
        <div class="account-info-card-label">Vrij saldo</div>
        <div class="account-info-card-value">${formatCurrency(cashData.free, cashData.currency)}</div>
      </div>
      <div class="account-info-card">
        <div class="account-info-card-label">Totaal saldo</div>
        <div class="account-info-card-value">${formatCurrency(cashData.total, cashData.currency)}</div>
      </div>
      <div class="account-info-card">
        <div class="account-info-card-label">Geblokkeerd</div>
        <div class="account-info-card-value">${formatCurrency(cashData.blocked || 0, cashData.currency)}</div>
      </div>
      <div class="account-info-card" style="grid-column:1/-1">
        <div class="account-info-card-label">Laatste update</div>
        <div class="account-info-card-value" style="font-size:12px;color:var(--muted)">${fetchedAt}</div>
      </div>
    `;

    renderCachedPositions(positions);
  } catch (e) {
    document.getElementById("t212-cash-info").innerHTML =
      `<span style="color:var(--red);font-size:12px">Fout: ${e.message}</span>`;
  }

  loadOrders();
}

function renderCachedPositions(positions) {
  const container = document.getElementById("t212-positions-list");
  if (!positions || positions.length === 0) {
    container.innerHTML = `<span style="color:var(--muted);font-size:12px">Geen open posities.</span>`;
    return;
  }

  const totalValue = positions.reduce((s, p) => s + ((p.currentPrice || 0) * (p.quantity || 0)), 0);

  const rows = positions
    .slice()
    .sort((a, b) => (b.currentPrice * b.quantity) - (a.currentPrice * a.quantity))
    .map(p => {
      const value    = (p.currentPrice || 0) * (p.quantity || 0);
      const ppl      = p.ppl ?? ((p.currentPrice - p.averagePrice) * p.quantity);
      const pplPct   = p.averagePrice > 0 ? ((p.currentPrice - p.averagePrice) / p.averagePrice) * 100 : null;
      const pplCls   = ppl >= 0 ? "pos" : "neg";
      const pplSign  = ppl >= 0 ? "+" : "";
      const allocPct = totalValue > 0 ? (value / totalValue * 100).toFixed(1) : "—";

      return `
        <div class="t212-position-row">
          <div class="t212-pos-ticker">${p.ticker}</div>
          <div class="t212-pos-detail">
            <span class="t212-pos-qty">${p.quantity} aand.</span>
            <span class="t212-pos-avg">gem. ${formatCurrency(p.averagePrice, p.currency)}</span>
          </div>
          <div class="t212-pos-right">
            <span class="t212-pos-value">${formatCurrency(value, p.currency)}</span>
            <span class="t212-pos-alloc">${allocPct}%</span>
            <span class="t212-pos-ppl ${pplCls}">${pplSign}${formatCurrency(ppl, p.currency)}${pplPct !== null ? ` (${pplSign}${pplPct.toFixed(2)}%)` : ""}</span>
          </div>
        </div>`;
    }).join("");

  const totalPpl     = positions.reduce((s, p) => s + (p.ppl ?? (p.currentPrice - p.averagePrice) * p.quantity), 0);
  const totalPplCls  = totalPpl >= 0 ? "pos" : "neg";
  const totalPplSign = totalPpl >= 0 ? "+" : "";

  container.innerHTML = `
    <div class="t212-positions-table">
      <div class="t212-pos-header">
        <span>Positie</span><span></span>
        <div class="t212-pos-right"><span>Waarde</span><span>Alloc</span><span>Winst/Verlies</span></div>
      </div>
      ${rows}
      <div class="t212-pos-total">
        <span style="font-weight:700">Totaal</span><span></span>
        <div class="t212-pos-right">
          <span style="font-weight:700">${formatCurrency(totalValue)}</span>
          <span>100%</span>
          <span class="${totalPplCls}" style="font-weight:700">${totalPplSign}${formatCurrency(totalPpl)}</span>
        </div>
      </div>
    </div>`;
}


async function loadOrders() {
  const container = document.getElementById("t212-orders-list");
  container.innerHTML = `<span style="color:var(--muted);font-size:12px">Laden...</span>`;
  try {
    const orders = await T212.getOrders();
    if (!orders || orders.length === 0) {
      container.innerHTML = `<span style="color:var(--muted);font-size:12px">Geen open orders.</span>`;
      return;
    }
    container.innerHTML = orders.map(o => `
      <div class="account-order-row">
        <span style="font-weight:700;color:${o.filledQuantity > 0 ? 'var(--green)' : 'var(--text)'}">${o.ticker}</span>
        <span style="color:var(--muted)">${o.type} · ${o.side} · ${o.quantity} aand.</span>
        ${o.limitPrice ? `<span style="color:var(--blue-lt)">@ ${o.limitPrice}</span>` : ""}
        <button class="account-order-cancel" onclick="cancelOrder('${o.id}')">Annuleren</button>
      </div>
    `).join("");
  } catch (e) {
    container.innerHTML = `<span style="color:var(--red);font-size:12px">Fout: ${e.message}</span>`;
  }
}

async function cancelOrder(orderId) {
  try {
    await T212.cancelOrder(orderId);
    loadOrders();
  } catch (e) {
    alert("Annuleren mislukt: " + e.message);
  }
}

function showStatus(msg, type = "info") {
  const el = document.getElementById("t212-status");
  el.textContent = msg;
  el.className = `account-status ${type}`;
  el.classList.remove("hidden");
}

// ── Trade Modal ───────────────────────────────────────────────
function openTradeModal(ticker, name, price) {
  if (!T212.isConfigured()) {
    alert("Stel eerst je Trading 212 API-sleutel in op de Account pagina.");
    return;
  }

  tradeActiveTicker  = ticker;
  tradeActiveName    = name;
  tradeActivePrice   = price;
  tradeSide          = "BUY";

  document.getElementById("trade-modal-ticker").textContent = ticker;
  document.getElementById("trade-modal-name").textContent   = name || "";
  document.getElementById("trade-modal-price").textContent  = price ? `€${price.toFixed(2)}` : "—";

  // Reset formulier
  document.getElementById("trade-qty").value          = "";
  document.getElementById("trade-limit-price").value  = price ? price.toFixed(2) : "";
  document.getElementById("trade-order-type").value   = "market";
  document.getElementById("trade-limit-row").classList.add("hidden");
  document.getElementById("trade-total").textContent  = "—";
  document.getElementById("trade-result").classList.add("hidden");
  document.getElementById("trade-result").textContent = "";

  // Live waarschuwing
  const warn = document.getElementById("trade-env-warning");
  if (T212.getEnv() === "live") {
    warn.classList.remove("hidden");
  } else {
    warn.classList.add("hidden");
  }

  // Knoppen
  document.getElementById("trade-buy-btn").classList.add("active");
  document.getElementById("trade-sell-btn").classList.remove("active");

  document.getElementById("trade-modal-overlay").classList.remove("hidden");
  document.getElementById("trade-qty").focus();
}

function closeTradeModal(event) {
  if (event && event.target !== document.getElementById("trade-modal-overlay")) return;
  document.getElementById("trade-modal-overlay").classList.add("hidden");
}

function setTradeSide(side) {
  tradeSide = side;
  document.getElementById("trade-buy-btn").classList.toggle("active",  side === "BUY");
  document.getElementById("trade-sell-btn").classList.toggle("active", side === "SELL");
  updateTradeTotal();
}

function onOrderTypeChange() {
  const type = document.getElementById("trade-order-type").value;
  document.getElementById("trade-limit-row").classList.toggle("hidden", type !== "limit");
  updateTradeTotal();
}

function updateTradeTotal() {
  const qty = parseFloat(document.getElementById("trade-qty").value) || 0;
  const type = document.getElementById("trade-order-type").value;
  let price = tradeActivePrice;
  if (type === "limit") {
    price = parseFloat(document.getElementById("trade-limit-price").value) || price;
  }
  if (qty > 0 && price) {
    document.getElementById("trade-total").textContent = formatCurrency(qty * price, "EUR");
  } else {
    document.getElementById("trade-total").textContent = "—";
  }
}

async function submitTrade() {
  const qty  = parseFloat(document.getElementById("trade-qty").value);
  const type = document.getElementById("trade-order-type").value;
  const resultEl = document.getElementById("trade-result");

  if (!qty || qty <= 0) {
    showTradeResult("Voer een geldig aantal aandelen in.", "err");
    return;
  }

  // Bepaal het Trading 212 instrument ticker op basis van Yahoo ticker
  const t212Ticker = resolveT212Ticker(tradeActiveTicker);
  if (!t212Ticker) {
    showTradeResult(
      `Kan ticker "${tradeActiveTicker}" niet automatisch vertalen naar Trading 212 formaat. ` +
      `Controleer de instrumentnaam handmatig in je Trading 212 app.`,
      "err"
    );
    return;
  }

  const btn = document.getElementById("trade-submit-btn");
  btn.disabled = true;
  btn.textContent = "Bezig...";
  resultEl.classList.add("hidden");

  try {
    let order;
    if (type === "market") {
      order = await T212.placeMarketOrder(t212Ticker, qty, tradeSide);
    } else {
      const limitPrice = parseFloat(document.getElementById("trade-limit-price").value);
      if (!limitPrice || limitPrice <= 0) {
        showTradeResult("Voer een geldige limietprijs in.", "err");
        return;
      }
      order = await T212.placeLimitOrder(t212Ticker, qty, tradeSide, limitPrice);
    }

    const sideLabel = tradeSide === "BUY" ? "Koop" : "Verkoop";
    showTradeResult(
      `${sideLabel}order geplaatst! Order ID: ${order.id || "—"} · Status: ${order.status || "ingediend"}`,
      "ok"
    );
  } catch (e) {
    showTradeResult(`Order mislukt: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Order plaatsen";
  }
}

function showTradeResult(msg, type) {
  const el = document.getElementById("trade-result");
  el.textContent = msg;
  el.className = `account-status ${type}`;
  el.classList.remove("hidden");
}

/**
 * Vertaalt Yahoo Finance ticker naar Trading 212 instrument ticker.
 * Trading 212 gebruikt een eigen intern ticker-systeem.
 * Dit is een best-effort mapping; voor nauwkeurigheid gebruik T212.searchInstrument().
 */
function resolveT212Ticker(yahooTicker) {
  if (!yahooTicker) return null;

  // Europese tickers: verwijder suffix en voeg markt toe
  const suffixMap = {
    ".AS": "_AMS_EQ",   // Amsterdam (AEX)
    ".DE": "_XETR_EQ",  // XETRA (DAX)
    ".PA": "_EPA_EQ",   // Parijs (CAC40)
  };

  for (const [suffix, t212suffix] of Object.entries(suffixMap)) {
    if (yahooTicker.endsWith(suffix)) {
      const base = yahooTicker.slice(0, -suffix.length);
      return base + t212suffix;
    }
  }

  // US tickers: gewoon _US_EQ
  return yahooTicker + "_US_EQ";
}

// ── Geschiedenis pagina ───────────────────────────────────────
let _allTransactions  = [];
let _allDividends     = [];
let _txPageSize       = 25;
let _txShown          = 0;
let _geschTabInited   = false;

async function _loadFromDb() {
  try {
    // Data is al geladen via authOnSuccess — toon alleen de status als er data is
    if (_allTransactions.length === 0 && _allDividends.length === 0) return;

    const statusEl = document.getElementById("gesch-csv-status");
    statusEl.innerHTML = `<div class="account-status ok">${_allTransactions.length} transacties en ${_allDividends.length} dividenden geladen.</div>`;

    _txShown = 0;
    document.getElementById("gesch-tx-list").innerHTML = "";
    renderMoreTransactions();
    renderDividends();
    updateGeschStats();
    console.log(`[DB] Geladen: ${_allTransactions.length} transacties, ${_allDividends.length} dividenden.`);
  } catch (e) {
    console.warn("[DB] Laden mislukt:", e);
  }
}

function initGeschiedenisTab() {
  document.getElementById("gesch-tx-more").addEventListener("click", renderMoreTransactions);
  document.getElementById("gesch-search").addEventListener("input", filterTransactions);
  document.getElementById("gesch-filter-side").addEventListener("change", filterTransactions);
  document.getElementById("gesch-filter-broker").addEventListener("change", filterTransactions);
}

// ── Gecombineerde fetch voor alle geconfigureerde brokers ─────
async function fetchAllBrokersViaApi() {
  const hasT212   = T212.isConfigured();
  const hasDegiro = DEGIRO.isConfigured();

  if (!hasT212 && !hasDegiro) {
    alert("Stel eerst je broker-instellingen in op de Account pagina.");
    return;
  }

  // Reset huidige data
  _allTransactions = [];
  _allDividends    = [];

  if (hasT212)   await fetchCsvViaApi();
  if (hasDegiro) await fetchDegiroViaApi();

  // Sorteer alles samen op datum
  _allTransactions.sort((a, b) => new Date(b.dateModified) - new Date(a.dateModified));
  _allDividends.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Sla op in server-DB (beschikbaar op elk apparaat)
  try {
    await Auth.saveTransactions(_allTransactions);
    await Auth.saveDividends(_allDividends);
    console.log(`[DB] Opgeslagen: ${_allTransactions.length} transacties, ${_allDividends.length} dividenden.`);
  } catch (e) {
    console.warn("[DB] Opslaan mislukt:", e);
  }

  _txShown = 0;
  document.getElementById("gesch-tx-list").innerHTML = "";
  renderMoreTransactions();
  renderDividends();
  updateGeschStats();
}

async function fetchCsvViaApi() {
  if (!T212.isConfigured()) return;
  const btn      = document.getElementById("gesch-api-fetch-btn");
  const progress = document.getElementById("gesch-api-progress");
  const status   = document.getElementById("gesch-csv-status");

  btn.disabled = true;
  btn.textContent = "Bezig...";
  progress.classList.remove("hidden");
  status.innerHTML = "";

  try {
    // Stap 1: bepaal startjaar uit cache; zonder cache begin vanaf 2016 (T212 oprichting)
    const T212_START = 2016;
    let startYear    = T212_START;
    const cached     = T212.getFirstOrderDateCached();

    if (cached && cached.getFullYear() > 2000) {
      startYear = Math.max(T212_START, cached.getFullYear());
      progress.textContent = `Eerste transactie: ${cached.toLocaleDateString("nl-NL")} (uit cache). Start vanaf ${startYear}.`;
      await new Promise(r => setTimeout(r, 600));
    } else {
      progress.textContent = `Geen gecachte datum — ophalen vanaf ${T212_START}.`;
      await new Promise(r => setTimeout(r, 400));
    }

    const endYear = new Date().getFullYear();

    // Stap 2: bouw jaarperiodes op — nieuwste jaar eerst
    // TODO: tijdelijk beperkt tot 2025-2026 voor testdoeleinden — verwijder deze regel voor productie
    startYear = Math.max(startYear, 2025);

    const periods = [];
    for (let y = endYear; y >= startYear; y--) {
      periods.push({
        from: `${y}-01-01T00:00:00Z`,
        to:   `${y}-12-31T23:59:59Z`,
        year: y,
      });
    }

    progress.textContent = `Eerste transactie in ${startYear}. ${periods.length} export(s) aanvragen...`;
    await new Promise(r => setTimeout(r, 1000));

    const allCsvLines = [];
    let headerSaved = null;
    let anySuccess  = false;
    const yearLog   = [];

    // Haal bestaande exports op zodat we die kunnen hergebruiken
    let existingExports = [];
    try {
      const ex  = await T212.getExports();
      existingExports = Array.isArray(ex) ? ex : (ex?.items || []);
      progress.textContent = `${existingExports.length} bestaande export(s) gevonden.`;
      await new Promise(r => setTimeout(r, 500));
    } catch (_) {}

    for (let i = 0; i < periods.length; i++) {
      const { from, to, year } = periods[i];
      progress.textContent = `Export aanvragen voor ${year}... (${i+1}/${periods.length})`;

      // Kijk of er al een export klaar staat voor dit jaar (downloadLink aanwezig)
      const existing = existingExports.find(e => {
        const link = e.downloadLink || e.url || "";
        return link.includes(`from_${year}`) || link.includes(`_${year}-`);
      });
      if (existing?.downloadLink || existing?.url) {
        const link = existing.downloadLink || existing.url;
        progress.textContent = `Bestaande export hergebruiken voor ${year}...`;
        try {
          const csvText   = await T212.downloadCsvByLink(link);
          const lines     = csvText.trim().split("\n");
          const dataLines = lines.slice(1).filter(l => l.trim());
          if (!headerSaved && lines.length > 0) headerSaved = lines[0];
          allCsvLines.push(...dataLines);
          anySuccess = true;
          yearLog.push(`${year}: ${dataLines.length} rijen (hergebruikt)`);
          continue;
        } catch (_) {}
      }

      let exportReq, reportId;
      try {
        exportReq = await T212.requestCsvExport("ALL", from, to);
        reportId  = exportReq?.reportId ?? exportReq?.id;
        if (!reportId) throw new Error(`Geen reportId (response: ${JSON.stringify(exportReq)?.slice(0,100)})`);
      } catch (err) {
        const msg = `${year}: POST mislukt — ${err.message}`;
        yearLog.push(msg);
        progress.textContent = msg;
        status.innerHTML = `<div class="account-status err">${yearLog.join("<br>")}</div>`;
        continue;
      }

      // Poll tot klaar (max 6 min), poll elke 22s (proxy throttelt GET op 20s)
      let csvText = null;
      try {
        for (let p = 0; p < 16; p++) {
          await new Promise(r => setTimeout(r, 22000));
          const exports = await T212.getExports();
          const list    = Array.isArray(exports) ? exports : (exports?.items || []);
          const report  = list.find(e => (e.reportId ?? e.id) === reportId);
          const link    = report?.downloadLink || report?.url;
          progress.textContent = `Wachten op export ${year}... poll ${p+1}/16 (reportId=${reportId}, gevonden=${!!report}, link=${!!link})`;
          if (link) {
            progress.textContent = `Downloaden ${year}...`;
            csvText = await T212.downloadCsvByLink(link);
            break;
          }
        }
      } catch (err) {
        yearLog.push(`${year}: poll/download fout — ${err.message}`);
        status.innerHTML = `<div class="account-status err">${yearLog.join("<br>")}</div>`;
        continue;
      }

      if (csvText) {
        const lines     = csvText.trim().split("\n");
        const dataLines = lines.slice(1).filter(l => l.trim());
        if (!headerSaved && lines.length > 0) headerSaved = lines[0];
        allCsvLines.push(...dataLines);
        anySuccess = true;
        yearLog.push(`${year}: ${dataLines.length} rijen`);
      } else {
        yearLog.push(`${year}: timeout (geen downloadLink na 16 polls)`);
        status.innerHTML = `<div class="account-status err">${yearLog.join("<br>")}</div>`;
      }
    }

    if (!anySuccess || !headerSaved) {
      throw new Error(`Geen data ontvangen.<br>${yearLog.join("<br>")}`);
    }

    const combined = [headerSaved, ...allCsvLines].join("\n");
    document.getElementById("gesch-csv-label-text").textContent = `export ${startYear}–${endYear} (via API)`;
    document.getElementById("gesch-csv-clear").style.display = "inline-block";
    parseCsvAppend(combined);  // voeg toe aan bestaande data

  } catch (e) {
    status.innerHTML = `<div class="account-status err">T212 fout: ${e.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Ophalen via API";
    progress.classList.add("hidden");
  }
}

// ── DEGIRO via API ────────────────────────────────────────────
async function fetchDegiroViaApi() {
  const progress = document.getElementById("gesch-api-progress");
  const status   = document.getElementById("gesch-csv-status");

  try {
    progress.classList.remove("hidden");
    progress.textContent = "DEGIRO: inloggen...";

    // Inloggen (haalt sessie op)
    await DEGIRO.login();

    progress.textContent = "DEGIRO: transacties ophalen...";
    const rawTx = await DEGIRO.getAllTransactions(2014);

    const transactions = rawTx.map(tx => ({
      dateModified:   tx.date || tx.created || "",
      ticker:         tx.productInfo?.symbol || tx.id || "—",
      name:           tx.productInfo?.name || tx.product || "—",
      side:           tx.buysell === "B" ? "BUY" : "SELL",
      filledQuantity: Math.abs(tx.quantity || 0),
      fillPrice:      tx.price || 0,
      total:          Math.abs(tx.totalInBaseCurrency || tx.total || 0),
      currency:       tx.currency || "EUR",
      status:         "FILLED",
      broker:         "DEGIRO",
    }));

    _allTransactions.push(...transactions);

    progress.textContent = "DEGIRO: dividenden ophalen...";
    const rawDiv = await DEGIRO.getDividends(2014);

    const dividends = rawDiv.map(d => ({
      date:   d.date || d.valueDate || "",
      ticker: "—",
      name:   d.description || "Dividend",
      gross:  Math.abs(d.change || 0),
      tax:    0,
      net:    Math.abs(d.change || 0),
      broker: "DEGIRO",
    }));

    _allDividends.push(...dividends);

    status.innerHTML = `<div class="account-status ok">DEGIRO: ${transactions.length} transacties en ${dividends.length} dividenden geladen.</div>`;
  } catch (e) {
    status.innerHTML = (status.innerHTML || "") + `<div class="account-status err">DEGIRO fout: ${e.message}</div>`;
  } finally {
    progress.classList.add("hidden");
  }
}

// ── DEGIRO account-knoppen ────────────────────────────────────
function saveDegiroSettings() {
  const user = document.getElementById("degiro-username").value.trim();
  const pass = document.getElementById("degiro-password").value;
  if (!user || !pass) {
    showDegiroStatus("Voer gebruikersnaam én wachtwoord in.", "err");
    return;
  }
  DEGIRO.setUsername(user);
  DEGIRO.setPassword(pass);
  showDegiroStatus("Instellingen opgeslagen.", "ok");
}

async function testDegiroConnection() {
  if (!DEGIRO.isConfigured()) {
    showDegiroStatus("Sla eerst je inloggegevens op.", "err");
    return;
  }
  showDegiroStatus("Verbinding testen...", "info");
  try {
    await DEGIRO.login();
    showDegiroStatus("Verbinding geslaagd! Je bent ingelogd bij DEGIRO.", "ok");
  } catch (e) {
    showDegiroStatus(`Inloggen mislukt: ${e.message}`, "err");
  }
}

function clearDegiroSettings() {
  DEGIRO.clearCredentials();
  document.getElementById("degiro-username").value = "";
  document.getElementById("degiro-password").value = "";
  showDegiroStatus("Inloggegevens verwijderd.", "info");
}

function showDegiroStatus(msg, type) {
  const el = document.getElementById("degiro-status");
  el.textContent = msg;
  el.className = `account-status ${type}`;
  el.classList.remove("hidden");
}

// parseCsv: vervangt alle data (gebruikt bij handmatige CSV-upload)
function parseCsv(text) {
  _allTransactions = [];
  _allDividends    = [];
  parseCsvAppend(text, true);
}

// parseCsvAppend: voegt toe aan bestaande data (gebruikt bij API-fetch per broker)
function parseCsvAppend(text, andRender = false) {
  const lines  = text.trim().split("\n");
  const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());

  const transactions = [];
  const dividends    = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 3) continue;
    const row = {};
    header.forEach((h, idx) => { row[h] = (cols[idx] || "").replace(/^"|"$/g, "").trim(); });

    // Bepaal type rij — T212 CSV heeft een "action" kolom
    const action = (row["action"] || row["type"] || "").toLowerCase();

    if (action.includes("dividend")) {
      dividends.push({
        date:        row["time"] || row["date"] || "",
        ticker:      row["ticker"] || row["isin"] || "—",
        name:        row["name"] || "",
        gross:       parseFloat(row["total (eur)"] || row["gross amount (eur)"] || row["amount"] || 0),
        tax:         parseFloat(row["withholding tax (eur)"] || row["tax"] || 0),
        net:         parseFloat(row["total (eur)"] || row["net amount (eur)"] || row["amount"] || 0),
        broker:      "Trading 212",
      });
    } else if (action.includes("buy") || action.includes("sell") || action.includes("market") || action.includes("limit")) {
      const side = action.includes("sell") ? "SELL" : "BUY";
      transactions.push({
        dateModified:    row["time"] || row["date"] || "",
        ticker:          row["ticker"] || row["isin"] || "—",
        name:            row["name"] || "",
        side,
        filledQuantity:  parseFloat(row["no. of shares"] || row["shares"] || row["quantity"] || 0),
        fillPrice:       parseFloat(row["price / share"] || row["price"] || 0),
        total:           parseFloat(row["total (eur)"] || row["total"] || 0),
        currency:        row["currency (price / share)"] || row["currency"] || "EUR",
        status:          "FILLED",
        broker:          "Trading 212",
      });
    }
  }

  // Voeg toe aan bestaande data
  _allTransactions.push(...transactions);
  _allDividends.push(...dividends);

  // Cache vroegste T212-datum
  if (transactions.length > 0) {
    const sorted   = [...transactions].sort((a, b) => new Date(a.dateModified) - new Date(b.dateModified));
    const earliest = new Date(sorted[0].dateModified);
    if (!T212.getFirstOrderDateCached() && earliest.getFullYear() > 2000) {
      T212.setFirstOrderDateCached(earliest);
    }
  }

  if (andRender) {
    _allTransactions.sort((a, b) => new Date(b.dateModified) - new Date(a.dateModified));
    _allDividends.sort((a, b) => new Date(b.date) - new Date(a.date));
    const statusEl = document.getElementById("gesch-csv-status");
    statusEl.innerHTML = `<div class="account-status ok">${_allTransactions.length} transacties en ${_allDividends.length} dividend betalingen geladen.</div>`;
    _txShown = 0;
    document.getElementById("gesch-tx-list").innerHTML = "";
    renderMoreTransactions();
    renderDividends();
    updateGeschStats();
  }
}

function splitCsvLine(line) {
  const result = [];
  let cur = "", inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === "," && !inQuote) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function filterTransactions() {
  _txShown = 0;
  document.getElementById("gesch-tx-list").innerHTML = "";
  renderMoreTransactions();
}

function getFilteredTransactions() {
  const search = document.getElementById("gesch-search")?.value.trim().toLowerCase() || "";
  const side   = document.getElementById("gesch-filter-side")?.value || "all";
  const broker = document.getElementById("gesch-filter-broker")?.value || "all";
  return _allTransactions.filter(o => {
    if (side !== "all" && o.side !== side) return false;
    if (broker !== "all" && o.broker !== broker) return false;
    if (search && !o.ticker?.toLowerCase().includes(search) && !o.name?.toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderMoreTransactions() {
  const filtered = getFilteredTransactions();
  const slice    = filtered.slice(_txShown, _txShown + _txPageSize);
  const list     = document.getElementById("gesch-tx-list");
  const moreBtn  = document.getElementById("gesch-tx-more");

  if (_txShown === 0) list.innerHTML = "";

  if (filtered.length === 0) {
    list.innerHTML = `<div class="gesch-empty">Geen transacties gevonden.</div>`;
    moreBtn.classList.add("hidden");
    return;
  }

  // Header (alleen eerste keer)
  if (_txShown === 0) {
    list.innerHTML = `
      <div class="gesch-tx-header gesch-tx-header--broker">
        <span>Datum</span>
        <span>Naam</span>
        <span>Type</span>
        <span class="right">Aantal</span>
        <span class="right">Prijs</span>
        <span class="right">Totaal</span>
        <span>Broker</span>
      </div>`;
  }

  for (const o of slice) {
    const dateStr   = o.dateModified || "";
    const date      = dateStr ? new Date(dateStr).toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const time      = dateStr ? new Date(dateStr).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "";
    const name      = o.name || o.ticker || "—";
    const side      = o.side || "—";
    const qty       = o.filledQuantity ?? "—";
    const price     = o.fillPrice ?? null;
    const total     = Math.abs(o.total) || (price && qty !== "—" ? price * qty : null);
    const sideCls   = side === "BUY" ? "gesch-buy" : side === "SELL" ? "gesch-sell" : "";
    const sideLabel = side === "BUY" ? "Kopen" : side === "SELL" ? "Verkopen" : side;
    const broker    = o.broker || "—";
    const brokerCls = broker === "Trading 212" ? "broker-t212" : broker === "DEGIRO" ? "broker-degiro" : "";

    list.insertAdjacentHTML("beforeend", `
      <div class="gesch-tx-row gesch-tx-row--broker">
        <span class="gesch-date">${date}<br><small>${time}</small></span>
        <span class="gesch-ticker" title="${name}">${name.length > 20 ? name.slice(0,20)+"…" : name}</span>
        <span class="gesch-side ${sideCls}">${sideLabel}</span>
        <span class="right">${typeof qty === "number" ? qty.toFixed(4) : qty}</span>
        <span class="right">${price ? formatCurrency(price, o.currency) : "—"}</span>
        <span class="right" style="font-weight:600">${total ? formatCurrency(total) : "—"}</span>
        <span class="gesch-broker ${brokerCls}">${broker}</span>
      </div>`);
  }

  _txShown += slice.length;
  moreBtn.classList.toggle("hidden", _txShown >= filtered.length);
}

function renderDividends() {
  const list = document.getElementById("gesch-div-list");
  if (_allDividends.length === 0) {
    list.innerHTML = `<div class="gesch-empty">Geen dividend gevonden.</div>`;
    return;
  }
  const totalDiv = _allDividends.reduce((s, d) => s + (d.net || 0), 0);
  list.innerHTML = `
    <div class="gesch-div-total">Totaal ontvangen dividend: <strong>${formatCurrency(totalDiv)}</strong></div>
    <div class="gesch-tx-header" style="grid-template-columns:110px 1fr 90px 90px 100px 90px">
      <span>Datum</span><span>Naam</span>
      <span class="right">Bruto</span><span class="right">Belasting</span>
      <span class="right">Netto</span><span>Broker</span>
    </div>
    ${_allDividends.map(d => {
      const date      = d.date ? new Date(d.date).toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" }) : "—";
      const broker    = d.broker || "—";
      const brokerCls = broker === "Trading 212" ? "broker-t212" : broker === "DEGIRO" ? "broker-degiro" : "";
      return `
        <div class="gesch-tx-row" style="grid-template-columns:110px 1fr 90px 90px 100px 90px">
          <span class="gesch-date">${date}</span>
          <span class="gesch-ticker">${d.name || d.ticker}</span>
          <span class="right">${formatCurrency(d.gross)}</span>
          <span class="right neg">${d.tax > 0 ? "-" + formatCurrency(d.tax) : "—"}</span>
          <span class="right pos" style="font-weight:600">${formatCurrency(d.net)}</span>
          <span class="gesch-broker ${brokerCls}">${broker}</span>
        </div>`;
    }).join("")}`;
}

function updateGeschStats() {
  const stats = document.getElementById("gesch-stats");
  if (!stats) return;

  const buys    = _allTransactions.filter(o => o.side === "BUY");
  const sells   = _allTransactions.filter(o => o.side === "SELL");
  const totBuy  = buys.reduce((s, o)  => s + Math.abs(o.total || (o.fillPrice * o.filledQuantity) || 0), 0);
  const totSell = sells.reduce((s, o) => s + Math.abs(o.total || (o.fillPrice * o.filledQuantity) || 0), 0);
  const totDiv  = _allDividends.reduce((s, d) => s + (d.net || 0), 0);

  stats.innerHTML = `
    <div class="gesch-stat-card"><div class="gesch-stat-label">Transacties</div><div class="gesch-stat-value">${_allTransactions.length}</div></div>
    <div class="gesch-stat-card"><div class="gesch-stat-label">Aankopen</div><div class="gesch-stat-value pos">${buys.length}</div></div>
    <div class="gesch-stat-card"><div class="gesch-stat-label">Verkopen</div><div class="gesch-stat-value neg">${sells.length}</div></div>
    <div class="gesch-stat-card"><div class="gesch-stat-label">Totaal gekocht</div><div class="gesch-stat-value">${formatCurrency(totBuy)}</div></div>
    <div class="gesch-stat-card"><div class="gesch-stat-label">Totaal verkocht</div><div class="gesch-stat-value">${formatCurrency(totSell)}</div></div>
    <div class="gesch-stat-card"><div class="gesch-stat-label">Totaal dividend</div><div class="gesch-stat-value pos">${formatCurrency(totDiv)}</div></div>
  `;
}

// ── Tab switching (opgeroepen vanuit app.js na laden) ─────────
let _accountTabInited = false;

function setupAccountTab() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      const accountContent    = document.getElementById("account-content");
      const geschContent      = document.getElementById("geschiedenis-content");
      const tradesContent     = document.getElementById("trades-content");
      if (tab === "account") {
        document.getElementById("main-content").classList.add("hidden");
        document.getElementById("dashboard-content").classList.add("hidden");
        if (geschContent)  geschContent.classList.add("hidden");
        if (tradesContent) tradesContent.classList.add("hidden");
        accountContent.classList.remove("hidden");
        if (!_accountTabInited) {
          _bindAccountButtons();
          _accountTabInited = true;
        }
        if (T212.isConfigured()) showAccountInfo();
      } else if (tab === "geschiedenis") {
        document.getElementById("main-content").classList.add("hidden");
        document.getElementById("dashboard-content").classList.add("hidden");
        accountContent.classList.add("hidden");
        if (tradesContent) tradesContent.classList.add("hidden");
        geschContent.classList.remove("hidden");
        if (!_geschTabInited) {
          _geschTabInited = true;
          initGeschiedenisTab();
          _loadFromDb();
        }
      } else {
        accountContent.classList.add("hidden");
        geschContent.classList.add("hidden");
      }
    });
  });
}

function _bindAccountButtons() {
  // Trading 212
  document.getElementById("t212-save-btn").addEventListener("click", saveApiSettings);
  document.getElementById("t212-test-btn").addEventListener("click", testConnection);
  document.getElementById("t212-clear-btn").addEventListener("click", clearApiSettings);
  document.getElementById("t212-sync-btn").addEventListener("click", syncAllYears);

  // Toon laatste sync datum bij laden
  loadLastSyncDate();
  document.getElementById("t212-refresh-orders").addEventListener("click", loadOrders);
  document.getElementById("t212-refresh-positions").addEventListener("click", showAccountInfo);

  // DEGIRO
  document.getElementById("degiro-save-btn").addEventListener("click", saveDegiroSettings);
  document.getElementById("degiro-test-btn").addEventListener("click", testDegiroConnection);
  document.getElementById("degiro-clear-btn").addEventListener("click", clearDegiroSettings);

  // Vul opgeslagen waarden in
  document.getElementById("t212-api-key").value    = T212.getApiKey();
  document.getElementById("t212-api-secret").value = T212.getApiSecret();
  document.getElementById("t212-env").value        = T212.getEnv();
  document.getElementById("degiro-username").value = DEGIRO.getUsername();
  // Wachtwoord niet invullen om veiligheidsredenen
}

// ── T212 sync ─────────────────────────────────────────────────

async function loadLastSyncDate() {
  const el = document.getElementById("t212-last-sync");
  if (!el) return;
  try {
    const res = await fetch("/proxy/user/csv/sync-status", {
      headers: { "X-Auth-Token": Auth.getToken() },
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.last_sync) {
      el.textContent = "Laatste sync: " + new Date(data.last_sync).toLocaleString("nl-NL");
    }
  } catch (_) {}
}

async function syncAllYears() {
  const btn    = document.getElementById("t212-sync-btn");
  const status = document.getElementById("t212-status");
  if (!T212.isConfigured()) {
    showStatus("Sla eerst een API-sleutel op.", "err");
    return;
  }
  btn.disabled = true;
  btn.textContent = "⏳";
  showStatus("Alle jaren worden opnieuw gesynchroniseerd op de achtergrond...", "ok");
  try {
    await fetch("/proxy/user/csv/full", {
      method: "POST",
      headers: { "X-Auth-Token": Auth.getToken() },
    });
    // Poll elke 5s of de sync klaar is (max 10 min)
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const res  = await fetch("/proxy/user/csv/sync-status", {
        headers: { "X-Auth-Token": Auth.getToken() },
      }).catch(() => null);
      if (res && res.ok) {
        const data = await res.json();
        if (data.last_sync) {
          const ts = new Date(data.last_sync);
          // Klaar als de sync datum binnen de laatste 30 seconden valt
          if (Date.now() - ts.getTime() < 30000 || attempts > 10) {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = "↻";
            document.getElementById("t212-last-sync").textContent =
              "Laatste sync: " + ts.toLocaleString("nl-NL");
            showStatus("Synchronisatie voltooid.", "ok");
            return;
          }
        }
      }
      if (attempts >= 120) { // 10 minuten
        clearInterval(poll);
        btn.disabled = false;
        btn.textContent = "↻";
        showStatus("Synchronisatie gestart — duurt even op de achtergrond.", "ok");
      }
    }, 5000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "↻";
    showStatus("Sync fout: " + e.message, "err");
  }
}

// ── Helper: valuta opmaak ─────────────────────────────────────
function formatCurrency(value, currency = "EUR") {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: currency || "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
