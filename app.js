/* ─────────────────────────────────────────────────────────
   Portfolio Analyser – Frontend logica
   ───────────────────────────────────────────────────────── */

// ── Refresh ────────────────────────────────────────────────
async function triggerRefresh() {
  const btn = document.getElementById("refresh-btn");
  btn.textContent = "Bezig...";
  btn.style.pointerEvents = "none";
  try {
    const resp = await fetch("/proxy/refresh");
    if (resp.ok) {
      location.reload();
    } else {
      const data = await resp.json().catch(() => ({}));
      alert(data.message || "Refresh mislukt");
      btn.textContent = "Vernieuwen";
      btn.style.pointerEvents = "";
    }
  } catch (e) {
    alert("Kon proxy niet bereiken");
    btn.textContent = "Vernieuwen";
    btn.style.pointerEvents = "";
  }
}

// ── State ──────────────────────────────────────────────────
let allRankings = [];
let pricesData  = {};
let newsData     = {};
let insiderData  = {};
let congressData = {};
let activeIndex = "all";
let activeMinScore = 0;
let searchQuery = "";
let sortCol = "composite_score";
let sortAsc = false;
let showCount = 20;
let priceChart = null;
let activePeriod = "3M";
let activeChartTicker = null;

// ── Score helpers ──────────────────────────────────────────
function scoreClass(s) {
  if (s >= 75) return "score-hi";
  if (s >= 65) return "score-mid-hi";
  if (s >= 50) return "score-mid";
  if (s >= 35) return "score-low";
  return "score-bad";
}

function scoreColor(s) {
  if (s >= 75) return "#3fb950";
  if (s >= 65) return "#56d364";
  if (s >= 50) return "#d29922";
  if (s >= 35) return "#f0883e";
  return "#f85149";
}

function pctClass(v) {
  if (v === null || v === undefined) return "";
  return v > 0 ? "pos" : v < 0 ? "neg" : "neutral";
}

function fmt(v, decimals = 2, suffix = "") {
  if (v === null || v === undefined) return "—";
  return v.toFixed(decimals) + suffix;
}

function fmtPct(v) {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : "";
  return `<span class="${pctClass(v)}">${sign}${v.toFixed(2)}%</span>`;
}

function fmtPrice(v, currency) {
  if (v === null || v === undefined) return "—";
  const sym = currency === "EUR" ? "€" : "$";
  return `${sym}${v.toFixed(2)}`;
}

function rsiClass(v) {
  if (v === null || v === undefined) return "";
  if (v <= 35) return "rsi-low";
  if (v >= 65) return "rsi-high";
  return "rsi-mid";
}

function macdArrow(score) {
  if (score >= 70) return '<span class="macd-up">↑</span>';
  if (score <= 30) return '<span class="macd-down">↓</span>';
  return '<span class="neutral">–</span>';
}

function maStatus(item) {
  const p = item.price, m50 = item.ma50, m200 = item.ma200;
  if (!m50 || !m200) return '<span class="neutral">—</span>';
  const above50  = p > m50;
  const above200 = p > m200;
  const golden   = m50 > m200;
  if (above50 && above200 && golden) return '<span class="pos" title="Boven 50MA, 200MA + golden cross">★</span>';
  if (above50 && above200) return '<span class="pos" title="Boven 50MA en 200MA">✓✓</span>';
  if (above50) return '<span class="neutral" title="Alleen boven 50MA">✓</span>';
  return '<span class="neg" title="Onder beide MA">✗</span>';
}

function indexBadge(idx) {
  return `<span class="index-badge idx-${idx}">${idx === "SP500" ? "S&P500" : idx}</span>`;
}

// ── Filtering & sorteren ───────────────────────────────────
function filteredRankings() {
  let rows = allRankings.slice();
  if (activeIndex !== "all") rows = rows.filter(r => r.index === activeIndex);
  if (activeMinScore > 0) rows = rows.filter(r => r.composite_score >= activeMinScore);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    rows = rows.filter(r =>
      r.ticker.toLowerCase().includes(q) ||
      (r.name || "").toLowerCase().includes(q)
    );
  }
  rows.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (va === null || va === undefined) va = sortAsc ? Infinity : -Infinity;
    if (vb === null || vb === undefined) vb = sortAsc ? Infinity : -Infinity;
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
  return rows;
}

// ── Tabel renderen ─────────────────────────────────────────
function renderTable() {
  const rows = filteredRankings();
  const tbody = document.getElementById("table-body");
  const visible = rows.slice(0, showCount);

  tbody.innerHTML = visible.map((item, i) => `
    <tr onclick="openModal('${item.ticker}')">
      <td class="col-rank">${i + 1}</td>
      <td class="col-ticker">${item.ticker}</td>
      <td class="col-name">${item.name || "—"}</td>
      <td>${indexBadge(item.index)}</td>
      <td class="col-price">${fmtPrice(item.price, item.currency)}</td>
      <td class="col-change">${fmtPct(item.change_1d)}</td>
      <td class="col-mom1m">${fmtPct(item.mom_1m)}</td>
      <td class="col-mom3m">${fmtPct(item.mom_3m)}</td>
      <td class="col-score">
        <span class="score-badge ${scoreClass(item.composite_score)}">${item.composite_score.toFixed(1)}</span>
      </td>
      <td class="col-rsi">
        <span class="${rsiClass(item.rsi_value)}">${item.rsi_value !== null ? item.rsi_value.toFixed(1) : "—"}</span>
      </td>
      <td class="col-macd">${macdArrow(item.scores.macd)}</td>
      <td class="col-ma">${maStatus(item)}</td>
    </tr>
  `).join("");

  const count = document.getElementById("showing-count");
  count.textContent = `${Math.min(showCount, rows.length)} van ${rows.length} aandelen`;

  const btn = document.getElementById("show-more-btn");
  if (rows.length > showCount) {
    btn.classList.remove("hidden");
    btn.textContent = `Toon meer (${rows.length - showCount} meer)`;
  } else {
    btn.classList.add("hidden");
  }
}

// ── Top picks cards ────────────────────────────────────────
function renderTopPicks() {
  const indices = ["AEX", "DAX", "CAC40", "SP500"];
  const container = document.getElementById("top-picks");
  container.innerHTML = indices.map(idx => {
    const top = allRankings.find(r => r.index === idx);
    if (!top) return `<div class="pick-card"><div class="card-index">${idx}</div><div class="card-ticker">—</div></div>`;
    return `
      <div class="pick-card" onclick="openModal('${top.ticker}')">
        <div class="card-index" style="color:${scoreColor(top.composite_score)}">${idx === "SP500" ? "S&P 500" : idx} · Beste pick</div>
        <div class="card-ticker">${top.ticker}</div>
        <div class="card-name">${top.name || ""}</div>
        <div class="card-score" style="color:${scoreColor(top.composite_score)}">${top.composite_score.toFixed(1)}</div>
        <div class="card-price">${fmtPrice(top.price, top.currency)} &nbsp; ${fmtPct(top.change_1d)}</div>
      </div>
    `;
  }).join("");
}

// ── Modal ──────────────────────────────────────────────────
function openModal(ticker) {
  const item = allRankings.find(r => r.ticker === ticker);
  if (!item) return;

  document.getElementById("modal-ticker").textContent = ticker;
  document.getElementById("modal-name").textContent = item.name || "";
  const badge = document.getElementById("modal-index-badge");
  badge.textContent = item.index === "SP500" ? "S&P 500" : item.index;
  badge.className = `index-badge idx-${item.index}`;

  // Composite score badge
  const comp = document.getElementById("modal-composite-score");
  comp.textContent = item.composite_score.toFixed(1);
  comp.className = `score-badge ${scoreClass(item.composite_score)}`;

  // Score breakdown bars
  renderScoreBars(item);

  // Fundamentals grid
  renderFundamentals(item);

  // Nieuws
  renderNews(ticker);

  // Insider + Congress trades
  renderInsiderTrades(ticker);
  renderCongressTrades(ticker);

  // Grafiek
  activeChartTicker = ticker;
  setupPeriodButtons();
  renderPriceChart(ticker, activePeriod);

  document.getElementById("modal-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal(event) {
  if (event && event.target !== document.getElementById("modal-overlay")) return;
  document.getElementById("modal-overlay").classList.add("hidden");
  document.body.style.overflow = "";
  if (priceChart) { priceChart.destroy(); priceChart = null; }
}

// ── Score bars in modal ────────────────────────────────────
const SCORE_LABELS = {
  rsi:            "RSI",
  macd:           "MACD",
  ma_trend:       "MA Trend",
  momentum_1m:    "Momentum 1M",
  momentum_3m:    "Momentum 3M",
  pe_vs_sector:   "P/E vs Sector",
  revenue_growth: "Omzetgroei",
  earnings_growth:"Winstgroei",
  news:           "Nieuws sentiment",
  insider:        "Insider trades",
  congress:       "Congress trades",
};

function renderScoreBars(item) {
  const container = document.getElementById("score-bars");
  container.innerHTML = Object.entries(SCORE_LABELS).map(([key, label]) => {
    const val = item.scores[key] || 0;
    const color = scoreColor(val);
    return `
      <div class="score-row">
        <div class="score-row-label">${label}</div>
        <div class="score-bar-bg">
          <div class="score-bar-fill" style="width:${val}%;background:${color}"></div>
        </div>
        <div class="score-row-val" style="color:${color}">${val.toFixed(0)}</div>
      </div>
    `;
  }).join("");
}

// ── Fundamentals grid in modal ─────────────────────────────
function renderFundamentals(item) {
  const pctVal = v => v !== null && v !== undefined ? ((v * 100).toFixed(1) + "%") : "—";
  const items = [
    { label: "P/E (trailing)", value: item.pe ? item.pe.toFixed(1) : "—" },
    { label: "P/E (forward)",  value: item.forward_pe ? item.forward_pe.toFixed(1) : "—" },
    { label: "Omzetgroei",     value: pctVal(item.revenue_growth), class: item.revenue_growth > 0 ? "pos" : item.revenue_growth < 0 ? "neg" : "" },
    { label: "Winstgroei",     value: pctVal(item.earnings_growth), class: item.earnings_growth > 0 ? "pos" : item.earnings_growth < 0 ? "neg" : "" },
    { label: "RSI(14)",        value: item.rsi_value ? item.rsi_value.toFixed(1) : "—", class: rsiClass(item.rsi_value) },
    { label: "Sector",         value: item.sector || "—" },
    { label: "52W Laag",       value: fmtPrice(item.week52_low, item.currency) },
    { label: "52W Hoog",       value: fmtPrice(item.week52_high, item.currency) },
    { label: "MA 50",          value: fmtPrice(item.ma50, item.currency) },
    { label: "MA 200",         value: fmtPrice(item.ma200, item.currency) },
  ];
  document.getElementById("modal-fundamentals").innerHTML = items.map(i => `
    <div class="fund-item">
      <div class="fund-label">${i.label}</div>
      <div class="fund-value ${i.class || ""}">${i.value}</div>
    </div>
  `).join("");
}

// ── Nieuws in modal ────────────────────────────────────────
function renderNews(ticker) {
  const container = document.getElementById("modal-fundamentals");
  const tickerNews = newsData[ticker];
  const articles = tickerNews ? tickerNews.articles : [];

  // Verwijder bestaande nieuws sectie als die er al is
  const existing = document.getElementById("modal-news-section");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "modal-news-section";
  section.className = "news-section";

  const header = document.createElement("h3");
  header.textContent = articles.length > 0
    ? `Laatste nieuws (${articles.length})`
    : "Laatste nieuws";
  section.appendChild(header);

  if (articles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "news-empty";
    empty.textContent = "Geen nieuwsberichten gevonden voor dit aandeel.";
    section.appendChild(empty);
  } else {
    articles.slice(0, 5).forEach(a => {
      const card = document.createElement("a");
      card.className = `news-article news-${a.sentiment}`;
      card.href = a.url || "#";
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      const tag = document.createElement("span");
      tag.className = `news-tag news-tag-${a.sentiment}`;
      tag.textContent = a.sentiment === "positive" ? "+" : a.sentiment === "negative" ? "−" : "·";

      const content = document.createElement("div");
      content.className = "news-content";

      const title = document.createElement("div");
      title.className = "news-title";
      title.textContent = a.title;

      const meta = document.createElement("div");
      meta.className = "news-meta";
      meta.textContent = formatNewsDate(a.published);

      content.appendChild(title);
      content.appendChild(meta);
      card.appendChild(tag);
      card.appendChild(content);
      section.appendChild(card);
    });
  }

  // Nieuws sectie toevoegen na fundamentals grid
  container.parentNode.insertBefore(section, container.nextSibling);
}

function formatNewsDate(pubStr) {
  if (!pubStr) return "";
  try {
    const d = new Date(pubStr);
    const now = new Date();
    const diffMs = now - d;
    const diffH = Math.floor(diffMs / 3600000);
    const diffM = Math.floor(diffMs / 60000);
    if (diffM < 60) return `${diffM} min geleden`;
    if (diffH < 24) return `${diffH} uur geleden`;
    return d.toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
  } catch {
    return pubStr;
  }
}

// ── Insider trades in modal ────────────────────────────────
function renderInsiderTrades(ticker) {
  const existing = document.getElementById("modal-insider-section");
  if (existing) existing.remove();

  const data       = insiderData[ticker] || {};
  const trades     = data.recent || [];
  const buyCount   = data.buy_count  || 0;
  const sellCount  = data.sell_count || 0;

  const section = document.createElement("div");
  section.id = "modal-insider-section";
  section.className = "trades-section";

  const h = document.createElement("h3");
  h.textContent = buyCount + sellCount > 0
    ? `Insider trades (${buyCount} filings afgelopen 90d)`
    : "Insider trades (Form 4)";
  section.appendChild(h);

  if (trades.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trades-empty";
    empty.textContent = buyCount === 0
      ? "Geen Form 4 filings gevonden (EU aandelen niet gedekt door SEC)."
      : "Details niet beschikbaar.";
    section.appendChild(empty);
  } else {
    trades.forEach(t => {
      const card = document.createElement("div");
      card.className = "trade-card trade-buy";

      const tag = document.createElement("span");
      tag.className = "trade-tag trade-tag-buy";
      tag.textContent = "4";

      const content = document.createElement("div");
      content.className = "trade-content";

      const title = document.createElement("div");
      title.className = "trade-title";
      title.textContent = `Form 4 filing`;

      const meta = document.createElement("div");
      meta.className = "trade-meta";
      meta.textContent = t.date || "";

      content.appendChild(title);
      content.appendChild(meta);
      card.appendChild(tag);
      card.appendChild(content);
      section.appendChild(card);
    });
  }

  const newsSection = document.getElementById("modal-news-section");
  if (newsSection) newsSection.parentNode.insertBefore(section, newsSection.nextSibling);
}

// ── Congressional trades in modal ─────────────────────────
function renderCongressTrades(ticker) {
  const existing = document.getElementById("modal-congress-section");
  if (existing) existing.remove();

  const data      = congressData[ticker] || {};
  const trades    = data.recent || [];
  const buyCount  = data.buy_count  || 0;
  const sellCount = data.sell_count || 0;

  const section = document.createElement("div");
  section.id = "modal-congress-section";
  section.className = "trades-section";

  const h = document.createElement("h3");
  h.textContent = buyCount + sellCount > 0
    ? `Congress trades (${buyCount} kopen · ${sellCount} verkopen, afgelopen 90d)`
    : "Congress trades";
  section.appendChild(h);

  if (trades.length === 0) {
    const empty = document.createElement("p");
    empty.className = "trades-empty";
    empty.textContent = "Geen congressional trades gevonden voor dit aandeel.";
    section.appendChild(empty);
  } else {
    trades.forEach(t => {
      const card = document.createElement("div");
      card.className = `trade-card trade-${t.type}`;

      const tag = document.createElement("span");
      tag.className = `trade-tag trade-tag-${t.type}`;
      tag.textContent = t.type === "buy" ? "K" : "V";

      const content = document.createElement("div");
      content.className = "trade-content";

      const title = document.createElement("div");
      title.className = "trade-title";
      const party = (t.party || "").toUpperCase();
      const partyClass = party === "D" ? "party-dem" : party === "R" ? "party-rep" : "";
      const partyBadge = party ? `<span class="party-badge ${partyClass}">${party}</span> ` : "";
      title.innerHTML = `${t.representative || "Onbekend"} ${partyBadge}· ${t.amount || ""}`;

      const meta = document.createElement("div");
      meta.className = "trade-meta";
      meta.textContent = t.date || "";

      content.appendChild(title);
      content.appendChild(meta);
      card.appendChild(tag);
      card.appendChild(content);
      section.appendChild(card);
    });
  }

  const insiderSection = document.getElementById("modal-insider-section");
  if (insiderSection) insiderSection.parentNode.insertBefore(section, insiderSection.nextSibling);
}

// ── Periode knoppen ────────────────────────────────────────
const PERIOD_DAYS = { "1W": 7, "1M": 22, "3M": 66, "1Y": 365 };

function setupPeriodButtons() {
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.period === activePeriod);
    btn.onclick = () => {
      activePeriod = btn.dataset.period;
      document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderPriceChart(activeChartTicker, activePeriod);
    };
  });
}

// ── Koers grafiek ──────────────────────────────────────────
function renderPriceChart(ticker, period = "3M") {
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  const canvas = document.getElementById("price-chart");
  const tickerData = pricesData[ticker];

  if (!tickerData || !tickerData.dates || tickerData.dates.length === 0) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Slice op basis van gewenste periode
  const days = PERIOD_DAYS[period] || 66;
  const allDates  = tickerData.dates;
  const allPrices = tickerData.close;
  const sliceDates  = allDates.slice(-days);
  const slicePrices = allPrices.slice(-days);

  const startPrice = slicePrices[0];
  const isUp = slicePrices[slicePrices.length - 1] >= startPrice;
  const lineColor = isUp ? "#3fb950" : "#f85149";
  const fillColor = isUp ? "rgba(63,185,80,0.08)" : "rgba(248,81,73,0.08)";

  // Aantal x-ticks aanpassen aan periode
  const maxTicks = { "1W": 7, "1M": 6, "3M": 6, "1Y": 12 }[period] || 6;

  // Verzamel alle trade-datums (insider + congress) voor stippen op de grafiek
  const insiderTrades  = (insiderData[ticker]  || {}).recent || [];
  const congressTrades = (congressData[ticker] || {}).recent || [];
  const allTrades = [
    ...insiderTrades.map(t  => ({ date: t.date,  type: "buy" })),
    ...congressTrades.map(t => ({ date: t.date,  type: t.type || "buy" })),
  ];

  // Bouw buy/sell punt-datasets: null op elke index behalve waar een trade is
  const buyPoints  = sliceDates.map(d => {
    const hasBuy = allTrades.some(t => t.type === "buy"  && t.date === d);
    return hasBuy ? slicePrices[sliceDates.indexOf(d)] : null;
  });
  const sellPoints = sliceDates.map(d => {
    const hasSell = allTrades.some(t => t.type === "sell" && t.date === d);
    return hasSell ? slicePrices[sliceDates.indexOf(d)] : null;
  });
  const hasAnnotations = buyPoints.some(v => v !== null) || sellPoints.some(v => v !== null);

  priceChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: sliceDates,
      datasets: [
        {
          data: slicePrices,
          borderColor: lineColor,
          backgroundColor: fillColor,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.15,
        },
        ...(hasAnnotations ? [
          {
            label: "Koop",
            data: buyPoints,
            borderColor: "transparent",
            backgroundColor: "#3fb950",
            pointRadius: 6,
            pointHoverRadius: 8,
            pointStyle: "circle",
            showLine: false,
            fill: false,
          },
          {
            label: "Verkoop",
            data: sellPoints,
            borderColor: "transparent",
            backgroundColor: "#f85149",
            pointRadius: 6,
            pointHoverRadius: 8,
            pointStyle: "circle",
            showLine: false,
            fill: false,
          },
        ] : []),
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#161b22",
          borderColor: "#30363d",
          borderWidth: 1,
          titleColor: "#8b949e",
          bodyColor: "#e6edf3",
          callbacks: {
            title: ctx => ctx[0].label,
            label: ctx => {
              if (ctx.datasetIndex > 0) {
                return ctx.datasetIndex === 1 ? " ● Koop" : " ● Verkoop";
              }
              const pct = ((ctx.raw / startPrice - 1) * 100).toFixed(2);
              const sign = pct >= 0 ? "+" : "";
              return ` ${ctx.raw.toFixed(2)}  (${sign}${pct}%)`;
            },
          }
        }
      },
      scales: {
        x: {
          grid: { color: "rgba(48,54,61,0.4)" },
          ticks: {
            color: "#8b949e",
            maxTicksLimit: maxTicks,
            maxRotation: 0,
          }
        },
        y: {
          position: "right",
          grid: { color: "rgba(48,54,61,0.4)" },
          ticks: {
            color: "#8b949e",
            callback: v => v.toFixed(2),
          }
        }
      }
    }
  });
}

// ── Sort column click handler ──────────────────────────────
function setupSortHandlers() {
  document.querySelectorAll("thead th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortAsc = !sortAsc;
      } else {
        sortCol = col;
        sortAsc = col === "ticker" || col === "index"; // strings default asc
      }
      document.querySelectorAll("thead th").forEach(h => {
        h.classList.remove("active-sort", "asc");
      });
      th.classList.add("active-sort");
      if (sortAsc) th.classList.add("asc");
      showCount = 20;
      renderTable();
    });
  });
}

// ── Filter handlers ────────────────────────────────────────
function setupFilterHandlers() {
  document.getElementById("index-filters").addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    document.querySelectorAll("#index-filters .filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeIndex = btn.dataset.index;
    showCount = 20;
    renderTable();
  });

  document.getElementById("score-filters").addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    document.querySelectorAll("#score-filters .filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeMinScore = parseInt(btn.dataset.min, 10);
    showCount = 20;
    renderTable();
  });

  document.getElementById("search-box").addEventListener("input", e => {
    searchQuery = e.target.value.trim();
    showCount = 20;
    renderTable();
  });

  document.getElementById("show-more-btn").addEventListener("click", () => {
    showCount += 20;
    renderTable();
  });

  // Escape sluit modal
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      document.getElementById("modal-overlay").classList.add("hidden");
      document.body.style.overflow = "";
      if (priceChart) { priceChart.destroy(); priceChart = null; }
    }
  });
}

// ── Data laden ─────────────────────────────────────────────
async function loadData() {
  const loading = document.getElementById("loading-banner");
  const noData  = document.getElementById("no-data-banner");
  const main    = document.getElementById("main-content");

  try {
    const [scoresRes, pricesRes, metaRes, newsRes, insiderRes, congressRes] = await Promise.all([
      fetch("data/scores.json"),
      fetch("data/prices.json"),
      fetch("data/metadata.json"),
      fetch("data/news.json"),
      fetch("data/insider_trades.json"),
      fetch("data/congress_trades.json"),
    ]);

    if (!scoresRes.ok) throw new Error("scores.json niet gevonden");

    const scores = await scoresRes.json();
    pricesData   = pricesRes.ok   ? await pricesRes.json()   : {};
    const meta   = metaRes.ok     ? await metaRes.json()     : {};
    newsData     = newsRes.ok     ? await newsRes.json()     : {};
    insiderData  = insiderRes.ok  ? await insiderRes.json()  : {};
    congressData = congressRes.ok ? await congressRes.json() : {};

    allRankings = scores.rankings || [];

    // Header vullen
    const dt = new Date(scores.generated_at);
    const dateStr = dt.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
    const timeStr = dt.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("last-updated").textContent = `Bijgewerkt: ${dateStr} ${timeStr}`;
    document.getElementById("subtitle").textContent =
      `${meta.tickers_with_data || allRankings.length} aandelen · AEX · DAX · CAC40 · S&P500`;

    loading.classList.add("hidden");
    main.classList.remove("hidden");

    renderTopPicks();
    renderTable();
    setupSortHandlers();
    setupFilterHandlers();
    if (typeof setupDashboardTab === "function") setupDashboardTab();
    if (typeof setupAccountTab === "function") setupAccountTab();

  } catch (err) {
    loading.classList.add("hidden");
    noData.classList.remove("hidden");
    console.error("Laad fout:", err);
  }
}

// ── Start ──────────────────────────────────────────────────
window._startApp = loadData;
document.addEventListener("DOMContentLoaded", () => authInit());
