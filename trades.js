/* ─────────────────────────────────────────────────────────
   Trades pagina — Form 4 insider trades & Congress trades
   ───────────────────────────────────────────────────────── */

let _tradesInited    = false;
let _tradesSubtab    = "insider";
let _tradesSortCol   = "score";
let _tradesSortAsc   = false;
let _tradesSearchVal = "";

function initTradesTab() {
  if (!_tradesInited) {
    _tradesInited = true;

    // Sub-tab knoppen
    document.querySelectorAll(".trades-subtab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".trades-subtab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _tradesSubtab = btn.dataset.subtab;
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

    // Sorteer headers
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

  _renderTradesTable();
}

function _buildTradesRows() {
  // Combineer insider/congress data met scores voor naam en index
  const isInsider = _tradesSubtab === "insider";
  const source    = isInsider ? insiderData : congressData;

  // Bouw rijen op
  const rows = [];
  for (const [ticker, data] of Object.entries(source)) {
    if (ticker.startsWith("_")) continue;

    // Naam en index uit allRankings
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

  // Panel zichtbaarheid
  document.getElementById("trades-insider-panel").classList.toggle("hidden", !isInsider);
  document.getElementById("trades-congress-panel").classList.toggle("hidden", isInsider);

  let rows = _buildTradesRows();

  // Filter op zoekterm
  if (_tradesSearchVal) {
    rows = rows.filter(r =>
      r.ticker.toLowerCase().includes(_tradesSearchVal) ||
      r.name.toLowerCase().includes(_tradesSearchVal)
    );
  }

  // Alleen rijen met activiteit tonen (buy of sell > 0)
  rows = rows.filter(r => r.buy_count + r.sell_count > 0);

  // Sorteren
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
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Geen trades gevonden.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const scoreClass = r.score >= 70 ? "score-hi" : r.score >= 50 ? "score-mid" : "score-low";
    const recentHtml = r.recent.length === 0 ? "—" : r.recent.map(t => {
      if (isInsider) {
        const secUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${t.accession}`;
        return `<span class="trades-filing">
          <span class="trades-filing-date">${t.date}</span>
          <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${t.accession.split('-')[0]}&type=4&dateb=&owner=include&count=10" target="_blank" class="trades-filing-link" title="${t.accession}">Form 4 ↗</a>
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
      <td class="trades-buy">${r.buy_count}</td>
      <td class="trades-sell">${r.sell_count > 0 ? r.sell_count : "—"}</td>
      <td><span class="score-badge ${scoreClass}">${r.score.toFixed(0)}</span></td>
      <td class="trades-recent">${recentHtml}</td>
    </tr>`;
  }).join("");

  // Sorteer-indicator bijwerken
  const allTables = isInsider
    ? document.querySelectorAll("#trades-insider-panel .trades-sortable")
    : document.querySelectorAll("#trades-congress-panel .trades-sortable");
  allTables.forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === _tradesSortCol) {
      th.classList.add(_tradesSortAsc ? "sort-asc" : "sort-desc");
    }
  });
}
