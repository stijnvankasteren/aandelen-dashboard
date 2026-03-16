/* ─────────────────────────────────────────────────────────
   Trades pagina — Form 4 insider trades & Congress trades
   ───────────────────────────────────────────────────────── */

let _tradesListenersInited = false;
let _tradesSubtab    = "insider";
let _tradesSortCol   = "score";
let _tradesSortAsc   = false;
let _tradesSearchVal = "";

function initTradesTab() {
  console.log("[Trades] initTradesTab called, insiderData:", typeof insiderData, Object.keys(insiderData || {}).length, "keys");
  if (!_tradesListenersInited) {
    _tradesListenersInited = true;

    // Sub-tab knoppen
    document.querySelectorAll(".trades-subtab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".trades-subtab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _tradesSubtab  = btn.dataset.subtab;
        _tradesSortCol = "score";
        _tradesSortAsc = false;
        _renderTradesTable();
      });
    });

    // Zoeken
    document.getElementById("trades-search").addEventListener("input", e => {
      _tradesSearchVal = e.target.value.trim().toLowerCase();
      _renderTradesTable();
    });

    // Sorteer headers — beide panels
    document.querySelectorAll(".trades-sortable").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (_tradesSortCol === col) {
          _tradesSortAsc = !_tradesSortAsc;
        } else {
          _tradesSortCol = col;
          _tradesSortAsc = col === "ticker" || col === "name";
        }
        _renderTradesTable();
      });
    });
  }

  // Reset zoekbalk en subtab visueel
  document.getElementById("trades-search").value = "";
  _tradesSearchVal = "";
  document.querySelectorAll(".trades-subtab").forEach(b => {
    b.classList.toggle("active", b.dataset.subtab === _tradesSubtab);
  });

  _renderTradesTable();
}

function _buildTradesRows() {
  const isInsider = _tradesSubtab === "insider";
  const source    = isInsider ? (insiderData || {}) : (congressData || {});

  const rows = [];
  for (const [ticker, data] of Object.entries(source)) {
    if (ticker.startsWith("_")) continue;

    const rankEntry = (allRankings || []).find(r => r.ticker === ticker);
    const name  = rankEntry?.name  || ticker;
    const index = rankEntry?.index || "—";

    rows.push({
      ticker,
      name,
      index,
      buy_count:  data.buy_count  || 0,
      sell_count: data.sell_count || 0,
      score:      data.score      || 50,
      recent:     data.recent     || [],
    });
  }
  return rows;
}

function _renderTradesTable() {
  const isInsider = _tradesSubtab === "insider";
  console.log("[Trades] _renderTradesTable isInsider=", isInsider,
    "insiderData keys:", Object.keys(insiderData || {}).length,
    "congressData keys:", Object.keys(congressData || {}).length);

  document.getElementById("trades-insider-panel").classList.toggle("hidden", !isInsider);
  document.getElementById("trades-congress-panel").classList.toggle("hidden",  isInsider);

  let rows = _buildTradesRows();
  console.log("[Trades] rows built:", rows.length, "after filter:", rows.filter(r => r.buy_count + r.sell_count > 0).length);

  if (_tradesSearchVal) {
    rows = rows.filter(r =>
      r.ticker.toLowerCase().includes(_tradesSearchVal) ||
      r.name.toLowerCase().includes(_tradesSearchVal)
    );
  }

  rows = rows.filter(r => r.buy_count + r.sell_count > 0);

  rows.sort((a, b) => {
    let av = a[_tradesSortCol], bv = b[_tradesSortCol];
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return _tradesSortAsc ? -1 : 1;
    if (av > bv) return _tradesSortAsc ? 1 : -1;
    return 0;
  });

  document.getElementById("trades-count").textContent = `${rows.length} aandelen`;

  const tbodyId = isInsider ? "trades-insider-tbody" : "trades-congress-tbody";
  const tbody   = document.getElementById(tbodyId);

  if (rows.length === 0) {
    const msg = Object.keys(isInsider ? (insiderData || {}) : (congressData || {})).length <= 1
      ? "Geen data beschikbaar. Vernieuw de data eerst."
      : "Geen trades gevonden.";
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const scoreClass = r.score >= 70 ? "score-hi" : r.score >= 50 ? "score-mid" : "score-low";
    const recentHtml = r.recent.length === 0 ? "<span style='color:var(--muted)'>—</span>" : r.recent.map(t => {
      if (isInsider) {
        const cik = t.accession ? t.accession.split("-")[0].replace(/^0+/, "") : "";
        return `<span class="trades-filing">
          <span class="trades-filing-date">${t.date}</span>
          <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&dateb=&owner=include&count=10" target="_blank" class="trades-filing-link">Form 4 ↗</a>
        </span>`;
      } else {
        const typeClass = t.type === "buy" ? "trades-buy" : "trades-sell";
        return `<span class="trades-filing">
          <span class="trades-filing-date">${t.date}</span>
          <span class="trades-rep">${t.representative || "—"}</span>
          <span class="${typeClass}">${t.type === "buy" ? "Koop" : "Verkoop"}</span>
          ${t.amount ? `<span class="trades-amount">${t.amount}</span>` : ""}
        </span>`;
      }
    }).join("");

    return `<tr>
      <td class="trades-ticker">${r.ticker}</td>
      <td class="trades-name">${r.name}</td>
      <td><span class="index-badge">${r.index}</span></td>
      <td class="${r.buy_count > 0 ? 'trades-buy' : ''}">${r.buy_count || "—"}</td>
      <td class="${r.sell_count > 0 ? 'trades-sell' : ''}">${r.sell_count > 0 ? r.sell_count : "—"}</td>
      <td><span class="score-badge ${scoreClass}">${r.score.toFixed(0)}</span></td>
      <td class="trades-recent">${recentHtml}</td>
    </tr>`;
  }).join("");

  // Sorteer-indicator
  const panelSel = isInsider ? "#trades-insider-panel" : "#trades-congress-panel";
  document.querySelectorAll(`${panelSel} .trades-sortable`).forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === _tradesSortCol) {
      th.classList.add(_tradesSortAsc ? "sort-asc" : "sort-desc");
    }
  });
}
