/* ── AI Trading Engine ─────────────────────────────────────────
   Volledig automatisch systeem dat trades doet op basis van:
   - Rankings scores (RSI, MACD, MA, momentum, fundamentals)
   - Insider trades (SEC Form 4)
   - Congress trades (PTR disclosures)
   - Nieuws sentiment
   - Verplichte AI check via OpenRouter (ondersteunt Claude, GPT-4o, Gemini, etc.)
   ──────────────────────────────────────────────────────────── */

// ── State ──────────────────────────────────────────────────────
let ptState = {
  running:          false,
  intervalId:       null,
  priceRefreshId:   null,   // elke 15 minuten posities/stats opnieuw renderen
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
async function ptInit() {
  await ptLoadFromStorage();
  ptRenderAll();
  ptBindSettings();
  ptStartPriceRefresh();
  // Auto-restart als het systeem actief was bij vorige sessie
  if (ptState._savedRunning && ptState.portfolio.startDate) {
    console.log('[PT] Auto-restart: systeem was actief, hervatten...');
    ptState.running = true;
    document.getElementById('pt-start-btn').classList.add('hidden');
    document.getElementById('pt-stop-btn').classList.remove('hidden');
    document.getElementById('pt-engine-badge').textContent = 'ACTIEF';
    document.getElementById('pt-engine-badge').className   = 'pt-badge pt-badge-on';
    ptSetStatus('Systeem hervat (was actief bij vorige sessie) — analyse wordt uitgevoerd...', 'info');
    ptRunCycle();
    ptState.intervalId = setInterval(ptRunCycle, 24 * 60 * 60 * 1000);
  }
}

// ── Prijs refresh elke 15 minuten ──────────────────────────────
function ptStartPriceRefresh() {
  // Voorkom dubbele intervals bij herhaald tab-bezoek
  if (ptState.priceRefreshId) clearInterval(ptState.priceRefreshId);
  ptState.priceRefreshId = setInterval(async () => {
    if (Object.keys(ptState.portfolio.positions).length === 0) return;
    await ptRenderStats();
    await ptRenderPositions();
  }, 15 * 60 * 1000);
}

// ── Storage (server-side via Auth API) ─────────────────────────
async function ptSave() {
  if (!Auth.isLoggedIn()) return;
  try {
    await Auth.saveAiTrading({
      pt_portfolio: ptState.portfolio,
      pt_settings:  ptState.settings,
      pt_llmlog:    ptState.llmLog,
      pt_running:   ptState.running,
    });
  } catch(e) { console.warn('[PT] save error', e); }
}

async function ptLoadFromStorage() {
  if (!Auth.isLoggedIn()) return;
  try {
    const data = await Auth.loadAiTrading();
    if (data.pt_portfolio) ptState.portfolio = { ...ptState.portfolio, ...data.pt_portfolio };
    if (data.pt_settings)  ptState.settings  = { ...ptState.settings,  ...data.pt_settings };
    if (data.pt_llmlog)    ptState.llmLog    = data.pt_llmlog;
    // pt_running wordt apart afgehandeld in ptInit voor auto-restart
    ptState._savedRunning = !!data.pt_running;
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
async function ptStart() {
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
  await ptSave();

  // Eerste run direct, daarna dagelijks (elke 24 uur)
  ptRunCycle();
  ptState.intervalId = setInterval(ptRunCycle, 24 * 60 * 60 * 1000);
}

async function ptStop() {
  ptState.running = false;
  if (ptState.intervalId)     { clearInterval(ptState.intervalId);     ptState.intervalId     = null; }
  if (ptState.priceRefreshId) { clearInterval(ptState.priceRefreshId); ptState.priceRefreshId = null; }

  document.getElementById('pt-start-btn').classList.remove('hidden');
  document.getElementById('pt-stop-btn').classList.add('hidden');
  document.getElementById('pt-engine-badge').textContent = 'GESTOPT';
  document.getElementById('pt-engine-badge').className   = 'pt-badge pt-badge-off';
  ptSetStatus('Systeem gestopt.', 'muted');
  await ptSave();
}

function ptRunNow() {
  ptReadSettings();
  ptSetStatus('Handmatige analyse gestart...', 'info');
  ptRunCycle();
}

async function ptReset() {
  if (!confirm('Weet je zeker dat je het AI trading portfolio wilt resetten? Alle posities en trades worden gewist.')) return;
  await ptStop();
  ptState.portfolio = {
    startCapital: parseFloat(document.getElementById('pt-capital').value) || 100,
    cash:         parseFloat(document.getElementById('pt-capital').value) || 100,
    startDate:    null,
    positions:    {},
    trades:       [],
    snapshots:    [],
  };
  ptState.llmLog = [];
  await ptSave();
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

    await ptSave();
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

    // AI check is altijd verplicht — zonder key worden aankopen geblokkeerd
    {
      ptSetStatus(`AI check voor ${ticker}...`, 'info');
      const llmVerdict = await ptLlmCheck(candidate, combinedScore, insiderData, congressData, newsData);

      ptState.llmLog.unshift({
        ticker,
        date:             new Date().toISOString(),
        verdict:          llmVerdict.verdict || (llmVerdict.buy ? 'BUY' : 'DO NOT BUY'),
        reason:           llmVerdict.reason,
        conviction:       llmVerdict.conviction,
        score:            combinedScore,
        logBlock:         llmVerdict.logBlock         || null,
        falseNegative:    llmVerdict.falseNegativeFlag || false,
        fullResponse:     llmVerdict.fullResponse     || '',
      });
      if (ptState.llmLog.length > 50) ptState.llmLog = ptState.llmLog.slice(0, 50);
      ptRenderLlmLog();

      if (!llmVerdict.buy) {
        console.log(`[PT] AI adviseert NIET te kopen: ${ticker} — ${llmVerdict.reason}`);
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

// ── AI Check via OpenRouter ────────────────────────────────────
async function ptLlmCheck(ranking, combinedScore, insiderData, congressData, newsData) {
  const apiKey = ptState.settings.openrouterKey;
  const model  = ptState.settings.openrouterModel || 'anthropic/claude-haiku-4-5';
  if (!apiKey) return { buy: false, reason: 'Geen OpenRouter API-sleutel ingesteld — koop geblokkeerd' };

  const insider  = insiderData[ranking.ticker]  || { buy_count: 0, sell_count: 0, recent: [] };
  const congress = congressData[ranking.ticker] || { buy_count: 0, sell_count: 0, recent: [] };
  const news     = newsData[ranking.ticker]     || { articles: [], sentiment_avg: null };

  const hasInsider  = insider.buy_count > 0  || insider.sell_count > 0;
  const hasCongress = congress.buy_count > 0 || congress.sell_count > 0;

  const recentNews = (news.articles || []).slice(0, 5).map(a =>
    `- ${a.title} [${a.sentiment || 'neutral'}]`
  ).join('\n') || 'No recent news available.';

  const recentInsider = hasInsider
    ? `Buys: ${insider.buy_count} | Sells: ${insider.sell_count} (last 90 days)`
    : 'No insider trade data available.';

  const recentCongress = hasCongress
    ? `Buys: ${congress.buy_count} | Sells: ${congress.sell_count} (last 90 days)\n` +
      (congress.recent || []).slice(0, 5).map(t =>
        `- ${t.representative} (${t.party}): ${t.type.toUpperCase()} ${t.amount} on ${t.date}`
      ).join('\n')
    : 'No congress trade data available.';

  const week52PctFromLow = ranking.week52_low
    ? (((ranking.price - ranking.week52_low) / ranking.week52_low) * 100).toFixed(1)
    : 'N/A';
  const week52PctFromHigh = ranking.week52_high
    ? (((ranking.price - ranking.week52_high) / ranking.week52_high) * 100).toFixed(1)
    : 'N/A';

  const systemPrompt = `# MASTER PROMPT — Stock Intelligence Analyst

## Role & Expertise
You are an elite investment analyst combining the discipline of a hedge fund CIO,
a forensic researcher, and a quantitative screener. You are analytical, skeptical,
data-driven, and conservative with confidence. Your goal is not to hype trades,
but to determine whether buying a specific stock is rational, risk-aware,
and evidence-based.

---

## Input Data
You will receive structured stock data containing some or all of the following:

- Ticker, index, sector, current price
- Momentum (1D / 1M / 3M)
- Technical indicators (RSI, 50MA, 200MA, 52-week range)
- Fundamentals (P/E, Forward P/E, revenue growth, earnings growth)
- Composite score (0–100)
- Insider trades (90 days): number of buys vs sells
- Congress trades (90 days): number of buys vs sells, names, amounts, dates
- Recent news headlines with sentiment labels

---

## Analysis Framework

### STEP 1 — QUICK SCREEN
Based on composite score, momentum, and sentiment:
- Is this stock worth deeper analysis? (Pass / Borderline / Reject)
- Flag any immediate red flags or standout strengths.
- If clearly not worth pursuing: state why and stop here.

---

### STEP 2 — DEEP STOCK ANALYSIS
Only proceed if Step 1 result is Pass or Borderline.

**2A. Rankings & Valuation**
- Is the stock cheap, fairly valued, or stretched based on P/E and Forward P/E?
- How does valuation compare to sector norms?
- Any notable analyst upgrades or downgrades implied by the data?

**2B. Technical Picture**
- Is the stock in an uptrend? (price vs 50MA, 200MA)
- Is momentum healthy or overextended? (RSI, 1M/3M momentum)
- Is the entry point attractive or late?

**2C. Fundamentals**
- Is revenue and earnings growth sustainable?
- Are there any red flags in the financial profile?

**2D. News Sentiment**
- What is the overall sentiment signal (Bullish / Neutral / Bearish)?
- Are there upcoming catalysts or risks visible in the headlines?
- Has sentiment recently shifted, and if so, why?

---

### STEP 3 — INSIDER & CONGRESS TRADE ANALYSIS
⚠️ Only perform this step if insider or congress trades are present in the input data.
If no trades are present, skip entirely and write:
"No insider or congress trade data available — verdict based on Step 2 only."

**3A. Trader Assessment**
Classify each trader as High-signal / Medium-signal / Low-signal based on:
- Direct informational advantage (executive, board member, relevant committee)
- Trade history: frequency, consistency, past outcomes (if inferable)
- Possible non-alpha motives: hedging, optics, scheduled/rule-based trades,
  diversification

**3B. Trade Quality & Structure**
- Buy or sell? (Buys are generally stronger signals than sells)
- Trade size: significant or negligible relative to typical transaction size?
- Instrument: common stock or options (note strike/expiry if available)
- Timing: does it coincide with earnings, regulation, government contracts,
  or major announcements?
- Conviction-based or routine?

**3C. Information Advantage**
- Could this trader plausibly have material non-public insight?
- Does the timing suggest anticipation of a specific event?
- Clearly separate signal from speculation.

**3D. Copy-Trade Risk Factors**
Explicitly list:
- Reasons this trade signal might be misleading
- Unknown or delayed information
- Market conditions that could negate the thesis

---

### STEP 4 — FINAL VERDICT

**Pillar Scores (1–10):**
| Pillar                      | Score  |
|-----------------------------|--------|
| Technical Analysis          | x/10   |
| Fundamentals                | x/10   |
| News Sentiment              | x/10   |
| Insider / Congress Signal   | x/10 or N/A |

**Overall Conviction Score: XX / 100**

**Investment Thesis (3–5 sentences):**
Summarise why this stock is or is not a compelling buy right now,
combining all available signals. Flag any conflicting signals between pillars.

**Suggested Action:**
- Entry strategy: full position / partial / wait for confirmation
- Position size: small / moderate / high conviction
- Key price levels or events to monitor before acting
- Stop-loss logic if the thesis breaks down

---

## Output Format (STRICT)

STEP 1 — QUICK SCREEN: [Pass / Borderline / Reject + one-line reason]

STEP 2 — DEEP ANALYSIS:
[Structured findings per sub-section 2A through 2D]

STEP 3 — INSIDER / CONGRESS ANALYSIS:
[Findings per sub-section 3A through 3D]
[OR: "N/A — no insider or congress trade data present"]

STEP 4 — FINAL VERDICT:
[Pillar score table]
CONVICTION SCORE: XX / 100
THESIS: [3–5 sentences]
VERDICT: [BUY | HOLD | DO NOT BUY]
REASON: [one sentence]
ACTION: [entry strategy, position size, key levels, stop-loss]

---

## Strict Output Rules
⚠️ VERDICT must be exactly one of: BUY | HOLD | DO NOT BUY
No other values are permitted. Do not add qualifiers like "STRONG" or "AVOID".
If Step 1 returns Reject, skip Steps 2–4 and output VERDICT: DO NOT BUY with reason.

---

## LOG OUTPUT (mandatory, append to every response)

After your VERDICT and ACTION, always output the following block exactly as shown.
Do not skip fields. Use "N/A" if a value is not available.

LOG:
  ticker:              [e.g. AAPL]
  timestamp:           [YYYY-MM-DD HH:MM UTC]
  composite_score_in:  [xx/100]
  step1_result:        [Pass | Borderline | Reject]
  step1_reason:        [one sentence]
  step2_completed:     [Yes | No]
  pillar_technical:    [x/10 | N/A]
  pillar_fundamental:  [x/10 | N/A]
  pillar_sentiment:    [x/10 | N/A]
  pillar_insider:      [x/10 | N/A]
  insider_present:     [Yes | No]
  congress_present:    [Yes | No]
  conviction_score:    [xx/100 | N/A]
  verdict:             [BUY | HOLD | DO NOT BUY]
  tokens_saved:        [Yes | No]`;

  const userMessage = `## Stock Data

**Ticker:** ${ranking.ticker} (${ranking.name})
**Index:** ${ranking.index} | **Sector:** ${ranking.sector || 'Unknown'}
**Current Price:** $${ranking.price} | **1D:** ${ranking.change_1d?.toFixed(2) || 0}% | **1M:** ${ranking.mom_1m?.toFixed(2) || 0}% | **3M:** ${ranking.mom_3m?.toFixed(2) || 0}%

**Technical Indicators:**
- RSI: ${ranking.rsi_value?.toFixed(1) || 'N/A'}
- 50MA: ${ranking.ma50?.toFixed(2) || 'N/A'} | 200MA: ${ranking.ma200?.toFixed(2) || 'N/A'}
- 52w Low: $${ranking.week52_low || 'N/A'} (+${week52PctFromLow}%) | 52w High: $${ranking.week52_high || 'N/A'} (${week52PctFromHigh}%)

**Fundamentals:**
- P/E: ${ranking.pe?.toFixed(1) || 'N/A'} | Forward P/E: ${ranking.forward_pe?.toFixed(1) || 'N/A'}
- Revenue Growth: ${ranking.revenue_growth !== undefined ? (ranking.revenue_growth * 100).toFixed(1) + '%' : 'N/A'}
- Earnings Growth: ${ranking.earnings_growth !== undefined ? (ranking.earnings_growth * 100).toFixed(1) + '%' : 'N/A'}

**Composite Score:** ${combinedScore.toFixed(1)} / 100

**Insider Trades (90 days):**
${recentInsider}

**Congress Trades (90 days):**
${recentCongress}

**Recent News:**
${recentNews}`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  window.location.origin,
        'X-Title':       'Portfolio Analyser AI Trading',
      },
      body: JSON.stringify({
        model:      model,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenRouter fout: ${resp.status} ${err.slice(0, 150)}`);
    }

    const data    = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse VERDICT (BUY / HOLD / DO NOT BUY), REASON, CONVICTION SCORE
    const verdictMatch = content.match(/VERDICT:\s*(BUY|HOLD|DO NOT BUY)/i);
    const reasonMatch  = content.match(/REASON:\s*(.+)/i);
    const convMatch    = content.match(/CONVICTION SCORE:\s*(\d+)/i);

    const verdictStr = verdictMatch ? verdictMatch[1].toUpperCase() : 'HOLD';
    const buy        = verdictStr === 'BUY';
    const reason     = reasonMatch ? reasonMatch[1].trim() : content.slice(0, 200);
    const conviction = convMatch   ? parseInt(convMatch[1]) : null;

    // Parse structured LOG block
    const logBlock = ptParseLogBlock(content);

    // False-negative detectie: DO NOT BUY maar conviction >= 50
    const falseNegativeFlag = !buy && conviction !== null && conviction >= 50;
    if (falseNegativeFlag) {
      console.warn(`[PT] ⚠️ Mogelijke false negative: ${ranking.ticker} — VERDICT=${verdictStr} maar conviction=${conviction}/100`);
    }

    return { buy, verdict: verdictStr, reason, conviction, logBlock, falseNegativeFlag, fullResponse: content };

  } catch (e) {
    console.error('[PT] AI check fout:', e);
    return { buy: false, verdict: 'DO NOT BUY', reason: `AI niet beschikbaar (${e.message}) — koop geblokkeerd` };
  }
}

// ── LOG block parser ───────────────────────────────────────────
function ptParseLogBlock(content) {
  const logMatch = content.match(/LOG:\s*\n([\s\S]+?)(?:\n\n|$)/);
  if (!logMatch) return null;

  const log = {};
  const lines = logMatch[1].split('\n');
  for (const line of lines) {
    const m = line.match(/^\s+(\w+):\s*(.+)/);
    if (m) log[m[1].trim()] = m[2].trim();
  }
  return Object.keys(log).length > 0 ? log : null;
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
    logEl.innerHTML = '<div class="pt-llm-empty">Nog geen AI analyses uitgevoerd.</div>';
    return;
  }

  logEl.innerHTML = log.slice(0, 20).map((entry, i) => {
    const date       = new Date(entry.date).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
    const verdict    = entry.verdict || 'UNKNOWN';
    const isBuy      = verdict === 'BUY';
    const isHold     = verdict === 'HOLD';
    const badgeCls   = isBuy ? 'pt-buy' : isHold ? 'pt-hold' : 'pt-sell';
    const conviction = entry.conviction !== null && entry.conviction !== undefined
      ? `<span class="pt-llm-conviction">conviction: ${entry.conviction}/100</span>`
      : '';
    const fnFlag = entry.falseNegative
      ? `<span class="pt-llm-fn-flag" title="Mogelijke false negative: DO NOT BUY maar conviction ≥ 50">⚠️ false neg?</span>`
      : '';
    const step1 = entry.logBlock?.step1_result
      ? `<span class="pt-llm-step1">step1: ${entry.logBlock.step1_result}</span>`
      : '';
    const fullBtn = entry.fullResponse
      ? `<button class="pt-llm-full-btn" onclick="ptShowFullAnalysis(${i})">volledige analyse ↗</button>`
      : '';
    return `<div class="pt-llm-entry ${entry.falseNegative ? 'pt-llm-entry-fn' : ''}">
      <div class="pt-llm-header">
        <strong>${entry.ticker}</strong>
        <span class="pt-llm-verdict ${badgeCls}">${verdict}</span>
        <span class="pt-llm-score">score: ${entry.score?.toFixed(1) || '—'}</span>
        ${conviction}
        ${step1}
        ${fnFlag}
        <span class="pt-llm-date">${date}</span>
        ${fullBtn}
      </div>
      <div class="pt-llm-reason">${entry.reason}</div>
    </div>`;
  }).join('');
}

function ptShowFullAnalysis(index) {
  const entry = ptState.llmLog[index];
  if (!entry || !entry.fullResponse) return;

  // Toon in een overlay modal
  let overlay = document.getElementById('pt-analysis-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pt-analysis-overlay';
    overlay.className = 'pt-analysis-overlay';
    overlay.innerHTML = `
      <div class="pt-analysis-modal">
        <div class="pt-analysis-header">
          <span id="pt-analysis-title"></span>
          <button onclick="document.getElementById('pt-analysis-overlay').classList.add('hidden')">✕</button>
        </div>
        <pre id="pt-analysis-body" class="pt-analysis-body"></pre>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }

  document.getElementById('pt-analysis-title').textContent =
    `${entry.ticker} — AI Analyse (${new Date(entry.date).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })})`;
  document.getElementById('pt-analysis-body').textContent = entry.fullResponse;
  overlay.classList.remove('hidden');
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
  await ptSave();
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
async function onAiTradingTabActivated() {
  await ptLoadFromStorage();
  ptRenderAll();
}
