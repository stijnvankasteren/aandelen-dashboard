/* ── Paper Trading Engine ──────────────────────────────────────
   Volledig automatisch systeem dat trades doet op basis van:
   - Rankings scores (RSI, MACD, MA, momentum, fundamentals)
   - Insider trades (SEC Form 4)
   - Congress trades (PTR disclosures)
   - Nieuws sentiment
   - Optionele LLM check via OpenRouter (ondersteunt Claude, GPT-4o, Gemini, etc.)
   ──────────────────────────────────────────────────────────── */

// ── State ──────────────────────────────────────────────────────
let ptState = {
  running:     false,
  intervalId:  null,
  portfolio: {
    startCapital: 100,
    cash:         100,
    startDate:    null,
    positions:    {},   // ticker -> { shares, buyPrice, buyDate, name, index }
    trades:       [],   // [{date, action, ticker, price, shares, total, reason}]
    snapshots:    [],   // [{date, value}] voor performance chart
  },
  settings: {
    maxPositionPct:  20,
    minScore:        65,
    stopLossPct:     10,
    takeProfitPct:   25,
    maxPositions:    5,
    openrouterKey:   '',
    openrouterModel: 'anthropic/claude-haiku-4-5',
    useRankings:     true,
    useInsider:      true,
    useCongress:     true,
    useNews:         true,
  },
  llmLog:    [],   // [{ticker, date, verdict, reason, score}]
  perfChart: null,
};

// ── Init ───────────────────────────────────────────────────────
function ptInit() {
  ptLoadFromStorage();
  ptRenderAll();
  ptBindSettings();
}

// ── Storage ────────────────────────────────────────────────────
function ptSave() {
  try {
    localStorage.setItem('pt_portfolio', JSON.stringify(ptState.portfolio));
    localStorage.setItem('pt_settings',  JSON.stringify(ptState.settings));
    localStorage.setItem('pt_llmlog',    JSON.stringify(ptState.llmLog));
  } catch(e) { console.warn('[PT] save error', e); }
}

function ptLoadFromStorage() {
  try {
    const p = localStorage.getItem('pt_portfolio');
    const s = localStorage.getItem('pt_settings');
    const l = localStorage.getItem('pt_llmlog');
    if (p) ptState.portfolio = { ...ptState.portfolio, ...JSON.parse(p) };
    if (s) ptState.settings  = { ...ptState.settings,  ...JSON.parse(s) };
    if (l) ptState.llmLog    = JSON.parse(l);
  } catch(e) { console.warn('[PT] load error', e); }
}

// ── Settings binding ───────────────────────────────────────────
function ptBindSettings() {
  const s = ptState.settings;
  document.getElementById('pt-capital').value        = ptState.portfolio.startCapital || 100;
  document.getElementById('pt-max-position').value   = s.maxPositionPct;
  document.getElementById('pt-min-score').value      = s.minScore;
  document.getElementById('pt-stop-loss').value      = s.stopLossPct;
  document.getElementById('pt-take-profit').value    = s.takeProfitPct;
  document.getElementById('pt-max-positions').value  = s.maxPositions;
  document.getElementById('pt-openrouter-key').value   = s.openrouterKey   || '';
  document.getElementById('pt-openrouter-model').value = s.openrouterModel || 'anthropic/claude-haiku-4-5';
  document.getElementById('pt-use-rankings').checked = s.useRankings;
  document.getElementById('pt-use-insider').checked  = s.useInsider;
  document.getElementById('pt-use-congress').checked = s.useCongress;
  document.getElementById('pt-use-news').checked     = s.useNews;
}

function ptReadSettings() {
  ptState.settings.maxPositionPct  = parseFloat(document.getElementById('pt-max-position').value) || 10;
  ptState.settings.minScore        = parseFloat(document.getElementById('pt-min-score').value)    || 65;
  ptState.settings.stopLossPct     = parseFloat(document.getElementById('pt-stop-loss').value)    || 10;
  ptState.settings.takeProfitPct   = parseFloat(document.getElementById('pt-take-profit').value)  || 25;
  ptState.settings.maxPositions    = parseInt(document.getElementById('pt-max-positions').value)   || 5;
  ptState.settings.openrouterKey   = document.getElementById('pt-openrouter-key').value.trim();
  ptState.settings.openrouterModel = document.getElementById('pt-openrouter-model').value.trim();
  ptState.settings.useRankings     = document.getElementById('pt-use-rankings').checked;
  ptState.settings.useInsider      = document.getElementById('pt-use-insider').checked;
  ptState.settings.useCongress     = document.getElementById('pt-use-congress').checked;
  ptState.settings.useNews         = document.getElementById('pt-use-news').checked;
}

// ── Start / Stop ───────────────────────────────────────────────
function ptStart() {
  ptReadSettings();

  const capitalInput = parseFloat(document.getElementById('pt-capital').value);
  if (!ptState.portfolio.startDate) {
    // Eerste start: initialiseer portfolio
    ptState.portfolio.startCapital = capitalInput;
    ptState.portfolio.cash         = capitalInput;
    ptState.portfolio.startDate    = new Date().toISOString();
    ptState.portfolio.positions    = {};
    ptState.portfolio.trades       = [];
    ptState.portfolio.snapshots    = [];
  }

  ptState.running = true;
  document.getElementById('pt-start-btn').classList.add('hidden');
  document.getElementById('pt-stop-btn').classList.remove('hidden');
  document.getElementById('pt-engine-badge').textContent   = 'ACTIEF';
  document.getElementById('pt-engine-badge').className     = 'pt-badge pt-badge-on';

  ptSetStatus('Systeem gestart — eerste analyse wordt uitgevoerd...', 'info');
  ptSave();

  // Eerste run direct, daarna dagelijks (elke 24 uur)
  ptRunCycle();
  ptState.intervalId = setInterval(ptRunCycle, 24 * 60 * 60 * 1000);
}

function ptStop() {
  ptState.running = false;
  if (ptState.intervalId) { clearInterval(ptState.intervalId); ptState.intervalId = null; }

  document.getElementById('pt-start-btn').classList.remove('hidden');
  document.getElementById('pt-stop-btn').classList.add('hidden');
  document.getElementById('pt-engine-badge').textContent = 'GESTOPT';
  document.getElementById('pt-engine-badge').className   = 'pt-badge pt-badge-off';
  ptSetStatus('Systeem gestopt.', 'muted');
  ptSave();
}

function ptRunNow() {
  ptReadSettings();
  ptSetStatus('Handmatige analyse gestart...', 'info');
  ptRunCycle();
}

function ptReset() {
  if (!confirm('Weet je zeker dat je het paper trading portfolio wilt resetten? Alle posities en trades worden gewist.')) return;
  ptStop();
  ptState.portfolio = {
    startCapital: parseFloat(document.getElementById('pt-capital').value) || 100,
    cash:         parseFloat(document.getElementById('pt-capital').value) || 100,
    startDate:    null,
    positions:    {},
    trades:       [],
    snapshots:    [],
  };
  ptState.llmLog = [];
  ptSave();
  ptRenderAll();
  ptSetStatus('Portfolio gereset.', 'muted');
}

// ── Core Cycle ─────────────────────────────────────────────────
async function ptRunCycle() {
  ptSetStatus('Marktdata analyseren...', 'info');

  try {
    // Haal actuele rankings, insider en congress data op
    const [rankings, insiderData, congressData, newsData] = await Promise.all([
      ptGetRankings(),
      ptGetInsiderData(),
      ptGetCongressData(),
      ptGetNewsData(),
    ]);

    if (!rankings || rankings.length === 0) {
      ptSetStatus('Geen rankingdata beschikbaar. Ververs de data eerst.', 'warn');
      return;
    }

    const now = new Date().toISOString();

    // 1. Controleer bestaande posities op stop-loss / take-profit / score verslechtering
    await ptCheckExitSignals(rankings, insiderData, congressData, newsData);

    // 2. Zoek nieuwe koopmogelijkheden
    await ptCheckEntrySignals(rankings, insiderData, congressData, newsData);

    // 3. Sla dagelijkse snapshot op voor performance grafiek
    ptTakeSnapshot();

    ptSave();
    ptRenderAll();
    ptSetStatus(`Analyse compleet om ${new Date().toLocaleTimeString('nl-NL')}. Volgende dagelijkse check over 24 uur.`, 'ok');

  } catch (err) {
    ptSetStatus(`Fout tijdens analyse: ${err.message}`, 'error');
    console.error('[PT] cycle error', err);
  }
}

// ── Data fetchers ──────────────────────────────────────────────
async function ptGetRankings() {
  // Gebruik de al geladen allRankings variabele uit app.js indien beschikbaar
  if (typeof allRankings !== 'undefined' && allRankings && allRankings.length > 0) {
    return allRankings;
  }
  try {
    const resp = await fetch('scores.json?_=' + Date.now());
    const data = await resp.json();
    return data.rankings || [];
  } catch(e) { return []; }
}

async function ptGetInsiderData() {
  if (typeof insiderData !== 'undefined' && insiderData) return insiderData;
  try {
    const resp = await fetch('insider_trades.json?_=' + Date.now());
    return await resp.json();
  } catch(e) { return {}; }
}

async function ptGetCongressData() {
  if (typeof congressData !== 'undefined' && congressData) return congressData;
  try {
    const resp = await fetch('congress_trades.json?_=' + Date.now());
    return await resp.json();
  } catch(e) { return {}; }
}

async function ptGetNewsData() {
  if (typeof newsData !== 'undefined' && newsData) return newsData;
  try {
    const resp = await fetch('news.json?_=' + Date.now());
    return await resp.json();
  } catch(e) { return {}; }
}

// ── Exit signals (verkopen) ────────────────────────────────────
async function ptCheckExitSignals(rankings, insiderData, congressData, newsData) {
  const positions = ptState.portfolio.positions;
  const rankMap   = {};
  for (const r of rankings) rankMap[r.ticker] = r;

  for (const [ticker, pos] of Object.entries(positions)) {
    const rank    = rankMap[ticker];
    const current = rank ? rank.price : null;
    if (!current) continue;

    const pnlPct  = ((current - pos.buyPrice) / pos.buyPrice) * 100;
    const s       = ptState.settings;
    let shouldSell = false;
    let reason     = '';

    // Stop-loss
    if (pnlPct <= -s.stopLossPct) {
      shouldSell = true;
      reason     = `Stop-loss geraakt (${pnlPct.toFixed(1)}%)`;
    }
    // Take-profit
    else if (pnlPct >= s.takeProfitPct) {
      shouldSell = true;
      reason     = `Take-profit geraakt (${pnlPct.toFixed(1)}%)`;
    }
    // Score te laag geworden
    else if (rank && rank.composite_score < (s.minScore - 15)) {
      shouldSell = true;
      reason     = `Score gedaald naar ${rank.composite_score.toFixed(1)} (min: ${s.minScore})`;
    }

    if (shouldSell) {
      ptExecuteSell(ticker, current, reason);
    }
  }
}

// ── Entry signals (kopen) ──────────────────────────────────────
async function ptCheckEntrySignals(rankings, insiderData, congressData, newsData) {
  const s           = ptState.settings;
  const positions   = ptState.portfolio.positions;
  const numPositions = Object.keys(positions).length;

  if (numPositions >= s.maxPositions) return;

  const maxNewPositions = s.maxPositions - numPositions;
  let   bought          = 0;

  // Sorteer op composite score (hoogste eerst)
  const candidates = rankings
    .filter(r => {
      if (positions[r.ticker]) return false; // al in bezit
      if (s.useRankings && r.composite_score < s.minScore) return false;
      return true;
    })
    .sort((a, b) => b.composite_score - a.composite_score);

  for (const candidate of candidates) {
    if (bought >= maxNewPositions) break;

    const ticker = candidate.ticker;

    // Bereken gecombineerde score op basis van actieve signalen
    const combinedScore = ptComputeCombinedScore(candidate, insiderData, congressData, newsData);
    if (combinedScore < s.minScore) continue;

    // Bereken hoeveel we kunnen kopen
    const maxAmount = ptState.portfolio.cash * (s.maxPositionPct / 100);
    if (maxAmount < 1) break; // Geen saldo meer

    const price  = candidate.price;
    if (!price || price <= 0) continue;

    // Ondersteun fractional shares (afgerond op 4 decimalen) voor kleine portfolios
    const shares = Math.round((maxAmount / price) * 10000) / 10000;
    if (shares < 0.001) continue;

    const totalCost = shares * price;
    if (totalCost > ptState.portfolio.cash) continue;

    // LLM check is altijd verplicht — zonder key worden aankopen geblokkeerd
    {
      ptSetStatus(`LLM check voor ${ticker}...`, 'info');
      const llmVerdict = await ptLlmCheck(candidate, combinedScore, insiderData, congressData, newsData);

      ptState.llmLog.unshift({
        ticker,
        date:    new Date().toISOString(),
        verdict: llmVerdict.buy ? 'KOPEN' : 'NIET KOPEN',
        reason:  llmVerdict.reason,
        score:   combinedScore,
      });
      if (ptState.llmLog.length > 50) ptState.llmLog = ptState.llmLog.slice(0, 50);
      ptRenderLlmLog();

      if (!llmVerdict.buy) {
        console.log(`[PT] LLM adviseert NIET te kopen: ${ticker} — ${llmVerdict.reason}`);
        continue;
      }
    }

    // Koop uitvoeren
    ptExecuteBuy(ticker, candidate.name, candidate.index, price, shares,
      `Score ${combinedScore.toFixed(1)}, insider: ${candidate.insider_buy_count || 0} buys, congress: ${candidate.congress_buy_count || 0} buys`);
    bought++;
  }
}

// ── Gecombineerde score berekening ─────────────────────────────
function ptComputeCombinedScore(ranking, insiderData, congressData, newsData) {
  const s = ptState.settings;
  let score = ranking.composite_score;

  if (!s.useRankings) score = 50; // neutraal als rankings uitgeschakeld

  let boosts = 0;
  let boostCount = 0;

  // Insider boost
  if (s.useInsider) {
    const insider = insiderData[ranking.ticker];
    if (insider && insider.buy_count > 0) {
      const ratio = insider.buy_count / (insider.buy_count + (insider.sell_count || 0) + 1);
      boosts += ratio * 20;
      boostCount++;
    }
  }

  // Congress boost
  if (s.useCongress) {
    const congress = congressData[ranking.ticker];
    if (congress && congress.buy_count > 0) {
      const ratio = congress.buy_count / (congress.buy_count + (congress.sell_count || 0) + 1);
      boosts += ratio * 15;
      boostCount++;
    }
  }

  // Nieuws sentiment boost
  if (s.useNews) {
    const news = newsData[ranking.ticker];
    if (news && news.sentiment_avg !== null) {
      const sentimentBoost = news.sentiment_avg * 10;
      boosts += sentimentBoost;
      boostCount++;
    }
  }

  if (boostCount > 0) {
    score = score + (boosts / boostCount);
  }

  return Math.max(0, Math.min(100, score));
}

// ── Trade uitvoering ───────────────────────────────────────────
function ptExecuteBuy(ticker, name, index, price, shares, reason) {
  const total = shares * price;
  ptState.portfolio.cash -= total;
  ptState.portfolio.positions[ticker] = {
    shares, buyPrice: price, buyDate: new Date().toISOString(), name, index
  };
  ptState.portfolio.trades.unshift({
    date:   new Date().toISOString(),
    action: 'BUY',
    ticker, price, shares, total, reason
  });
  ptSetStatus(`GEKOCHT: ${shares}x ${ticker} @ €${price.toFixed(2)} (${reason})`, 'ok');
  console.log(`[PT] BUY ${shares}x ${ticker} @ ${price}`);
}

function ptExecuteSell(ticker, price, reason) {
  const pos   = ptState.portfolio.positions[ticker];
  if (!pos) return;
  const total = pos.shares * price;
  const pnl   = total - (pos.shares * pos.buyPrice);
  ptState.portfolio.cash += total;
  delete ptState.portfolio.positions[ticker];
  ptState.portfolio.trades.unshift({
    date:   new Date().toISOString(),
    action: 'SELL',
    ticker, price, shares: pos.shares, total, reason,
    pnl, pnlPct: (pnl / (pos.shares * pos.buyPrice)) * 100
  });
  ptSetStatus(`VERKOCHT: ${pos.shares}x ${ticker} @ €${price.toFixed(2)} — ${reason}`, pnl >= 0 ? 'ok' : 'warn');
  console.log(`[PT] SELL ${pos.shares}x ${ticker} @ ${price} (${reason})`);
}

// ── Snapshot voor performance grafiek ─────────────────────────
async function ptTakeSnapshot() {
  let investedValue = 0;
  try {
    const rankings = await ptGetRankings();
    const rankMap  = {};
    for (const r of rankings) rankMap[r.ticker] = r;

    for (const [ticker, pos] of Object.entries(ptState.portfolio.positions)) {
      const r = rankMap[ticker];
      investedValue += pos.shares * (r ? r.price : pos.buyPrice);
    }
  } catch(e) {}

  const totalValue = ptState.portfolio.cash + investedValue;
  const today      = new Date().toISOString().slice(0, 10);

  // Vervang snapshot van vandaag of voeg toe
  const idx = ptState.portfolio.snapshots.findIndex(s => s.date === today);
  if (idx >= 0) {
    ptState.portfolio.snapshots[idx].value = totalValue;
  } else {
    ptState.portfolio.snapshots.push({ date: today, value: totalValue });
  }
}

// ── LLM Check via OpenRouter ───────────────────────────────────
async function ptLlmCheck(ranking, combinedScore, insiderData, congressData, newsData) {
  const apiKey = ptState.settings.openrouterKey;
  const model  = ptState.settings.openrouterModel || 'anthropic/claude-haiku-4-5';
  if (!apiKey) return { buy: false, reason: 'Geen OpenRouter API-sleutel ingesteld — koop geblokkeerd' };

  const insider  = insiderData[ranking.ticker]  || { buy_count: 0, sell_count: 0 };
  const congress = congressData[ranking.ticker] || { buy_count: 0, sell_count: 0 };
  const news     = newsData[ranking.ticker]     || { articles: [], sentiment_avg: null };

  const recentNews = (news.articles || []).slice(0, 3).map(a =>
    `- ${a.title} (${a.sentiment || 'neutraal'})`
  ).join('\n') || 'Geen recent nieuws beschikbaar.';

  const recentCongress = (congress.recent || []).slice(0, 3).map(t =>
    `- ${t.representative} (${t.party}): ${t.type} ${t.amount} op ${t.date}`
  ).join('\n') || 'Geen recente congress trades.';

  const prompt = `Je bent een professionele aandelenanalist. Analyseer of het verstandig is om dit aandeel te kopen op basis van de volgende data:

**Ticker:** ${ranking.ticker} (${ranking.name})
**Index:** ${ranking.index}
**Sector:** ${ranking.sector || 'onbekend'}
**Huidige prijs:** €${ranking.price}
**1D wijziging:** ${ranking.change_1d?.toFixed(2) || 0}%
**1M momentum:** ${ranking.mom_1m?.toFixed(2) || 0}%
**3M momentum:** ${ranking.mom_3m?.toFixed(2) || 0}%

**Technische analyse:**
- RSI: ${ranking.rsi_value?.toFixed(1) || 'n.v.t.'}
- 50MA: ${ranking.ma50?.toFixed(2) || 'n.v.t.'} | 200MA: ${ranking.ma200?.toFixed(2) || 'n.v.t.'}
- Koers vs 52w laag: +${ranking.week52_low ? (((ranking.price - ranking.week52_low) / ranking.week52_low) * 100).toFixed(1) : 'n.v.t.'}%

**Fundamenten:**
- P/E: ${ranking.pe?.toFixed(1) || 'n.v.t.'} | Forward P/E: ${ranking.forward_pe?.toFixed(1) || 'n.v.t.'}
- Omzetgroei: ${ranking.revenue_growth !== undefined ? (ranking.revenue_growth * 100).toFixed(1) + '%' : 'n.v.t.'}
- Winstgroei: ${ranking.earnings_growth !== undefined ? (ranking.earnings_growth * 100).toFixed(1) + '%' : 'n.v.t.'}

**Composite score:** ${combinedScore.toFixed(1)}/100

**Insider trades (90 dagen):**
- Aankopen: ${insider.buy_count} | Verkopen: ${insider.sell_count}

**Congress trades (90 dagen):**
- Aankopen: ${congress.buy_count} | Verkopen: ${congress.sell_count}
${recentCongress}

**Recent nieuws (sentiment):**
${recentNews}

Geef een bondige analyse in maximaal 3 zinnen. Sluit af met een duidelijk KOPEN of NIET KOPEN advies, gevolgd door de reden in één zin.

Antwoordformaat:
VERDICT: [KOPEN|NIET KOPEN]
REDEN: [één zin]`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  window.location.origin,
        'X-Title':       'Portfolio Analyser Paper Trading',
      },
      body: JSON.stringify({
        model:      model,
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenRouter fout: ${resp.status} ${err.slice(0, 150)}`);
    }

    const data    = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse VERDICT en REDEN
    const verdictMatch = content.match(/VERDICT:\s*(KOPEN|NIET KOPEN)/i);
    const redenMatch   = content.match(/REDEN:\s*(.+)/i);

    const buy    = verdictMatch ? verdictMatch[1].toUpperCase() === 'KOPEN' : true;
    const reason = redenMatch   ? redenMatch[1].trim() : content.slice(0, 150);

    return { buy, reason, fullResponse: content };

  } catch (e) {
    console.error('[PT] LLM check fout:', e);
    // Bij fout: blokkeer koop (fail safe — geen geld riskeren zonder LLM check)
    return { buy: false, reason: `LLM niet beschikbaar (${e.message}) — koop geblokkeerd` };
  }
}

// ── Render functies ────────────────────────────────────────────
async function ptRenderAll() {
  ptRenderStats();
  await ptRenderPositions();
  ptRenderTradeLog();
  ptRenderLlmLog();
  ptRenderPerfChart();
}

async function ptRenderStats() {
  const p = ptState.portfolio;

  // Bereken huidige waarde van posities
  let investedValue = 0;
  const rankings = await ptGetRankings().catch(() => []);
  const rankMap  = {};
  for (const r of rankings) rankMap[r.ticker] = r;

  for (const [ticker, pos] of Object.entries(p.positions)) {
    const r = rankMap[ticker];
    investedValue += pos.shares * (r ? r.price : pos.buyPrice);
  }

  const totalValue = p.cash + investedValue;
  const returnPct  = p.startCapital > 0
    ? ((totalValue - p.startCapital) / p.startCapital) * 100
    : 0;

  document.getElementById('pt-stat-start').textContent    = ptFmt(p.startCapital);
  document.getElementById('pt-stat-total').textContent    = ptFmt(totalValue);
  document.getElementById('pt-stat-cash').textContent     = ptFmt(p.cash);
  document.getElementById('pt-stat-invested').textContent = ptFmt(investedValue);

  const retEl = document.getElementById('pt-stat-return');
  retEl.textContent  = (returnPct >= 0 ? '+' : '') + returnPct.toFixed(2) + '%';
  retEl.className    = 'pt-stat-value ' + (returnPct >= 0 ? 'pos' : 'neg');

  document.getElementById('pt-stat-since').textContent = p.startDate
    ? new Date(p.startDate).toLocaleDateString('nl-NL')
    : '—';
}

async function ptRenderPositions() {
  const positions   = ptState.portfolio.positions;
  const tbody       = document.getElementById('pt-positions-tbody');
  const emptyEl     = document.getElementById('pt-positions-empty');
  const countEl     = document.getElementById('pt-positions-count');
  const tickers     = Object.keys(positions);

  countEl.textContent = tickers.length ? `(${tickers.length})` : '';

  if (tickers.length === 0) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const rankings = await ptGetRankings().catch(() => []);
  const rankMap  = {};
  for (const r of rankings) rankMap[r.ticker] = r;

  tbody.innerHTML = tickers.map(ticker => {
    const pos     = positions[ticker];
    const rank    = rankMap[ticker];
    const current = rank ? rank.price : pos.buyPrice;
    const value   = pos.shares * current;
    const pnl     = value - (pos.shares * pos.buyPrice);
    const pnlPct  = ((current - pos.buyPrice) / pos.buyPrice) * 100;
    const score   = rank ? rank.composite_score : null;
    const buyDate = new Date(pos.buyDate).toLocaleDateString('nl-NL');

    return `<tr>
      <td><strong>${ticker}</strong></td>
      <td class="pt-name-col">${pos.name || ticker}</td>
      <td>${buyDate}</td>
      <td>${ptFmt(pos.buyPrice)}</td>
      <td>${ptFmt(current)}</td>
      <td>${pos.shares}</td>
      <td>${ptFmt(value)}</td>
      <td class="${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${ptFmt(pnl)}</td>
      <td class="${pnlPct >= 0 ? 'pos' : 'neg'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</td>
      <td><span class="score-badge ${ptScoreClass(score)}">${score !== null ? score.toFixed(0) : '—'}</span></td>
      <td>
        <button class="btn-danger btn-sm pt-sell-btn"
          onclick="ptManualSell('${ticker}', ${current})">Verkoop</button>
      </td>
    </tr>`;
  }).join('');
}

function ptRenderTradeLog() {
  const trades  = ptState.portfolio.trades;
  const tbody   = document.getElementById('pt-tradelog-tbody');
  const emptyEl = document.getElementById('pt-tradelog-empty');
  const countEl = document.getElementById('pt-tradelog-count');

  countEl.textContent = trades.length ? `(${trades.length})` : '';

  if (trades.length === 0) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  tbody.innerHTML = trades.slice(0, 100).map(t => {
    const date    = new Date(t.date).toLocaleDateString('nl-NL');
    const isBuy   = t.action === 'BUY';
    const pnlStr  = t.pnl !== undefined
      ? ` <span class="${t.pnl >= 0 ? 'pos' : 'neg'}">(${t.pnl >= 0 ? '+' : ''}${ptFmt(t.pnl)})</span>`
      : '';
    return `<tr>
      <td>${date}</td>
      <td><span class="pt-action-badge ${isBuy ? 'pt-buy' : 'pt-sell'}">${t.action}</span></td>
      <td><strong>${t.ticker}</strong></td>
      <td>${ptFmt(t.price)}</td>
      <td>${t.shares}</td>
      <td>${ptFmt(t.total)}${pnlStr}</td>
      <td class="pt-reason-col">${t.reason || ''}</td>
    </tr>`;
  }).join('');
}

function ptRenderLlmLog() {
  const log   = ptState.llmLog;
  const logEl = document.getElementById('pt-llm-log');

  if (log.length === 0) {
    logEl.innerHTML = '<div class="pt-llm-empty">Nog geen LLM analyses uitgevoerd.</div>';
    return;
  }

  logEl.innerHTML = log.slice(0, 20).map(entry => {
    const date    = new Date(entry.date).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
    const isKopen = entry.verdict === 'KOPEN';
    return `<div class="pt-llm-entry">
      <div class="pt-llm-header">
        <strong>${entry.ticker}</strong>
        <span class="pt-llm-verdict ${isKopen ? 'pt-buy' : 'pt-sell'}">${entry.verdict}</span>
        <span class="pt-llm-score">score: ${entry.score?.toFixed(1) || '—'}</span>
        <span class="pt-llm-date">${date}</span>
      </div>
      <div class="pt-llm-reason">${entry.reason}</div>
    </div>`;
  }).join('');
}

function ptRenderPerfChart() {
  const snaps   = ptState.portfolio.snapshots;
  const canvas  = document.getElementById('pt-perf-canvas');
  if (!canvas) return;

  if (snaps.length === 0) {
    if (ptState.perfChart) { ptState.perfChart.destroy(); ptState.perfChart = null; }
    return;
  }

  const labels = snaps.map(s => s.date);
  const values = snaps.map(s => s.value);
  const start  = ptState.portfolio.startCapital;

  // Genormaliseerde waarden (basis 100)
  const normalised = values.map(v => (v / start) * 100);

  const color = normalised[normalised.length - 1] >= 100
    ? 'rgba(63, 185, 80, 0.85)'
    : 'rgba(248, 81, 73, 0.85)';

  if (ptState.perfChart) ptState.perfChart.destroy();

  ptState.perfChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label:           'Portfolio (basis 100)',
        data:            normalised,
        borderColor:     color,
        backgroundColor: color.replace('0.85', '0.1'),
        fill:            true,
        tension:         0.3,
        pointRadius:     2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 8 }, grid: { color: '#30363d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
      },
    },
  });
}

// ── Handmatig verkopen vanuit positie tabel ────────────────────
async function ptManualSell(ticker, price) {
  if (!confirm(`Wil je ${ticker} handmatig verkopen @ €${price.toFixed(2)}?`)) return;
  ptExecuteSell(ticker, price, 'Handmatig verkocht');
  ptSave();
  await ptRenderAll();
}

// ── Helpers ────────────────────────────────────────────────────
function ptFmt(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('nl-NL', {
    style:    'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
}

function ptScoreClass(score) {
  if (score === null || score === undefined) return '';
  if (score >= 70) return 'score-high';
  if (score >= 50) return 'score-mid';
  return 'score-low';
}

function ptSetStatus(msg, type = 'info') {
  const el = document.getElementById('pt-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className   = `pt-status-msg pt-status-${type}`;
}

// ── Tab activatie hook ─────────────────────────────────────────
// Wordt aangeroepen vanuit app.js wanneer de tab actief wordt
function onPaperTradingTabActivated() {
  ptLoadFromStorage();
  ptRenderAll();
}
