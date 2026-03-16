#!/usr/bin/env python3
"""
Portfolio Analyse - Data Fetcher
Haal dagelijks koersen en fundamentele data op via Yahoo Finance.
Schrijft JSON bestanden die de HTML webapp leest.

Gebruik:
    python3 fetch_data.py
"""

import json
import os
import sys
import time
import math
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, date

try:
    import yfinance as yf
    import pandas as pd
except ImportError:
    print("Installeer eerst de vereiste packages:")
    print("  pip install yfinance pandas")
    sys.exit(1)

# ─────────────────────────────────────────────
# Configuratie
# ─────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UNIVERSE_FILE = os.path.join(DATA_DIR, "universe.json")
PRICES_FILE = os.path.join(DATA_DIR, "prices.json")
FUNDAMENTALS_FILE = os.path.join(DATA_DIR, "fundamentals.json")
SCORES_FILE = os.path.join(DATA_DIR, "scores.json")
METADATA_FILE = os.path.join(DATA_DIR, "metadata.json")
NEWS_FILE = os.path.join(DATA_DIR, "news.json")
SEC_CIK_MAP_FILE = os.path.join(DATA_DIR, "sec_cik_map.json")
INSIDER_FILE = os.path.join(DATA_DIR, "insider_trades.json")
CONGRESS_FILE = os.path.join(DATA_DIR, "congress_trades.json")

PRICE_PERIOD = "1y"        # 1 jaar voor indicators
CHART_DAYS = 365           # Sla laatste 365 dagen op voor grafiek (1W/1M/3M/1Y periodes)
SLEEP_BETWEEN_INFO = 0.3   # Seconden tussen fundamentele fetches
EDGAR_SLEEP = 0.12         # Stay under SEC 10 req/sec limit
INSIDER_LOOKBACK = 90      # Dagen terugkijken voor Form 4 en congress trades
SEC_USER_AGENT = "portfolio-analyser admin@localhost.local"
NEWS_MAX_ARTICLES = 5      # Max artikelen per ticker
NEWS_TIMEOUT = 8           # Seconden timeout per RSS request

# Sentiment keywords
POSITIVE_WORDS = {
    "beat", "beats", "upgrade", "upgraded", "buy", "strong", "growth",
    "record", "profit", "surge", "surges", "rise", "rises", "gain", "gains",
    "outperform", "bullish", "raises", "raised", "lifted", "exceeds", "exceed",
    "positive", "boost", "boosted", "rally", "rallies", "higher", "top",
    "exceed", "exceeded", "best", "high", "increase", "increased", "up",
}
NEGATIVE_WORDS = {
    "miss", "misses", "missed", "downgrade", "downgraded", "sell", "weak",
    "loss", "decline", "declines", "fall", "falls", "drop", "drops", "cut",
    "cuts", "underperform", "bearish", "lowers", "lowered", "disappoints",
    "warning", "lawsuit", "fraud", "recall", "layoff", "layoffs", "bankrupt",
    "concern", "concerns", "risk", "risks", "debt", "probe", "investigation",
    "lower", "down", "below", "worse", "negative", "reduce", "reduced",
}


# ─────────────────────────────────────────────
# Technische indicator functies
# ─────────────────────────────────────────────

def compute_rsi(close, period=14):
    """Bereken RSI(14) voor een pandas Series."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def compute_macd(close, fast=12, slow=26, signal=9):
    """Bereken MACD, signaal en histogram."""
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


# ─────────────────────────────────────────────
# Score normalisatie functies
# ─────────────────────────────────────────────

def score_rsi(rsi_value):
    if rsi_value is None or math.isnan(rsi_value):
        return 50.0
    if rsi_value <= 25:
        return 100.0
    elif rsi_value <= 35:
        return 100.0 - (rsi_value - 25) * 2.0
    elif rsi_value <= 50:
        return 80.0 - (rsi_value - 35) * 2.0
    elif rsi_value <= 65:
        return 50.0 - (rsi_value - 50) * (20.0 / 15.0)
    elif rsi_value <= 75:
        return 30.0 - (rsi_value - 65) * 2.0
    else:
        return max(0.0, 10.0 - (rsi_value - 75) * 2.0)


def score_macd(histogram_series):
    """Beoordeel MACD histogram op basis van crossovers."""
    if histogram_series is None or len(histogram_series) < 4:
        return 50.0
    h = histogram_series.dropna()
    if len(h) < 4:
        return 50.0
    current = h.iloc[-1]
    prev3 = h.iloc[-4:-1]
    crossover = (current > 0) and (prev3 < 0).any()
    if crossover:
        return 100.0
    elif current > 0 and current > h.iloc[-2]:
        return 75.0
    elif current > 0:
        return 55.0
    elif current < 0 and current > h.iloc[-2]:
        return 30.0
    elif current < 0 and (prev3 > 0).any():
        return 10.0
    else:
        return 20.0


def score_ma_trend(price, ma50, ma200):
    """Beoordeel trend op basis van moving averages."""
    if any(v is None or math.isnan(v) for v in [price, ma50, ma200]):
        return 50.0
    above_50 = price > ma50
    above_200 = price > ma200
    golden_cross = ma50 > ma200
    if above_50 and above_200 and golden_cross:
        return 100.0
    elif above_50 and above_200:
        return 80.0
    elif above_50 and not above_200:
        return 55.0
    elif not above_50 and above_200:
        return 35.0
    elif not above_50 and not above_200 and golden_cross:
        return 20.0
    else:
        return 10.0


def score_pe_vs_sector(pe_ratio, sector_median):
    """P/E relatief aan sector - lager is beter."""
    if pe_ratio is None or sector_median is None:
        return 50.0
    if math.isnan(pe_ratio) or math.isnan(sector_median) or sector_median == 0:
        return 50.0
    if pe_ratio <= 0:
        return 30.0
    ratio = pe_ratio / sector_median
    if ratio < 0.5:
        return 100.0
    elif ratio < 0.7:
        return 85.0
    elif ratio < 0.9:
        return 70.0
    elif ratio < 1.1:
        return 50.0
    elif ratio < 1.3:
        return 30.0
    elif ratio < 1.6:
        return 15.0
    else:
        return 5.0


def score_growth(growth_value):
    """Groeipercentage normaliseren naar 0-100."""
    if growth_value is None or math.isnan(growth_value):
        return 50.0
    pct = growth_value * 100
    if pct >= 25:
        return 100.0
    elif pct >= 15:
        return 85.0
    elif pct >= 10:
        return 70.0
    elif pct >= 5:
        return 55.0
    elif pct >= 0:
        return 40.0
    elif pct >= -5:
        return 25.0
    else:
        return 10.0


def percentile_rank(values_dict):
    """Bereken percentielrang voor alle waarden in een dict."""
    valid = {k: v for k, v in values_dict.items() if v is not None and not math.isnan(v)}
    if not valid:
        return {k: 50.0 for k in values_dict}
    sorted_vals = sorted(valid.values())
    n = len(sorted_vals)
    result = {}
    for k, v in values_dict.items():
        if k not in valid:
            result[k] = 50.0
        else:
            idx = sorted_vals.index(v)
            result[k] = (idx / (n - 1)) * 100 if n > 1 else 50.0
    return result


# ─────────────────────────────────────────────
# Gewichten voor composite score
# ─────────────────────────────────────────────
WEIGHTS = {
    "rsi":            0.12,
    "macd":           0.12,
    "ma_trend":       0.12,
    "momentum_1m":    0.08,
    "momentum_3m":    0.12,
    "pe_vs_sector":   0.11,
    "revenue_growth": 0.08,
    "earnings_growth":0.06,
    "news":           0.09,
    "insider":        0.05,
    "congress":       0.05,
}


def score_news(sentiment_avg):
    """Normaliseer nieuws sentiment gemiddelde naar 0-100."""
    if sentiment_avg is None:
        return 50.0
    if sentiment_avg >= 1.5:
        return 90.0
    elif sentiment_avg >= 0.5:
        return 70.0
    elif sentiment_avg >= 0.0:
        return 55.0
    elif sentiment_avg >= -0.5:
        return 40.0
    elif sentiment_avg >= -1.0:
        return 25.0
    else:
        return 15.0


def score_insider(buy_count, sell_count):
    """Normaliseer insider buy/sell ratio naar 0-100."""
    total = buy_count + sell_count
    if total == 0:
        return 50.0
    ratio = buy_count / total
    if ratio >= 0.9:
        return 90.0
    elif ratio >= 0.7:
        return 70.0 + (ratio - 0.7) * (20.0 / 0.2)
    elif ratio >= 0.5:
        return 45.0 + (ratio - 0.5) * (25.0 / 0.2)
    elif ratio >= 0.3:
        return 25.0 + (ratio - 0.3) * (20.0 / 0.2)
    else:
        return max(15.0, ratio * (25.0 / 0.3))


def score_congress(buy_count, sell_count):
    """Normaliseer congress buy/sell ratio naar 0-100."""
    total = buy_count + sell_count
    if total == 0:
        return 50.0
    ratio = buy_count / total
    if ratio >= 0.8:
        return 80.0
    elif ratio >= 0.6:
        return 65.0
    elif ratio >= 0.4:
        return 50.0
    elif ratio >= 0.2:
        return 35.0
    else:
        return 20.0


def compute_composite(scores):
    return sum(scores.get(k, 50.0) * w for k, w in WEIGHTS.items())


# ─────────────────────────────────────────────
# Hulpfuncties
# ─────────────────────────────────────────────

def safe_float(val):
    """Converteer naar float of None."""
    try:
        f = float(val)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def load_universe():
    with open(UNIVERSE_FILE) as f:
        data = json.load(f)
    tickers = []
    ticker_to_index = {}
    for idx_name, idx_data in data["indices"].items():
        for t in idx_data["tickers"]:
            if t not in ticker_to_index:
                tickers.append(t)
                ticker_to_index[t] = idx_name
    return tickers, ticker_to_index, data["indices"]


# ─────────────────────────────────────────────
# Stap 1: Koersen ophalen
# ─────────────────────────────────────────────

def fetch_prices(tickers):
    print(f"  Koersen ophalen voor {len(tickers)} aandelen...")
    try:
        raw = yf.download(
            tickers,
            period=PRICE_PERIOD,
            interval="1d",
            auto_adjust=True,
            progress=False,
            timeout=60,
        )
    except Exception as e:
        print(f"  FOUT bij ophalen koersen: {e}")
        return {}

    if raw.empty:
        print("  Geen koersen ontvangen.")
        return {}

    # Normaliseer kolommen (multi-level vs single ticker)
    if isinstance(raw.columns, pd.MultiIndex):
        close_df = raw["Close"]
    else:
        # Één ticker
        close_df = pd.DataFrame({tickers[0]: raw["Close"]})

    prices = {}
    for ticker in tickers:
        if ticker not in close_df.columns:
            continue
        series = close_df[ticker].dropna()
        if len(series) < 20:
            continue
        prices[ticker] = series

    print(f"  {len(prices)} tickers met voldoende koershistorie.")
    return prices


# ─────────────────────────────────────────────
# Stap 2: Fundamentele data ophalen
# ─────────────────────────────────────────────

def load_cached_fundamentals():
    """Laad gecachede fundamentals als die van vandaag zijn."""
    if not os.path.exists(FUNDAMENTALS_FILE):
        return None
    try:
        with open(FUNDAMENTALS_FILE) as f:
            data = json.load(f)
        cached_date = data.get("_date")
        if cached_date == date.today().isoformat():
            print("  Fundamentals van vandaag al gecached, sla fetch over.")
            return data
    except Exception:
        pass
    return None


def fetch_fundamentals(tickers):
    cached = load_cached_fundamentals()
    if cached:
        return cached

    print(f"  Fundamentele data ophalen voor {len(tickers)} aandelen (dit duurt ~1-2 minuten)...")
    result = {"_date": date.today().isoformat()}
    for i, ticker in enumerate(tickers, 1):
        try:
            info = yf.Ticker(ticker).info
            result[ticker] = {
                "name": info.get("longName") or info.get("shortName") or ticker,
                "sector": info.get("sector"),
                "pe": safe_float(info.get("trailingPE")),
                "forward_pe": safe_float(info.get("forwardPE")),
                "revenue_growth": safe_float(info.get("revenueGrowth")),
                "earnings_growth": safe_float(info.get("earningsGrowth")),
                "week52_low": safe_float(info.get("fiftyTwoWeekLow")),
                "week52_high": safe_float(info.get("fiftyTwoWeekHigh")),
                "market_cap": safe_float(info.get("marketCap")),
                "currency": info.get("currency", ""),
            }
        except Exception as e:
            print(f"    Waarschuwing: {ticker} - {e}")
            result[ticker] = {"name": ticker, "sector": None, "pe": None,
                              "forward_pe": None, "revenue_growth": None,
                              "earnings_growth": None, "week52_low": None,
                              "week52_high": None, "market_cap": None, "currency": ""}
        if i % 10 == 0:
            print(f"    {i}/{len(tickers)} verwerkt...")
        time.sleep(SLEEP_BETWEEN_INFO)

    with open(FUNDAMENTALS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  Fundamentals opgeslagen.")
    return result


# ─────────────────────────────────────────────
# Stap 3: Sector mediaan P/E berekenen
# ─────────────────────────────────────────────

def compute_sector_medians(fundamentals, tickers):
    sector_pes = {}
    for ticker in tickers:
        info = fundamentals.get(ticker, {})
        sector = info.get("sector")
        pe = info.get("pe")
        if sector and pe and pe > 0:
            sector_pes.setdefault(sector, []).append(pe)
    medians = {}
    for sector, pes in sector_pes.items():
        sorted_pes = sorted(pes)
        n = len(sorted_pes)
        medians[sector] = sorted_pes[n // 2]
    return medians


# ─────────────────────────────────────────────
# Stap 4: Alles combineren en scores berekenen
# ─────────────────────────────────────────────

def compute_all_scores(prices, fundamentals, sector_medians, ticker_to_index,
                       news=None, insider=None, congress=None):
    raw_indicators = {}  # Ruwe waarden voor output

    mom_1m = {}
    mom_3m = {}

    for ticker, close in prices.items():
        if len(close) < 14:
            continue

        price = float(close.iloc[-1])
        prev_1m = float(close.iloc[-22]) if len(close) >= 22 else float(close.iloc[0])
        prev_3m = float(close.iloc[-66]) if len(close) >= 66 else float(close.iloc[0])
        prev_1d = float(close.iloc[-2]) if len(close) >= 2 else price

        m1 = (price / prev_1m - 1) * 100
        m3 = (price / prev_3m - 1) * 100
        mom_1m[ticker] = m1
        mom_3m[ticker] = m3

        rsi_series = compute_rsi(close)
        _, _, histogram = compute_macd(close)
        ma50 = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else None
        ma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
        rsi_val = float(rsi_series.iloc[-1]) if not rsi_series.empty else None

        raw_indicators[ticker] = {
            "price": round(price, 2),
            "change_1d": round((price / prev_1d - 1) * 100, 2) if prev_1d else 0.0,
            "rsi_value": round(rsi_val, 1) if rsi_val else None,
            "rsi_score": score_rsi(rsi_val),
            "macd_score": score_macd(histogram),
            "ma50": round(ma50, 2) if ma50 else None,
            "ma200": round(ma200, 2) if ma200 else None,
            "ma_trend_score": score_ma_trend(
                price,
                ma50 if ma50 else float("nan"),
                ma200 if ma200 else float("nan"),
            ),
            "mom_1m_value": round(m1, 2),
            "mom_3m_value": round(m3, 2),
        }

    # Percentiel-scores voor momentum (relatief aan hele universe)
    mom_1m_pct = percentile_rank(mom_1m)
    mom_3m_pct = percentile_rank(mom_3m)

    scores = {}
    for ticker, ind in raw_indicators.items():
        info = fundamentals.get(ticker, {})
        sector = info.get("sector")
        pe = info.get("pe")
        sector_median = sector_medians.get(sector) if sector else None
        rev_growth = info.get("revenue_growth")
        earn_growth = info.get("earnings_growth")

        news_info    = (news    or {}).get(ticker, {})
        insider_info = (insider or {}).get(ticker, {})
        congress_info= (congress or {}).get(ticker, {})

        news_sent_avg   = news_info.get("sentiment_avg")
        news_sent_score = news_info.get("sentiment_score", 50.0) if news_info else 50.0

        sub = {
            "rsi":            ind["rsi_score"],
            "macd":           ind["macd_score"],
            "ma_trend":       ind["ma_trend_score"],
            "momentum_1m":    mom_1m_pct.get(ticker, 50.0),
            "momentum_3m":    mom_3m_pct.get(ticker, 50.0),
            "pe_vs_sector":   score_pe_vs_sector(pe, sector_median),
            "revenue_growth": score_growth(rev_growth),
            "earnings_growth":score_growth(earn_growth),
            "news":           news_sent_score,
            "insider":        insider_info.get("score",  50.0),
            "congress":       congress_info.get("score", 50.0),
        }
        composite = compute_composite(sub)

        scores[ticker] = {
            "ticker": ticker,
            "name": info.get("name", ticker),
            "index": ticker_to_index.get(ticker, "?"),
            "sector": sector or "Onbekend",
            "currency": info.get("currency", ""),
            "price": ind["price"],
            "change_1d": ind["change_1d"],
            "mom_1m": ind["mom_1m_value"],
            "mom_3m": ind["mom_3m_value"],
            "rsi_value": ind["rsi_value"],
            "ma50": ind["ma50"],
            "ma200": ind["ma200"],
            "pe": safe_float(pe),
            "forward_pe": safe_float(info.get("forward_pe")),
            "revenue_growth": safe_float(rev_growth),
            "earnings_growth": safe_float(earn_growth),
            "week52_low": safe_float(info.get("week52_low")),
            "week52_high": safe_float(info.get("week52_high")),
            "news_sentiment_avg": news_sent_avg,
            "news_count":         len(news_info.get("articles", [])) if news_info else 0,
            "insider_buy_count":  insider_info.get("buy_count", 0),
            "insider_sell_count": insider_info.get("sell_count", 0),
            "congress_buy_count": congress_info.get("buy_count", 0),
            "congress_sell_count":congress_info.get("sell_count", 0),
            "scores": {k: round(v, 1) for k, v in sub.items()},
            "composite_score": round(composite, 1),
        }

    return scores


# ─────────────────────────────────────────────
# Stap 4b: Nieuws ophalen en sentiment analyseren
# ─────────────────────────────────────────────

def analyze_sentiment(text):
    """Geeft sentiment score voor een tekst op basis van keywords."""
    words = text.lower().split()
    score = sum(1 for w in words if w.strip(".,!?;:\"'") in POSITIVE_WORDS)
    score -= sum(1 for w in words if w.strip(".,!?;:\"'") in NEGATIVE_WORDS)
    return score


def fetch_ticker_news(ticker):
    """Haal RSS nieuws op voor één ticker via Yahoo Finance."""
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=NEWS_TIMEOUT) as resp:
            xml_data = resp.read()
        root = ET.fromstring(xml_data)
        channel = root.find("channel")
        if channel is None:
            return []
        articles = []
        for item in channel.findall("item")[:NEWS_MAX_ARTICLES]:
            title = item.findtext("title", "").strip()
            link  = item.findtext("link", "").strip()
            pub   = item.findtext("pubDate", "").strip()
            desc  = item.findtext("description", "").strip()
            if not title:
                continue
            sent_score = analyze_sentiment(title + " " + desc)
            if sent_score > 0:
                sentiment = "positive"
            elif sent_score < 0:
                sentiment = "negative"
            else:
                sentiment = "neutral"
            articles.append({
                "title": title,
                "url": link,
                "published": pub,
                "sentiment": sentiment,
                "sentiment_score": sent_score,
            })
        return articles
    except Exception:
        return []


def load_cached_news():
    """Laad gecachede nieuws als die van vandaag zijn."""
    if not os.path.exists(NEWS_FILE):
        return None
    try:
        with open(NEWS_FILE) as f:
            data = json.load(f)
        if data.get("_date") == date.today().isoformat():
            print("  Nieuws van vandaag al gecached, sla fetch over.")
            return data
    except Exception:
        pass
    return None


def fetch_all_news(tickers):
    """Haal nieuws op voor alle tickers, met cache."""
    cached = load_cached_news()
    if cached:
        return cached

    print(f"  Nieuws ophalen voor {len(tickers)} aandelen...")
    result = {"_date": date.today().isoformat()}
    ok_count = 0
    for i, ticker in enumerate(tickers, 1):
        articles = fetch_ticker_news(ticker)
        if articles:
            sent_scores = [a["sentiment_score"] for a in articles]
            avg = sum(sent_scores) / len(sent_scores)
            result[ticker] = {
                "sentiment_avg": round(avg, 2),
                "sentiment_score": round(score_news(avg), 1),
                "articles": articles,
            }
            ok_count += 1
        else:
            result[ticker] = {
                "sentiment_avg": None,
                "sentiment_score": 50.0,
                "articles": [],
            }
        # Korte pauze om rate limiting te vermijden
        time.sleep(0.15)
        if i % 20 == 0:
            print(f"    {i}/{len(tickers)} verwerkt ({ok_count} met nieuws)...")

    with open(NEWS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  Nieuws opgeslagen ({ok_count}/{len(tickers)} tickers met artikelen).")
    return result


# ─────────────────────────────────────────────
# Stap 5a: SEC EDGAR CIK map
# ─────────────────────────────────────────────

def fetch_cik_map():
    """
    Laad SEC ticker→CIK mapping. Ververst wekelijks (7-daagse cache).
    Retourneert dict: uppercase_ticker → 10-cijferig CIK string.
    """
    if os.path.exists(SEC_CIK_MAP_FILE):
        try:
            with open(SEC_CIK_MAP_FILE) as f:
                cached = json.load(f)
            from datetime import timedelta
            cached_date = date.fromisoformat(cached.get("_date", "2000-01-01"))
            if (date.today() - cached_date).days < 7:
                print("  SEC CIK map gecached (minder dan 7 dagen oud).")
                return {k: v for k, v in cached.items() if not k.startswith("_")}
        except Exception:
            pass

    print("  SEC CIK map ophalen van EDGAR...")
    url = "https://www.sec.gov/files/company_tickers.json"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": SEC_USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = json.loads(resp.read())
    except Exception as e:
        print(f"  WAARSCHUWING: CIK map ophalen mislukt: {e}")
        return {}

    cik_map = {}
    for entry in raw.values():
        ticker = (entry.get("ticker") or "").upper()
        cik_raw = entry.get("cik_str")
        if ticker and cik_raw:
            cik_map[ticker] = str(int(cik_raw)).zfill(10)

    to_save = {"_date": date.today().isoformat(), **cik_map}
    with open(SEC_CIK_MAP_FILE, "w") as f:
        json.dump(to_save, f)
    print(f"  CIK map opgeslagen: {len(cik_map)} tickers.")
    return cik_map


# ─────────────────────────────────────────────
# Stap 5b: Form 4 insider trades
# ─────────────────────────────────────────────

def load_cached_insider():
    if not os.path.exists(INSIDER_FILE):
        return None
    try:
        with open(INSIDER_FILE) as f:
            data = json.load(f)
        if data.get("_date") == date.today().isoformat():
            print("  Insider trades van vandaag al gecached.")
            return data
    except Exception:
        pass
    return None


def fetch_insider_trades(tickers, cik_map):
    """
    Haal Form 4 filings op via SEC EDGAR submissions API.
    Telt filings binnen INSIDER_LOOKBACK dagen.
    EU tickers (geen CIK) krijgen neutral score 50.
    """
    cached = load_cached_insider()
    if cached:
        return cached

    from datetime import timedelta
    cutoff = (date.today() - timedelta(days=INSIDER_LOOKBACK)).isoformat()
    result = {"_date": date.today().isoformat()}

    us_tickers = [t for t in tickers if t.upper() in cik_map]
    skipped = len(tickers) - len(us_tickers)
    print(f"  Insider trades ophalen voor {len(us_tickers)} US tickers "
          f"({skipped} EU tickers overgeslagen)...")

    ok_count = 0
    for i, ticker in enumerate(us_tickers, 1):
        cik = cik_map[ticker.upper()]
        url = f"https://data.sec.gov/submissions/CIK{cik}.json"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": SEC_USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                sub = json.loads(resp.read())

            recent = sub.get("filings", {}).get("recent", {})
            forms = recent.get("form", [])
            dates = recent.get("filingDate", [])
            accs  = recent.get("accessionNumber", [])
            descs = recent.get("primaryDocumentDescription", [])

            buy_filings  = []
            sell_filings = []
            for form, fdate, acc, desc in zip(forms, dates, accs, descs or [""]*len(forms)):
                if form != "4":
                    continue
                if fdate < cutoff:
                    break
                desc_upper = (desc or "").upper()
                # "S" = sale/sell, "P" = purchase/buy, rest = onbekend → tel als buy
                if any(w in desc_upper for w in ["SALE", "SELL", " S ", "DISPOSITION"]):
                    sell_filings.append({"date": fdate, "accession": acc, "type": "sell"})
                else:
                    buy_filings.append({"date": fdate, "accession": acc, "type": "buy"})

            all_filings = sorted(buy_filings + sell_filings, key=lambda x: x["date"], reverse=True)
            result[ticker] = {
                "buy_count":  len(buy_filings),
                "sell_count": len(sell_filings),
                "recent":     all_filings[:3],
                "score":      round(score_insider(len(buy_filings), len(sell_filings)), 1),
            }
            if count > 0:
                ok_count += 1

        except Exception as e:
            print(f"    Waarschuwing: {ticker} insider - {e}")
            result[ticker] = {"buy_count": 0, "sell_count": 0, "recent": [], "score": 50.0}

        time.sleep(EDGAR_SLEEP)
        if i % 10 == 0:
            print(f"    {i}/{len(us_tickers)} verwerkt...")

    # EU tickers: neutraal
    for ticker in tickers:
        if ticker not in result:
            result[ticker] = {"buy_count": 0, "sell_count": 0, "recent": [], "score": 50.0}

    with open(INSIDER_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  Insider trades opgeslagen ({ok_count}/{len(us_tickers)} tickers met Form 4 data).")
    return result


# ─────────────────────────────────────────────
# Stap 5c: Congressional trades
# ─────────────────────────────────────────────

def load_cached_congress():
    if not os.path.exists(CONGRESS_FILE):
        return None
    try:
        with open(CONGRESS_FILE) as f:
            data = json.load(f)
        if data.get("_date") != date.today().isoformat():
            return None
        # Alleen als cache ook echt trades bevat
        has_data = any(
            isinstance(v, dict) and (v.get("buy_count", 0) + v.get("sell_count", 0)) > 0
            for k, v in data.items() if not k.startswith("_")
        )
        if not has_data:
            return None
        print("  Congress trades van vandaag al gecached.")
        return data
    except Exception:
        pass
    return None


def _parse_ptr_pdf_text(text, rep_name, filing_date_iso, pdf_url=""):
    """Extraheer ticker/type/datum uit de tekst van een House/Senate PTR PDF."""
    import re as _re
    pattern = _re.compile(
        r"\(([A-Z]{1,5})\)\s*(?:\[[A-Z]+\])?\s*\n?\s*([PS])\s+(\d{1,2}/\d{1,2}/\d{4})",
        _re.MULTILINE,
    )
    trades = []
    for m in pattern.finditer(text):
        ticker   = m.group(1).upper()
        tx_type  = "buy" if m.group(2) == "P" else "sell"
        tx_raw   = m.group(3)
        try:
            mo, dy, yr = tx_raw.split("/")
            tx_date = f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}"
        except Exception:
            tx_date = filing_date_iso
        trades.append({
            "ticker":           ticker,
            "transaction_date": tx_date,
            "transaction_type": "purchase" if tx_type == "buy" else "sale",
            "representative":   rep_name,
            "party":            "",
            "amount":           "",
            "pdf_url":          pdf_url,
        })
    return trades


def _fetch_house_trades():
    """Haal House PTR trades op via disclosures-clerk.house.gov (PDF parsing)."""
    import zipfile, io, time
    try:
        from pypdf import PdfReader
    except ImportError:
        print("  House trades overgeslagen: pypdf niet geïnstalleerd.")
        return []

    from datetime import timedelta
    trades = []
    cutoff_dt = date.today() - timedelta(days=INSIDER_LOOKBACK)
    current_year = date.today().year

    # Stap 1: download FD bulk index ZIP om alle PTR DocIDs te krijgen
    fd_url = f"https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{current_year}FD.zip"
    try:
        req = urllib.request.Request(fd_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            zip_data = resp.read()
        z = zipfile.ZipFile(io.BytesIO(zip_data))
        txt = z.read(f"{current_year}FD.txt").decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  House FD index fout: {e}")
        return trades

    # Parse TSV: Prefix Last First Suffix FilingType StateDst Year FilingDate DocID
    ptr_entries = []
    for line in txt.splitlines()[1:]:
        cols = line.strip().split("\t")
        if len(cols) < 9 or cols[4].strip() != "P":
            continue
        filing_date_raw = cols[7].strip()
        doc_id = cols[8].strip()
        try:
            m, d, y = filing_date_raw.split("/")
            filing_date = date(int(y), int(m), int(d))
        except Exception:
            continue
        if filing_date < cutoff_dt:
            continue
        name = f"{cols[2].strip()} {cols[1].strip()}"
        ptr_entries.append((doc_id, name, filing_date))

    print(f"  House: {len(ptr_entries)} PTR filings binnen {INSIDER_LOOKBACK} dagen, PDFs parsen...")

    # Stap 2: parse per DocID de PDF
    base = f"https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{current_year}/"
    for i, (doc_id, rep_name, filing_date) in enumerate(ptr_entries):
        pdf_url = f"{base}{doc_id}.pdf"
        try:
            req = urllib.request.Request(pdf_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                pdf_data = resp.read()
            reader = PdfReader(io.BytesIO(pdf_data))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            found = _parse_ptr_pdf_text(text, rep_name, filing_date.isoformat(), pdf_url)
            trades.extend(found)
        except Exception:
            continue
        if i > 0 and i % 20 == 0:
            time.sleep(0.5)  # beleefd scrapen

    print(f"  House PTR: {len(trades)} transacties gevonden.")
    return trades


def _fetch_senate_trades():
    """Haal Senate PTR trades op via efdsearch.senate.gov (PDF parsing)."""
    import zipfile, io, urllib.parse, time
    try:
        from pypdf import PdfReader
    except ImportError:
        print("  Senate trades overgeslagen: pypdf niet geïnstalleerd.")
        return []

    from datetime import timedelta
    trades = []
    cutoff_dt = date.today() - timedelta(days=INSIDER_LOOKBACK)

    # Stap 1: zoek PTR filings via Senate EFTS API
    cutoff_from = cutoff_dt.strftime("%m/%d/%Y")
    cutoff_to   = date.today().strftime("%m/%d/%Y")
    search_url  = (
        "https://efts.senate.gov/LATEST/search-index"
        f"?q=%22%22&report_types=ptr"
        f"&dateRange=custom&fromDate={urllib.parse.quote(cutoff_from)}"
        f"&toDate={urllib.parse.quote(cutoff_to)}&resultSize=250"
    )
    ptr_entries = []  # lijst van (senator_name, ptr_link)
    try:
        req = urllib.request.Request(search_url, headers={
            "User-Agent": "Mozilla/5.0",
            "Accept":     "application/json",
            "Referer":    "https://efdsearch.senate.gov/",
        })
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        for hit in data.get("hits", {}).get("hits", []):
            src  = hit.get("_source", {})
            name = f"{src.get('first_name', '')} {src.get('last_name', '')}".strip()
            link = src.get("pdf_link") or src.get("ptr_link") or ""
            if link:
                ptr_entries.append((name, link))
        print(f"  Senate EFTS: {len(ptr_entries)} PTR filings gevonden.")
    except Exception as e:
        print(f"  Senate EFTS zoeken mislukt: {e}")
        return trades

    # Stap 2: parse per PTR link de PDF
    for i, (rep_name, pdf_link) in enumerate(ptr_entries):
        if not pdf_link.startswith("http"):
            pdf_link = "https://efdsearch.senate.gov" + pdf_link
        try:
            req = urllib.request.Request(pdf_link, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                pdf_data = resp.read()
            reader = PdfReader(io.BytesIO(pdf_data))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            found = _parse_ptr_pdf_text(text, rep_name, date.today().isoformat(), pdf_link)
            trades.extend(found)
        except Exception:
            continue
        if i > 0 and i % 20 == 0:
            time.sleep(0.5)

    print(f"  Senate PTR: {len(trades)} transacties gevonden.")
    return trades


def fetch_congress_trades(tickers):
    """
    Haal Senate- en House-trades op via de officiële overheidswebsites.
    Senate: efts.senate.gov EFTS API
    House:  disclosures-clerk.house.gov PTR filings
    Filtert voor onze tickers binnen INSIDER_LOOKBACK dagen.
    """
    cached = load_cached_congress()
    if cached:
        return cached

    print("  Congress trades ophalen...")
    all_trades = []

    # Senate trades via officiële EFTS API
    try:
        all_trades.extend(_fetch_senate_trades())
    except Exception as e:
        print(f"  WAARSCHUWING: Senate trades ophalen mislukt: {e}")

    # House trades via disclosures-clerk.house.gov
    try:
        all_trades.extend(_fetch_house_trades())
    except Exception as e:
        print(f"  WAARSCHUWING: House trades ophalen mislukt: {e}")

    if not all_trades:
        print("  WAARSCHUWING: Congress trades niet beschikbaar. Congress score = neutraal (50).")
        result = {"_date": date.today().isoformat()}
        for ticker in tickers:
            result[ticker] = {"buy_count": 0, "sell_count": 0, "recent": [], "score": 50.0}
        with open(CONGRESS_FILE, "w") as f:
            json.dump(result, f, indent=2)
        return result

    from datetime import timedelta
    cutoff_dt = date.today() - timedelta(days=INSIDER_LOOKBACK)
    cutoff = cutoff_dt.isoformat()
    ticker_set = {t.upper() for t in tickers}
    by_ticker = {}

    for trade in all_trades:
        raw_ticker = (trade.get("ticker") or "").upper().strip()
        if raw_ticker not in ticker_set:
            continue
        tx_date = trade.get("transaction_date") or trade.get("disclosure_date") or ""
        try:
            if "/" in tx_date:
                parts = tx_date.split("/")
                if len(parts) == 3:
                    # MM/DD/YYYY
                    tx_date_iso = f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                else:
                    continue
            else:
                tx_date_iso = tx_date[:10]
        except Exception:
            continue
        if tx_date_iso < cutoff:
            continue

        tx_type_raw = (trade.get("transaction_type") or "").lower()
        if "purchase" in tx_type_raw or "buy" in tx_type_raw:
            tx_type = "buy"
        elif "sale" in tx_type_raw or "sell" in tx_type_raw:
            tx_type = "sell"
        else:
            continue

        by_ticker.setdefault(raw_ticker, []).append({
            "date":           tx_date_iso,
            "representative": trade.get("representative", ""),
            "party":          trade.get("party", ""),
            "type":           tx_type,
            "amount":         trade.get("amount", ""),
            "pdf_url":        trade.get("pdf_url", ""),
        })

    result = {"_date": date.today().isoformat()}
    for ticker in tickers:
        trades = by_ticker.get(ticker.upper(), [])
        buys  = [t for t in trades if t["type"] == "buy"]
        sells = [t for t in trades if t["type"] == "sell"]
        trades_sorted = sorted(trades, key=lambda x: x["date"], reverse=True)
        result[ticker] = {
            "buy_count":  len(buys),
            "sell_count": len(sells),
            "recent":     trades_sorted[:3],
            "score":      round(score_congress(len(buys), len(sells)), 1),
        }

    found = sum(1 for t in tickers if result.get(t, {}).get("buy_count", 0) +
                                       result.get(t, {}).get("sell_count", 0) > 0)
    with open(CONGRESS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print(f"  Congress trades opgeslagen ({found} tickers met activiteit).")
    return result


# ─────────────────────────────────────────────
# Stap 5d: Earnings datums toevoegen aan fundamentals
# ─────────────────────────────────────────────

def fetch_earnings_dates(fundamentals, tickers):
    """Voeg eerstvolgende earnings datum toe aan fundamentals data."""
    # Controleer of er al earnings dates zijn van vandaag
    sample = next((v for k, v in fundamentals.items() if k != "_date"), {})
    if "earnings_date" in sample:
        print("  Earnings dates al aanwezig in cache, sla over.")
        return fundamentals

    print(f"  Earnings datums ophalen voor {len(tickers)} aandelen...")
    updated = 0
    for i, ticker in enumerate(tickers, 1):
        try:
            t_obj = yf.Ticker(ticker)
            cal = t_obj.calendar
            earnings_date = None
            if isinstance(cal, dict):
                ed = cal.get("Earnings Date")
                if ed is not None:
                    if isinstance(ed, (list, tuple)) and len(ed) > 0:
                        earnings_date = str(ed[0])[:10]
                    else:
                        earnings_date = str(ed)[:10]
            if ticker in fundamentals:
                fundamentals[ticker]["earnings_date"] = earnings_date
                if earnings_date:
                    updated += 1
        except Exception:
            if ticker in fundamentals:
                fundamentals[ticker]["earnings_date"] = None
        time.sleep(SLEEP_BETWEEN_INFO)

    # Overschrijf de cache met earnings dates erbij
    with open(FUNDAMENTALS_FILE, "w") as f:
        json.dump(fundamentals, f, indent=2)
    print(f"  Earnings dates opgeslagen ({updated} tickers met datum).")
    return fundamentals


# ─────────────────────────────────────────────
# Stap 6: JSON bestanden schrijven
# ─────────────────────────────────────────────

def write_prices_json(prices):
    output = {}
    for ticker, close in prices.items():
        last_n = close.tail(CHART_DAYS)
        output[ticker] = {
            "dates": [d.strftime("%Y-%m-%d") for d in last_n.index],
            "close": [round(float(v), 2) for v in last_n.values],
        }
    with open(PRICES_FILE, "w") as f:
        json.dump(output, f)
    print(f"  Koersdata opgeslagen: {PRICES_FILE}")


def write_scores_json(scores):
    ranked = sorted(scores.values(), key=lambda x: x["composite_score"], reverse=True)
    for i, item in enumerate(ranked, 1):
        item["rank"] = i

    output = {
        "generated_at": datetime.now().isoformat(),
        "rankings": ranked,
    }
    with open(SCORES_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Scores opgeslagen: {SCORES_FILE}")


def write_metadata_json(tickers, prices, start_time):
    last_dates = [prices[t].index[-1].strftime("%Y-%m-%d") for t in prices if len(prices[t]) > 0]
    data_through = max(last_dates) if last_dates else "onbekend"
    output = {
        "generated_at": datetime.now().isoformat(),
        "ticker_count": len(tickers),
        "tickers_with_data": len(prices),
        "data_through": data_through,
        "fetch_duration_seconds": round(time.time() - start_time, 1),
    }
    with open(METADATA_FILE, "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Metadata opgeslagen: {METADATA_FILE}")


# ─────────────────────────────────────────────
# Hoofdprogramma
# ─────────────────────────────────────────────

def main():
    start = time.time()
    print("=" * 55)
    print("  Portfolio Analyse - Data Fetcher")
    print(f"  {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print("=" * 55)

    # Universe laden
    print("\n[1/7] Universe laden...")
    tickers, ticker_to_index, indices = load_universe()
    for idx_name, idx_data in indices.items():
        print(f"  {idx_name}: {len(idx_data['tickers'])} aandelen")
    print(f"  Totaal: {len(tickers)} aandelen")

    # Koersen ophalen (inclusief ^GSPC benchmark voor dashboard)
    print("\n[2/7] Koersen ophalen...")
    all_tickers = tickers + ["^GSPC"]
    prices = fetch_prices(all_tickers)
    if not prices:
        print("FOUT: Geen koersen ontvangen. Controleer je internetverbinding.")
        sys.exit(1)
    # Verwijder ^GSPC uit de ticker lijst die gebruikt wordt voor scores/fundamentals
    prices_for_scores = {t: v for t, v in prices.items() if t != "^GSPC"}

    # Fundamentele data ophalen
    print("\n[3/7] Fundamentele data...")
    fundamentals = fetch_fundamentals(tickers)
    fundamentals = fetch_earnings_dates(fundamentals, tickers)

    # Nieuws ophalen
    print("\n[4/7] Nieuws...")
    news = fetch_all_news(tickers)

    # Insider trades (Form 4 via SEC EDGAR)
    print("\n[5/7] Insider trades (SEC EDGAR Form 4)...")
    cik_map = fetch_cik_map()
    insider = fetch_insider_trades(tickers, cik_map)

    # Congress trades (House Stock Watcher)
    print("\n[6/7] Congress trades...")
    congress = fetch_congress_trades(tickers)

    # Scores berekenen
    sector_medians = compute_sector_medians(fundamentals, tickers)
    print(f"\n  Sectoren gevonden: {list(sector_medians.keys())[:5]}...")

    scores = compute_all_scores(
        prices_for_scores, fundamentals, sector_medians,
        ticker_to_index, news, insider, congress
    )
    print(f"  Scores berekend voor {len(scores)} aandelen")

    # Top 5 tonen in terminal
    ranked = sorted(scores.values(), key=lambda x: x["composite_score"], reverse=True)
    print("\n  Top 5 koopkandidaten vandaag:")
    for i, s in enumerate(ranked[:5], 1):
        ins_lbl = f"  insider={s['scores'].get('insider',50):.0f}" if s.get('insider_buy_count',0) > 0 else ""
        cng_lbl = f"  congress={s['scores'].get('congress',50):.0f}" if s.get('congress_buy_count',0) > 0 else ""
        print(f"  {i}. {s['ticker']:12s} [{s['index']}]  Score: {s['composite_score']:.1f}  RSI: {s['rsi_value']}{ins_lbl}{cng_lbl}")

    # Bestanden schrijven
    print("\n[7/7] JSON bestanden schrijven...")
    write_prices_json(prices)          # Bevat nu ook ^GSPC
    write_scores_json(scores)
    write_metadata_json(tickers, prices_for_scores, start)

    duration = time.time() - start
    print(f"\nKlaar in {duration:.0f} seconden.")
    print("Open de webapp: python3 -m http.server 8080")
    print("Ga naar:        http://localhost:8080")
    print("=" * 55)


if __name__ == "__main__":
    main()
