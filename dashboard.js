/* ─────────────────────────────────────────────────────────
   Portfolio Dashboard – Bloomberg Terminal Stijl
   Leest data uit dezelfde globals als app.js:
     allRankings, pricesData, newsData
   ───────────────────────────────────────────────────────── */

// ── T212 ticker → Yahoo ticker ───────────────────────────────
function t212TickerToYahoo(t212Ticker) {
  if (!t212Ticker) return t212Ticker;
  const suffixMap = {
    "_AMS_EQ":  ".AS",
    "_XETR_EQ": ".DE",
    "_EPA_EQ":  ".PA",
    "_US_EQ":   "",
  };
  for (const [t212suffix, yahooSuffix] of Object.entries(suffixMap)) {
    if (t212Ticker.endsWith(t212suffix)) {
      return t212Ticker.slice(0, -t212suffix.length) + yahooSuffix;
    }
  }
  return t212Ticker;
}

// ── Constanten ──────────────────────────────────────────────
const RISK_FREE_RATE = 0.045; // 4.5% jaarlijks risicovrij
const SECTOR_COLORS = [
  "#388bfd", "#3fb950", "#d29922", "#f85149", "#a371f7",
  "#f0883e", "#79c0ff", "#56d364", "#ff7b72", "#e3b341",
  "#8b949e", "#58a6ff"
];

// ── State ───────────────────────────────────────────────────
let dashboardInitialized = false;
let dbCharts = {};
let _dbPerfData = null;      // { labels, datasets } volledig — voor periodefiltering
let _dbPerfPeriod = "MAX";   // actieve periode
let _dbTxPortfolioValues = null; // dagelijkse portfoliowaarden op basis van echte transacties
let portfolioData = {};   // geladen uit portfolio.json
let fundamentalsData = {}; // geladen uit fundamentals.json
let benchmarkPrices = null; // ^GSPC series uit prices.json

// ── Portfolio helpers ────────────────────────────────────────

// Tickers die in allRankings zitten — voor analyses (volatiliteit, sector, P/E etc.)
function getPortfolioTickers() {
  return Object.keys(portfolioData.holdings || {}).filter(t => {
    const h = portfolioData.holdings[t];
    return h.in_universe && allRankings.find(r => r.ticker === t)?.price;
  });
}

// Gewichten op basis van T212 current_value als beschikbaar, anders Yahoo-prijs
function getPortfolioWeights(tickers) {
  const values = tickers.map(t => {
    const h = portfolioData.holdings[t];
    if (h?.current_value) return h.current_value;
    const item = allRankings.find(r => r.ticker === t);
    return (item?.price || 0) * (h?.shares || 0);
  });
  const total = values.reduce((a, b) => a + b, 0);
  return { weights: values.map(v => (total > 0 ? v / total : 0)), totalValue: total, values };
}

// Echte totaalwaarde van alle T212-posities (inclusief buiten universum)
function getT212TotalValue() {
  const holdings = portfolioData.holdings || {};
  return Object.values(holdings).reduce((s, h) => s + (h.current_value || 0), 0);
}

// Totale inlegkosten van alle T212-posities in accountvaluta (EUR)
// = huidige waarde - ppl = kostprijs in EUR
function getT212TotalCost() {
  const holdings = portfolioData.holdings || {};
  return Object.values(holdings).reduce((s, h) => {
    if (h.current_value != null && h.ppl != null) return s + (h.current_value - h.ppl);
    return s;
  }, 0);
}

// ── Wiskunde helpers ─────────────────────────────────────────
function dailyReturns(closeArr) {
  const r = [];
  for (let i = 1; i < closeArr.length; i++) {
    r.push((closeArr[i] - closeArr[i - 1]) / closeArr[i - 1]);
  }
  return r;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function annualizedVol(returns) {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const variance = returns.reduce((s, r) => s + Math.pow(r - m, 2), 0) / (returns.length - 1);
  return Math.sqrt(variance * 252);
}

function maxDrawdown(closeArr) {
  let peak = -Infinity, maxDD = 0;
  for (const p of closeArr) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function portfolioReturnsArr(tickers, weights, nDays = 252) {
  const allReturns = tickers.map(t => {
    const pd = pricesData[t];
    if (!pd || !pd.close || pd.close.length < 2) return [];
    return dailyReturns(pd.close.slice(-nDays - 1));
  });
  const minLen = Math.min(...allReturns.map(r => r.length).filter(l => l > 0));
  if (minLen <= 0) return [];
  const portReturns = [];
  for (let i = 0; i < minLen; i++) {
    let wr = 0;
    for (let j = 0; j < tickers.length; j++) {
      if (allReturns[j].length > 0) {
        wr += weights[j] * (allReturns[j][i] || 0);
      }
    }
    portReturns.push(wr);
  }
  return portReturns;
}

function portfolioCloseArr(tickers, weights, nDays = 252) {
  // Normaliseer elke serie op 100 en weeg ze samen
  const closes = tickers.map(t => {
    const pd = pricesData[t];
    if (!pd || !pd.close) return null;
    return pd.close.slice(-nDays);
  });
  const minLen = Math.min(...closes.filter(c => c !== null).map(c => c.length));
  if (minLen <= 0) return [];
  const result = [];
  for (let i = 0; i < minLen; i++) {
    let val = 0;
    for (let j = 0; j < tickers.length; j++) {
      if (closes[j]) {
        const normalized = (closes[j][i] / closes[j][0]) * 100;
        val += weights[j] * normalized;
      }
    }
    result.push(val);
  }
  return result;
}

function sharpeRatio(portReturns) {
  if (portReturns.length < 20) return null;
  const annualReturn = mean(portReturns) * 252;
  const vol = annualizedVol(portReturns);
  return vol > 0 ? (annualReturn - RISK_FREE_RATE) / vol : null;
}

function betaVsBenchmark(portReturns, benchReturns) {
  const n = Math.min(portReturns.length, benchReturns.length);
  if (n < 20) return null;
  const p = portReturns.slice(-n), b = benchReturns.slice(-n);
  const meanP = mean(p), meanB = mean(b);
  const cov = p.reduce((s, r, i) => s + (r - meanP) * (b[i] - meanB), 0) / (n - 1);
  const varB = b.reduce((s, r) => s + Math.pow(r - meanB, 2), 0) / (n - 1);
  return varB > 0 ? cov / varB : null;
}

function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  const ax = a.slice(-n), bx = b.slice(-n);
  const meanA = mean(ax), meanB = mean(bx);
  const num = ax.reduce((s, v, i) => s + (v - meanA) * (bx[i] - meanB), 0);
  const denA = ax.reduce((s, v) => s + Math.pow(v - meanA, 2), 0);
  const denB = bx.reduce((s, v) => s + Math.pow(v - meanB, 2), 0);
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

function fmtCurrency(v, currency = "USD") {
  if (v === null || v === undefined) return "—";
  const sym = currency === "EUR" ? "€" : "$";
  if (Math.abs(v) >= 1e6) return `${sym}${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${sym}${(v / 1e3).toFixed(1)}K`;
  return `${sym}${v.toFixed(2)}`;
}

function fmtPctDB(v, decimals = 1) {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : "";
  const cls = v > 0 ? "pos" : v < 0 ? "neg" : "neutral";
  return `<span class="${cls}">${sign}${v.toFixed(decimals)}%</span>`;
}

function colorForCorr(v) {
  // Negatief = rood, positief = blauw
  const abs = Math.abs(v);
  if (v >= 0) return `rgba(56, 139, 253, ${0.15 + abs * 0.75})`;
  return `rgba(248, 81, 73, ${0.15 + abs * 0.75})`;
}

// ── Dashboard: hoofd-init ────────────────────────────────────
async function initDashboard() {
  if (dashboardInitialized) return;

  // Laad fundamentals.json
  try {
    const fundRes = await fetch("data/fundamentals.json");
    fundamentalsData = fundRes.ok ? await fundRes.json() : {};
  } catch (e) {
    fundamentalsData = {};
  }

  // Laad holdings vanuit gecachede T212 posities (zelfde bron als Account-pagina)
  portfolioData = { holdings: {}, allPositions: [] };
  if (typeof T212 !== "undefined" && T212.isConfigured()) {
    try {
      const cacheRes = await fetch("/proxy/user/positions", {
        headers: { "X-Auth-Token": Auth.getToken() },
      });
      const cache = cacheRes.ok ? await cacheRes.json() : {};
      const positions = cache.positions || [];
      // Sla cash op voor totaalwaarde
      portfolioData.cash = cache.cash || {};
      if (positions && positions.length > 0) {
        // Sla ALLE posities op voor totaalwaarde-berekening
        portfolioData.allPositions = positions.filter(p => p.ticker && p.quantity > 0);
        for (const p of positions) {
          if (!p.ticker || p.quantity <= 0) continue;
          const yahooTicker = t212TickerToYahoo(p.ticker);
          // ppl is in accountvaluta (EUR); averagePrice * quantity + ppl = huidige waarde in EUR
          const costEur = (p.averagePrice || 0) * p.quantity;
          const currentValueEur = p.ppl != null ? costEur + p.ppl : null;
          portfolioData.holdings[yahooTicker] = {
            shares: p.quantity,
            avg_cost: p.averagePrice || null,
            current_price: p.currentPrice || null,
            current_value: currentValueEur,
            ppl: p.ppl ?? null,
            in_universe: !!allRankings.find(r => r.ticker === yahooTicker),
          };
        }
      }
    } catch (e) {
      // T212 niet bereikbaar — holdings blijven leeg
    }
  }

  // Fallback: bereken avg_cost uit transactiegeschiedenis als T212 geen averagePrice geeft
  if (typeof _allTransactions !== "undefined" && _allTransactions.length > 0) {
    for (const ticker of Object.keys(portfolioData.holdings)) {
      if (portfolioData.holdings[ticker].avg_cost) continue;
      const t212Ticker = typeof resolveT212Ticker === "function" ? resolveT212Ticker(ticker) : ticker;
      const buys = _allTransactions.filter(tx =>
        (tx.side === "BUY" || tx.type === "BUY") &&
        (tx.ticker === ticker || tx.ticker === t212Ticker)
      );
      if (buys.length > 0) {
        const totalShares = buys.reduce((s, tx) => s + (tx.filledQuantity || tx.quantity || 0), 0);
        const totalCost = buys.reduce((s, tx) => s + (tx.fillPrice || tx.price || 0) * (tx.filledQuantity || tx.quantity || 0), 0);
        if (totalShares > 0) portfolioData.holdings[ticker].avg_cost = totalCost / totalShares;
      }
    }
  }

  // Haal ^GSPC benchmark op uit prices.json als die er is
  benchmarkPrices = pricesData["^GSPC"] || null;

  dashboardInitialized = true;

  const tickers = getPortfolioTickers();
  const allHoldings = Object.keys(portfolioData.holdings || {});
  if (allHoldings.length === 0) {
    document.getElementById("db-no-holdings").classList.remove("hidden");
    document.getElementById("db-main-grid").classList.add("hidden");
    return;
  }
  // Toon dashboard ook als er posities zijn buiten het universum
  document.getElementById("db-no-holdings").classList.add("hidden");
  document.getElementById("db-main-grid").classList.remove("hidden");

  const { weights, totalValue, values } = getPortfolioWeights(tickers);

  renderDashboardHeader(tickers, weights, totalValue, values);
  renderHoldingsTable(tickers, weights, values);
  if (typeof T212 !== "undefined" && T212.isConfigured()) {
    await renderPerformanceChartFromT212(tickers);
  } else {
    renderPerformanceChart(tickers, weights);
  }
  renderRiskPanel(tickers, weights);
  renderSectorDonut(tickers, weights);
  renderVolatilityBars(tickers);
  renderEarningsCalendar(tickers);
  renderCorrelationMatrix(tickers);
  renderRiskSuggestions(tickers, weights);
  renderTopMovers();
}

// ── Header bar ───────────────────────────────────────────────
function renderDashboardHeader(tickers, weights, totalValue, values) {
  // Echte totaalwaarde: alle T212 posities (incl. buiten universum)
  const realTotalValue = getT212TotalValue() || totalValue;

  // Dag verandering op basis van allRankings change_1d (alleen universe tickers)
  let dayChange = 0;
  for (let i = 0; i < tickers.length; i++) {
    const item = allRankings.find(r => r.ticker === tickers[i]);
    if (!item) continue;
    const prevValue = values[i] / (1 + (item.change_1d || 0) / 100);
    dayChange += values[i] - prevValue;
  }
  // Voeg ook T212 ppl-delta toe voor posities buiten het universum (niet beschikbaar — laat weg)
  const dayChangePct = realTotalValue > 0 ? (dayChange / (realTotalValue - dayChange)) * 100 : 0;

  // Totaal rendement: echte inlegkosten vs. echte huidige waarde
  const realTotalCost = getT212TotalCost();
  const totalReturn = realTotalCost > 0 ? ((realTotalValue - realTotalCost) / realTotalCost) * 100 : null;

  // Sentiment (alleen universe tickers)
  const avgSentiment = tickers.length > 0 ? tickers.reduce((s, t) => {
    const item = allRankings.find(r => r.ticker === t);
    return s + (item?.news_sentiment_avg || 0.5);
  }, 0) / tickers.length : 0.5;
  const sentimentLabel = avgSentiment > 0.6 ? "BULLISH" : avgSentiment < 0.4 ? "BEARISH" : "NEUTRAAL";
  const sentimentClass = avgSentiment > 0.6 ? "pos" : avgSentiment < 0.4 ? "neg" : "neutral";

  document.getElementById("db-stat-value").textContent = fmtCurrency(realTotalValue, "EUR").replace("€", "€ ");
  document.getElementById("db-stat-daychange").innerHTML = fmtPctDB(dayChangePct) + ` <small>(${dayChange >= 0 ? "+" : ""}${fmtCurrency(Math.abs(dayChange), "EUR")})</small>`;
  document.getElementById("db-stat-return").innerHTML = totalReturn !== null ? fmtPctDB(totalReturn) : "—";
  document.getElementById("db-stat-sentiment").innerHTML = `<span class="${sentimentClass}" style="font-weight:700">${sentimentLabel}</span>`;
}

// ── Holdings tabel ────────────────────────────────────────────
function renderHoldingsTable(tickers, weights, values) {
  const tbody = document.getElementById("db-holdings-tbody");
  let html = "";
  // Sorteer op waarde (grootste eerst)
  const sorted = tickers.map((t, i) => ({ t, w: weights[i], v: values[i] }))
    .sort((a, b) => b.v - a.v);

  for (const { t, w, v } of sorted) {
    const item = allRankings.find(r => r.ticker === t);
    if (!item) continue;
    const sym = item.currency === "EUR" ? "€" : "$";
    const pct1d = item.change_1d;
    const cls1d = pct1d > 0 ? "pos" : pct1d < 0 ? "neg" : "neutral";
    const sign = pct1d > 0 ? "+" : "";
    const hasKey = typeof T212 !== "undefined" && T212.isConfigured();
    const tradeBtnCls = hasKey ? "trade-btn" : "trade-btn no-key";
    const tradeBtnTitle = hasKey ? "Trade via Trading 212" : "Stel eerst een API-sleutel in op de Account pagina";
    const tradeOnClick = hasKey
      ? `openTradeModal('${t}', '${(item.name || t).replace(/'/g, "\\'")}', ${item.price})`
      : "";
    html += `
      <tr>
        <td class="db-hold-ticker">${t.replace(".AS", "").replace(".DE", "").replace(".PA", "")}</td>
        <td class="db-hold-price">${sym}${item.price.toFixed(2)}</td>
        <td class="${cls1d}">${sign}${pct1d?.toFixed(2) ?? "—"}%</td>
        <td class="db-hold-alloc">${(w * 100).toFixed(1)}%</td>
        <td class="db-hold-val">${fmtCurrency(v)}</td>
        <td><button class="${tradeBtnCls}" title="${tradeBtnTitle}" ${tradeOnClick ? `onclick="${tradeOnClick}"` : "disabled"}>Trade</button></td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// ── Performance grafiek ────────────────────────────────────────
function renderPerformanceChart(tickers, weights) {
  const canvas = document.getElementById("db-perf-canvas");
  if (!canvas) return;
  if (dbCharts.perf) { dbCharts.perf.destroy(); }

  const nDays = 252;
  const portClose = portfolioCloseArr(tickers, weights, nDays);
  if (portClose.length === 0) return;

  // Gebruik de langste beschikbare datumreeks van de eerste ticker
  const refTicker = tickers[0];
  const refDates = pricesData[refTicker]?.dates?.slice(-portClose.length) || [];

  const datasets = [{
    label: "Portfolio",
    data: portClose,
    borderColor: "#388bfd",
    backgroundColor: "rgba(56,139,253,0.06)",
    fill: true,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.1,
  }];

  // Benchmark ^GSPC als die beschikbaar is
  if (benchmarkPrices && benchmarkPrices.close) {
    const benchClose = benchmarkPrices.close.slice(-nDays);
    const normalizedBench = benchClose.map(v => (v / benchClose[0]) * 100);
    datasets.push({
      label: "S&P 500",
      data: normalizedBench.slice(0, portClose.length),
      borderColor: "#8b949e",
      borderDash: [4, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    });
  }

  _dbPerfData = { labels: refDates, datasets };
  _drawPerfChart();
  _setupPerfPeriodButtons();
}

// ── Performance grafiek op basis van T212 transacties ─────────
async function renderPerformanceChartFromT212(tickers) {
  const canvas = document.getElementById("db-perf-canvas");
  if (!canvas) return;
  if (dbCharts.perf) { dbCharts.perf.destroy(); }

  // Gebruik geladen CSV-transacties als die beschikbaar zijn — anders fallback
  // _allTransactions is gezet door parseCsv() in account.js
  const csvOrders = (typeof _allTransactions !== "undefined" && _allTransactions?.length > 0)
    ? _allTransactions : null;

  let orders;
  if (csvOrders) {
    orders = csvOrders;
  } else {
    // Geen CSV-data geladen — toon gewoon gewogen grafiek zonder transacties
    const { weights } = getPortfolioWeights(tickers);
    renderPerformanceChart(tickers, weights);
    return;
  }

  // Filter: alleen uitgevoerde orders met datum
  const executed = orders.filter(o => o.dateModified)
    .sort((a, b) => new Date(a.dateModified) - new Date(b.dateModified));

  if (executed.length === 0) {
    const { weights } = getPortfolioWeights(tickers);
    renderPerformanceChart(tickers, weights);
    return;
  }

  // Strategie: Time-Weighted Return (TWR) via dagelijkse koerswijzigingen.
  // Gebruik pricesData voor koershistorie (universe-tickers).
  // Per dag: gewogen dagrendement = Σ (dagret_ticker × costEur_ticker) / Σ costEur
  // Dit elimineert het effect van stortingen — alleen koersprestatie telt.

  // Indexeer prijsdata per universe-ticker per datum
  const priceIndex = {};
  for (const ticker of tickers) {
    const pd = pricesData[ticker];
    if (!pd || !pd.dates || !pd.close) continue;
    priceIndex[ticker] = {};
    pd.dates.forEach((date, i) => { priceIndex[ticker][date] = pd.close[i]; });
  }

  // CSV-ticker → Yahoo-ticker (exacte match op basisnaam)
  const csvToYahoo = (csvTicker) => {
    if (!csvTicker) return null;
    const up = csvTicker.toUpperCase();
    return tickers.find(t =>
      t.replace(".AS","").replace(".DE","").replace(".PA","").toUpperCase() === up
    ) || null;
  };

  // Bepaal datumreeks
  const firstDate = new Date(executed[0].dateModified);
  firstDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const allDates = [];
  for (let d = new Date(firstDate); d <= today; d.setDate(d.getDate() + 1)) {
    allDates.push(new Date(d).toISOString().slice(0, 10));
  }

  const txByDate = {};
  for (const o of executed) {
    const date = o.dateModified.slice(0, 10);
    if (!txByDate[date]) txByDate[date] = [];
    txByDate[date].push(o);
  }

  // holdings: yahooTicker → { shares, costEur }
  const holdings = {};
  // prevPrices: yahooTicker → slotkoers vorige handelsdag
  const prevPrices = {};

  let twrIndex = 100; // start op 100
  const portfolioValues = [];
  const labels = [];

  for (const date of allDates) {
    // Verwerk eerst transacties van die dag (nieuwe posities tellen mee vanaf volgende dag)
    if (txByDate[date]) {
      for (const o of txByDate[date]) {
        const yahoo = csvToYahoo(o.ticker || "");
        if (!yahoo) continue;
        if (!holdings[yahoo]) holdings[yahoo] = { shares: 0, costEur: 0 };
        const qty   = o.filledQuantity || o.quantity || 0;
        const total = Math.abs(o.total || (o.fillPrice * qty) || 0);
        if (o.side === "BUY" || o.type === "BUY") {
          // Sla aankoopprijs op als prevPrice zodat morgen het dagrendement correct is
          if (!prevPrices[yahoo] && o.fillPrice) prevPrices[yahoo] = o.fillPrice;
          holdings[yahoo].shares  += qty;
          holdings[yahoo].costEur += total;
        } else if (o.side === "SELL" || o.type === "SELL") {
          if (holdings[yahoo].shares > 0) {
            const ratio = Math.min(qty / holdings[yahoo].shares, 1);
            holdings[yahoo].costEur *= (1 - ratio);
            holdings[yahoo].shares   = Math.max(0, holdings[yahoo].shares - qty);
          }
        }
      }
    }

    // Bereken gewogen dagrendement voor posities met bekende prijzen
    let weightedRet = 0;
    let totalWeight = 0;
    for (const [ticker, pos] of Object.entries(holdings)) {
      if (pos.shares <= 0 || pos.costEur <= 0) continue;
      const priceToday = priceIndex[ticker]?.[date];
      const priceYest  = prevPrices[ticker];
      if (priceToday != null) {
        if (priceYest != null && priceYest > 0) {
          weightedRet += ((priceToday - priceYest) / priceYest) * pos.costEur;
          totalWeight += pos.costEur;
        }
        prevPrices[ticker] = priceToday; // update voor morgen
      }
    }

    if (totalWeight > 0) {
      twrIndex *= (1 + weightedRet / totalWeight);
    }

    // Voeg toe als er al posities zijn
    const hasPositions = Object.values(holdings).some(p => p.shares > 0);
    if (hasPositions) {
      portfolioValues.push(parseFloat(twrIndex.toFixed(3)));
      labels.push(date);
    }
  }

  if (portfolioValues.length < 2) {
    const { weights } = getPortfolioWeights(tickers);
    renderPerformanceChart(tickers, weights);
    return;
  }

  // Sla ruwe waarden op voor risico analyse
  _dbTxPortfolioValues = portfolioValues;

  const datasets = [{
    label: "Portfolio",
    data: portfolioValues,
    borderColor: "#388bfd",
    backgroundColor: "rgba(56,139,253,0.06)",
    fill: true,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.1,
  }];

  // Benchmark: normaliseer S&P 500 op dezelfde basis 100 vanaf dezelfde startdatum
  if (benchmarkPrices && benchmarkPrices.close && benchmarkPrices.dates) {
    const benchIndex = {};
    benchmarkPrices.dates.forEach((d, i) => { benchIndex[d] = benchmarkPrices.close[i]; });
    const benchValues = labels.map(d => benchIndex[d] || null);
    const firstBench = benchValues.find(v => v !== null);
    if (firstBench) {
      datasets.push({
        label: "S&P 500",
        data: benchValues.map(v => v !== null ? (v / firstBench) * 100 : null),
        borderColor: "#8b949e",
        borderDash: [4, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        spanGaps: true,
      });
    }
  }

  // Sla volledige (ongefilterde) data op en teken met actieve periode
  _dbPerfData = { labels, datasets };
  _drawPerfChart();
  _setupPerfPeriodButtons();
}

const _PERF_PERIOD_DAYS = { "1D": 1, "1W": 7, "1M": 30, "3M": 91, "1J": 365 };

function _drawPerfChart() {
  const canvas = document.getElementById("db-perf-canvas");
  if (!canvas || !_dbPerfData) return;
  if (dbCharts.perf) { dbCharts.perf.destroy(); dbCharts.perf = null; }

  let { labels, datasets } = _dbPerfData;

  // Snijd labels/data bij op actieve periode
  if (_dbPerfPeriod !== "MAX") {
    const days = _PERF_PERIOD_DAYS[_dbPerfPeriod] || 9999;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const startIdx = labels.findIndex(l => l >= cutoffStr);
    if (startIdx > 0) {
      labels = labels.slice(startIdx);
      datasets = datasets.map(ds => ({
        ...ds,
        data: ds.data.slice(startIdx),
      }));
      // Herbaseer op 100 vanaf het begin van de periode
      datasets = datasets.map(ds => {
        const first = ds.data.find(v => v !== null);
        if (!first) return ds;
        return { ...ds, data: ds.data.map(v => v !== null ? (v / first) * 100 : null) };
      });
    }
  }

  const maxTicks = { "1D": 4, "1W": 7, "1M": 6, "3M": 6, "1J": 12, "MAX": 8 }[_dbPerfPeriod] || 8;

  dbCharts.perf = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#8b949e", font: { size: 11 }, boxWidth: 20 } },
        tooltip: {
          backgroundColor: "#161b22",
          borderColor: "#30363d",
          borderWidth: 1,
          titleColor: "#8b949e",
          bodyColor: "#e6edf3",
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              if (v == null) return "";
              const pct = (v - 100).toFixed(1);
              const sign = pct >= 0 ? "+" : "";
              return ` ${ctx.dataset.label}: ${v.toFixed(1)} (${sign}${pct}%)`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#8b949e", font: { size: 10 }, maxTicksLimit: maxTicks },
          grid: { color: "rgba(48,54,61,0.5)" },
        },
        y: {
          ticks: {
            color: "#8b949e", font: { size: 10 },
            callback: v => v.toFixed(0),
          },
          grid: { color: "rgba(48,54,61,0.5)" },
        }
      }
    }
  });
}

function _setupPerfPeriodButtons() {
  document.querySelectorAll("[data-perf-period]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.perfPeriod === _dbPerfPeriod);
    btn.onclick = () => {
      _dbPerfPeriod = btn.dataset.perfPeriod;
      document.querySelectorAll("[data-perf-period]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _drawPerfChart();
    };
  });
}

// ── Risico panel ──────────────────────────────────────────────
function renderRiskPanel(tickers, weights) {
  // Gebruik echte transactiegebaseerde portfoliowaarden als die beschikbaar zijn
  let portRets, portClose;
  if (_dbTxPortfolioValues && _dbTxPortfolioValues.length >= 20) {
    portClose = _dbTxPortfolioValues;
    portRets = dailyReturns(_dbTxPortfolioValues);
  } else {
    portRets = portfolioReturnsArr(tickers, weights, 252);
    portClose = portfolioCloseArr(tickers, weights, 252);
  }

  const portVol = portRets.length > 0 ? annualizedVol(portRets) : null;

  // Max drawdown van portfolio waarde
  const portDD = portClose.length > 0 ? maxDrawdown(portClose) : null;

  // Sharpe
  const sharpe = portRets.length > 0 ? sharpeRatio(portRets) : null;

  // Beta
  let beta = null;
  if (benchmarkPrices && benchmarkPrices.close) {
    const benchRets = dailyReturns(benchmarkPrices.close.slice(-253));
    beta = betaVsBenchmark(portRets, benchRets);
  }

  // Top concentratie
  const maxWeight = Math.max(...weights) * 100;
  const topTicker = tickers[weights.indexOf(Math.max(...weights))];

  // Gewogen P/E
  const weightedPE = tickers.reduce((s, t, i) => {
    const item = allRankings.find(r => r.ticker === t);
    return s + (item?.pe || 0) * weights[i];
  }, 0);

  const metrics = [
    { label: "Volatiliteit (jaar)", value: portVol !== null ? `${(portVol * 100).toFixed(1)}%` : "—",
      sub: portVol !== null ? (portVol > 0.25 ? "Hoog" : portVol > 0.15 ? "Gemiddeld" : "Laag") : "",
      cls: portVol !== null ? (portVol > 0.25 ? "neg" : portVol > 0.15 ? "warn" : "pos") : "" },
    { label: "Max Drawdown", value: portDD !== null ? `-${(portDD * 100).toFixed(1)}%` : "—",
      sub: portDD !== null ? (portDD > 0.2 ? "Groot verlies" : "Beheersbaar") : "",
      cls: portDD !== null ? (portDD > 0.2 ? "neg" : "neutral") : "" },
    { label: "Sharpe Ratio", value: sharpe !== null ? sharpe.toFixed(2) : "—",
      sub: sharpe !== null ? (sharpe > 1 ? "Uitstekend" : sharpe > 0.5 ? "Goed" : "Slecht") : "",
      cls: sharpe !== null ? (sharpe > 1 ? "pos" : sharpe > 0.5 ? "warn" : "neg") : "" },
    { label: "Beta (vs S&P 500)", value: beta !== null ? beta.toFixed(2) : "—",
      sub: beta !== null ? (beta > 1.3 ? "Hoge marktgev." : beta < 0.7 ? "Defensief" : "Marktconform") : "Geen benchmark",
      cls: beta !== null ? (beta > 1.3 ? "neg" : "neutral") : "neutral" },
    { label: "Top concentratie", value: `${maxWeight.toFixed(1)}%`,
      sub: topTicker?.replace(".AS", "").replace(".DE", "").replace(".PA", ""),
      cls: maxWeight > 30 ? "neg" : maxWeight > 20 ? "warn" : "pos" },
    { label: "Gewogen K/W", value: weightedPE > 0 ? weightedPE.toFixed(1) + "x" : "—",
      sub: weightedPE > 35 ? "Hoge waardering" : weightedPE > 20 ? "Gemiddeld" : "Laag",
      cls: weightedPE > 35 ? "neg" : "neutral" },
  ];

  const container = document.getElementById("db-risk-metrics");
  container.innerHTML = metrics.map(m => `
    <div class="db-risk-item">
      <div class="db-risk-label">${m.label}</div>
      <div class="db-risk-value ${m.cls}">${m.value}</div>
      ${m.sub ? `<div class="db-risk-sub">${m.sub}</div>` : ""}
    </div>
  `).join("");
}

// ── Sector donut ──────────────────────────────────────────────
function renderSectorDonut(tickers, weights) {
  const canvas = document.getElementById("db-sector-canvas");
  if (!canvas) return;
  if (dbCharts.sector) { dbCharts.sector.destroy(); }

  const sectorMap = {};
  for (let i = 0; i < tickers.length; i++) {
    const item = allRankings.find(r => r.ticker === tickers[i]);
    const sector = item?.sector || "Overig";
    sectorMap[sector] = (sectorMap[sector] || 0) + weights[i];
  }

  const labels = Object.keys(sectorMap);
  const data = labels.map(l => (sectorMap[l] * 100).toFixed(1));

  dbCharts.sector = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: SECTOR_COLORS.slice(0, labels.length),
        borderColor: "#0d1117",
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "60%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8b949e", font: { size: 10 }, boxWidth: 12, padding: 8 }
        },
        tooltip: {
          backgroundColor: "#161b22",
          borderColor: "#30363d",
          borderWidth: 1,
          titleColor: "#8b949e",
          bodyColor: "#e6edf3",
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw}%` }
        }
      }
    }
  });
}

// ── Volatiliteit bars ─────────────────────────────────────────
function renderVolatilityBars(tickers) {
  const canvas = document.getElementById("db-vol-canvas");
  if (!canvas) return;
  if (dbCharts.vol) { dbCharts.vol.destroy(); }

  const vols = tickers.map(t => {
    const pd = pricesData[t];
    if (!pd || !pd.close || pd.close.length < 20) return 0;
    return (annualizedVol(dailyReturns(pd.close)) * 100);
  });

  const labels = tickers.map(t => t.replace(".AS", "").replace(".DE", "").replace(".PA", ""));
  const sorted = labels.map((l, i) => ({ l, v: vols[i] })).sort((a, b) => b.v - a.v);

  dbCharts.vol = new Chart(canvas, {
    type: "bar",
    data: {
      labels: sorted.map(s => s.l),
      datasets: [{
        data: sorted.map(s => s.v.toFixed(1)),
        backgroundColor: sorted.map(s => s.v > 35 ? "rgba(248,81,73,0.7)" : s.v > 25 ? "rgba(210,153,34,0.7)" : "rgba(56,139,253,0.7)"),
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#161b22",
          borderColor: "#30363d",
          borderWidth: 1,
          titleColor: "#8b949e",
          bodyColor: "#e6edf3",
          callbacks: { label: ctx => ` Vol: ${ctx.raw}%` }
        }
      },
      scales: {
        x: {
          ticks: { color: "#8b949e", font: { size: 10 }, callback: v => v + "%" },
          grid: { color: "rgba(48,54,61,0.5)" },
        },
        y: { ticks: { color: "#e6edf3", font: { size: 10 } }, grid: { display: false } }
      }
    }
  });
}

// ── Earnings kalender ─────────────────────────────────────────
function renderEarningsCalendar(tickers) {
  const container = document.getElementById("db-earnings-list");
  const entries = [];

  for (const t of tickers) {
    const fund = fundamentalsData[t];
    const item = allRankings.find(r => r.ticker === t);
    const name = item?.name || t;
    const ticker = t.replace(".AS", "").replace(".DE", "").replace(".PA", "");
    if (fund?.earnings_date && fund.earnings_date !== "null" && fund.earnings_date !== "None") {
      const d = new Date(fund.earnings_date);
      if (!isNaN(d)) entries.push({ ticker, name, date: d, raw: fund.earnings_date });
    } else {
      entries.push({ ticker, name, date: null, raw: null });
    }
  }

  entries.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date - b.date;
  });

  const today = new Date();
  let html = "";
  for (const e of entries.slice(0, 8)) {
    if (!e.date) continue;
    const diff = Math.round((e.date - today) / (1000 * 60 * 60 * 24));
    const diffLabel = diff < 0 ? `${Math.abs(diff)}d geleden` : diff === 0 ? "Vandaag" : diff === 1 ? "Morgen" : `Over ${diff}d`;
    const dateStr = e.date.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
    const cls = diff < 0 ? "neutral" : diff <= 7 ? "pos" : "";
    html += `
      <div class="db-earnings-row">
        <span class="db-earnings-ticker">${e.ticker}</span>
        <span class="db-earnings-date">${dateStr}</span>
        <span class="db-earnings-diff ${cls}">${diffLabel}</span>
      </div>`;
  }

  if (!html) {
    html = `<p class="db-empty">Geen earnings datum data.<br><small>Herrun fetch_data.py voor earnings data.</small></p>`;
  }
  container.innerHTML = html;
}

// ── Correlatie matrix ─────────────────────────────────────────
function renderCorrelationMatrix(tickers) {
  const canvas = document.getElementById("db-corr-canvas");
  if (!canvas) return;

  const labels = tickers.map(t => t.replace(".AS", "").replace(".DE", "").replace(".PA", ""));
  const n = tickers.length;

  // Bereken alle dagelijkse rendementen
  const returns = tickers.map(t => {
    const pd = pricesData[t];
    if (!pd || !pd.close) return [];
    return dailyReturns(pd.close.slice(-126)); // 6 maanden
  });

  // Teken de matrix handmatig op canvas
  const dpr = window.devicePixelRatio || 1;
  const containerW = canvas.parentElement.clientWidth || 300;
  const size = Math.min(containerW, 400);
  const cellSize = Math.floor((size - 60) / n);
  const offsetX = 50;
  const offsetY = 14;
  const totalW = offsetX + cellSize * n + 4;
  const totalH = offsetY + cellSize * n + 40;

  canvas.width = totalW * dpr;
  canvas.height = totalH * dpr;
  canvas.style.width = totalW + "px";
  canvas.style.height = totalH + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, totalW, totalH);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const corr = i === j ? 1.0 : pearsonCorr(returns[i], returns[j]);
      ctx.fillStyle = colorForCorr(corr);
      ctx.fillRect(offsetX + j * cellSize, offsetY + i * cellSize, cellSize - 1, cellSize - 1);

      // Toon correlatie waarde in cel
      if (cellSize >= 28) {
        ctx.fillStyle = corr > 0.3 || corr < -0.3 ? "#fff" : "#8b949e";
        ctx.font = `${Math.max(8, Math.min(11, cellSize * 0.35))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(corr.toFixed(2), offsetX + j * cellSize + cellSize / 2, offsetY + i * cellSize + cellSize / 2);
      }
    }

    // Y labels (rij)
    ctx.fillStyle = "#8b949e";
    ctx.font = `${Math.max(8, Math.min(10, cellSize * 0.38))}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(labels[i], offsetX - 4, offsetY + i * cellSize + cellSize / 2);

    // X labels (kolom) — onderaan, gedraaid
    ctx.save();
    ctx.translate(offsetX + i * cellSize + cellSize / 2, offsetY + n * cellSize + 4);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(labels[i], 0, 0);
    ctx.restore();
  }
}

// ── Risico suggesties ─────────────────────────────────────────
function renderRiskSuggestions(tickers, weights) {
  const portRets = (_dbTxPortfolioValues && _dbTxPortfolioValues.length >= 20)
    ? dailyReturns(_dbTxPortfolioValues)
    : portfolioReturnsArr(tickers, weights, 252);
  const portVol = portRets.length > 0 ? annualizedVol(portRets) : null;
  const sharpe = portRets.length > 0 ? sharpeRatio(portRets) : null;
  const maxWeight = Math.max(...weights);
  const topTicker = tickers[weights.indexOf(maxWeight)];
  const topName = topTicker?.replace(".AS", "").replace(".DE", "").replace(".PA", "");
  const weightedPE = tickers.reduce((s, t, i) => {
    const item = allRankings.find(r => r.ticker === t);
    return s + (item?.pe || 0) * weights[i];
  }, 0);

  const suggestions = [];

  if (maxWeight > 0.30) {
    suggestions.push({
      type: "danger",
      title: "Hoge concentratie",
      text: `${topName} beslaat ${(maxWeight * 100).toFixed(1)}% van de portfolio. Overweeg spreiding.`
    });
  }

  if (portVol !== null && portVol > 0.25) {
    suggestions.push({
      type: "danger",
      title: "Hoge volatiliteit",
      text: `Jaarlijkse volatiliteit van ${(portVol * 100).toFixed(1)}% is boven de 25% drempel.`
    });
  } else if (portVol !== null && portVol > 0.18) {
    suggestions.push({
      type: "warn",
      title: "Verhoogde volatiliteit",
      text: `Volatiliteit van ${(portVol * 100).toFixed(1)}% — overweeg defensievere posities.`
    });
  }

  if (sharpe !== null && sharpe < 0.5) {
    suggestions.push({
      type: "danger",
      title: "Lage Sharpe Ratio",
      text: `Sharpe van ${sharpe.toFixed(2)} — slechte risico-gecorrigeerde return. Bekijk posities.`
    });
  } else if (sharpe !== null && sharpe > 1.5) {
    suggestions.push({
      type: "good",
      title: "Uitstekende Sharpe Ratio",
      text: `Sharpe van ${sharpe.toFixed(2)} — sterke risico-gecorrigeerde performance.`
    });
  }

  if (weightedPE > 35) {
    suggestions.push({
      type: "warn",
      title: "Hoge waardering",
      text: `Gewogen K/W van ${weightedPE.toFixed(1)}x — portfolio prijst veel groei in.`
    });
  }

  // Sector concentratie check
  const sectorMap = {};
  for (let i = 0; i < tickers.length; i++) {
    const item = allRankings.find(r => r.ticker === tickers[i]);
    const sector = item?.sector || "Overig";
    sectorMap[sector] = (sectorMap[sector] || 0) + weights[i];
  }
  const topSector = Object.entries(sectorMap).sort((a, b) => b[1] - a[1])[0];
  if (topSector && topSector[1] > 0.50) {
    suggestions.push({
      type: "warn",
      title: "Sector concentratie",
      text: `${(topSector[1] * 100).toFixed(1)}% in ${topSector[0]}. Overweeg meer sectorale spreiding.`
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      type: "good",
      title: "Portfolio ziet er goed uit",
      text: "Geen kritieke risico's gedetecteerd op basis van de huidige data."
    });
  }

  const container = document.getElementById("db-suggestions-list");
  container.innerHTML = suggestions.map(s => `
    <div class="db-suggestion db-suggest-${s.type}">
      <div class="db-suggest-title">${s.title}</div>
      <div class="db-suggest-text">${s.text}</div>
    </div>
  `).join("");
}

// ── Top movers ────────────────────────────────────────────────
function renderTopMovers() {
  const container = document.getElementById("db-movers-list");
  if (!allRankings || allRankings.length === 0) return;

  const sorted = [...allRankings]
    .filter(r => r.change_1d !== null && r.change_1d !== undefined)
    .sort((a, b) => Math.abs(b.change_1d) - Math.abs(a.change_1d))
    .slice(0, 10);

  const gainers = sorted.filter(r => r.change_1d > 0).slice(0, 5);
  const losers = sorted.filter(r => r.change_1d < 0).slice(0, 5);

  let html = `<div class="db-movers-cols">`;

  html += `<div class="db-movers-col">
    <div class="db-movers-header pos">Stijgers</div>`;
  for (const r of gainers) {
    const ticker = r.ticker.replace(".AS", "").replace(".DE", "").replace(".PA", "");
    html += `
      <div class="db-mover-row">
        <span class="db-mover-ticker">${ticker}</span>
        <span class="pos">+${r.change_1d.toFixed(2)}%</span>
      </div>`;
  }
  html += `</div>`;

  html += `<div class="db-movers-col">
    <div class="db-movers-header neg">Dalers</div>`;
  for (const r of losers) {
    const ticker = r.ticker.replace(".AS", "").replace(".DE", "").replace(".PA", "");
    html += `
      <div class="db-mover-row">
        <span class="db-mover-ticker">${ticker}</span>
        <span class="neg">${r.change_1d.toFixed(2)}%</span>
      </div>`;
  }
  html += `</div></div>`;

  container.innerHTML = html;
}

// ── Tab switcher (wordt opgeroepen vanuit app.js context) ─────
function setupDashboardTab() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      const mainContent    = document.getElementById("main-content");
      const dashContent    = document.getElementById("dashboard-content");
      const accountContent = document.getElementById("account-content");
      const geschContent   = document.getElementById("geschiedenis-content");
      const tradesContent  = document.getElementById("trades-content");
      mainContent.classList.add("hidden");
      dashContent.classList.add("hidden");
      if (accountContent) accountContent.classList.add("hidden");
      if (geschContent)   geschContent.classList.add("hidden");
      if (tradesContent)  tradesContent.classList.add("hidden");

      if (tab === "rankings") {
        mainContent.classList.remove("hidden");
      } else if (tab === "dashboard") {
        dashContent.classList.remove("hidden");
        dashboardInitialized = false;
        initDashboard();
      } else if (tab === "trades") {
        if (tradesContent) tradesContent.classList.remove("hidden");
        if (typeof initTradesTab === "function") initTradesTab();
      } else if (tab === "geschiedenis") {
        if (geschContent) geschContent.classList.remove("hidden");
        // Herlaad transacties vanuit server-DB
        Auth.loadTransactions().then(txs => {
          Auth.loadDividends().then(divs => {
            _allTransactions.length = 0; _allTransactions.push(...txs);
            _allDividends.length    = 0; _allDividends.push(...divs);
            _txShown = 0;
            document.getElementById("gesch-tx-list").innerHTML = "";
            if (typeof renderMoreTransactions === "function") renderMoreTransactions();
            if (typeof renderDividendList    === "function") renderDividendList();
          });
        }).catch(() => {});
      } else if (tab === "account") {
        if (accountContent) accountContent.classList.remove("hidden");
        if (typeof totpLoadStatus === "function") totpLoadStatus();
        // Herlaad API-instellingen vanuit server-DB
        Auth.loadSettings().then(settings => {
          if (settings.t212_key) {
            T212.setApiKey(settings.t212_key);
            T212.setApiSecret(settings.t212_secret || "");
            T212.setEnv(settings.t212_env || "demo");
            document.getElementById("t212-api-key").value    = settings.t212_key;
            document.getElementById("t212-api-secret").value = settings.t212_secret || "";
            document.getElementById("t212-env").value        = settings.t212_env    || "demo";
            if (T212.isConfigured() && typeof showAccountInfo === "function") showAccountInfo();
          }
        }).catch(() => {});
      }
    });
  });
}
