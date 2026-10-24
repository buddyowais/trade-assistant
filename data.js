/* Live market data from free public sources. Crypto works with no key.
   Stocks / forex need a free Twelve Data key (Settings). */
(function (root) {
  const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const TF_BINANCE = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1d', '1w': '1w' };
  const TF_BYBIT = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D', '1w': 'W' };
  const TF_TD = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1day', '1w': '1week' };

  async function getJSON(url, timeoutMs = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  const cache = new Map(); // short-lived cache so tab switches don't hammer APIs
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    const v = await fn();
    cache.set(key, { t: Date.now(), v });
    return v;
  }

  // "BTC/USD", "btcusd", "BTC-USDT" -> "BTCUSDT"
  function normalizeCrypto(sym) {
    let s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.endsWith('USD') && !s.endsWith('USDT')) s += 'T';
    if (!/(USDT|USDC|BUSD|BTC|ETH|BNB|EUR|TRY)$/.test(s) && s.length <= 5) s += 'USDT';
    return s;
  }

  async function klinesBinance(symbol, tf, limit) {
    let lastErr;
    for (const host of BINANCE_HOSTS) {
      try {
        const rows = await getJSON(`${host}/api/v3/klines?symbol=${symbol}&interval=${TF_BINANCE[tf]}&limit=${limit}`);
        return rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function klinesBybit(symbol, tf, limit) {
    const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${TF_BYBIT[tf]}&limit=${limit}`);
    if (j.retCode !== 0) throw new Error(j.retMsg || 'bybit error');
    return j.result.list.map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).reverse();
  }

  async function klinesTwelve(symbol, tf, limit, key) {
    if (!key) throw new Error('Twelve Data key needed for stocks/forex (free at twelvedata.com). Add it in Settings.');
    const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${TF_TD[tf]}&outputsize=${limit}&order=ASC&timezone=UTC&apikey=${key}`);
    if (j.status === 'error') throw new Error(j.message || 'twelvedata error');
    return j.values.map((v) => ({ time: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0) }));
  }

  // Looks crypto-like? (ends in a quote asset) otherwise treat as stock/forex.
  function isCrypto(sym) {
    const s = String(sym).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /(USDT|USDC|BUSD|FDUSD)$/.test(s) || /^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|LINK|DOT|TON|SUI|PEPE|SHIB|LTC|TRX|NEAR|APT|ARB|OP|INJ)(USD)?$/.test(s);
  }

  async function klines(symbol, tf, limit = 500, settings = {}) {
    const raw = String(symbol).trim();
    const crypto = isCrypto(raw);
    return cached(`k|${raw}|${tf}|${limit}`, 8000, async () => {
      if (crypto) {
        const s = normalizeCrypto(raw);
        try { return { source: 'Binance', symbol: s, candles: await klinesBinance(s, tf, limit) }; }
        catch (e1) {
          try { return { source: 'Bybit', symbol: s, candles: await klinesBybit(s, tf, limit) }; }
          catch (e2) { throw new Error(`Could not load ${s}: ${e1.message}; ${e2.message}`); }
        }
      }
      // forex "EURUSD" -> "EUR/USD"
      let s = raw.toUpperCase();
      if (/^[A-Z]{6}$/.test(s)) s = s.slice(0, 3) + '/' + s.slice(3);
      return { source: 'Twelve Data', symbol: s, candles: await klinesTwelve(s, tf, Math.min(limit, 500), settings.twelveKey) };
    });
  }

  // ---- extra context (all free, no key) ----
  async function ticker24h(symbol) {
    const s = normalizeCrypto(symbol);
    return cached('t|' + s, 15000, async () => {
      for (const host of BINANCE_HOSTS) {
        try {
          const j = await getJSON(`${host}/api/v3/ticker/24hr?symbol=${s}`);
          return { change24hPct: +j.priceChangePercent, high24h: +j.highPrice, low24h: +j.lowPrice, quoteVolume24h: +j.quoteVolume };
        } catch (e) { /* try next */ }
      }
      return null;
    });
  }

  async function fearGreed() {
    return cached('fng', 600000, async () => {
      try {
        const j = await getJSON('https://api.alternative.me/fng/?limit=2');
        const [now, prev] = j.data;
        return { value: +now.value, label: now.value_classification, yesterday: prev ? +prev.value : null };
      } catch (e) { return null; }
    });
  }

  async function funding(symbol) {
    const s = normalizeCrypto(symbol);
    return cached('f|' + s, 60000, async () => {
      try {
        const j = await getJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`);
        return { fundingRatePct: +(+j.lastFundingRate * 100).toFixed(4), markPrice: +j.markPrice };
      } catch (e) { return null; }
    });
  }

  async function news(symbol) {
    const base = String(symbol || '').toUpperCase().replace(/(USDT|USDC|BUSD|USD)$/, '');
    return cached('n|' + base, 300000, async () => {
      try {
        const cat = base ? `&categories=${encodeURIComponent(base)}` : '';
        const j = await getJSON(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN${cat}`);
        return (j.Data || []).slice(0, 8).map((n) => ({
          title: n.title, source: n.source_info ? n.source_info.name : n.source,
          published: new Date(n.published_on * 1000).toISOString(), url: n.url,
        }));
      } catch (e) { return []; }
    });
  }

  async function context(symbol, settings = {}) {
    const crypto = isCrypto(symbol);
    const [t, fg, fu, nw] = await Promise.all([
      crypto ? ticker24h(symbol) : null, crypto ? fearGreed() : null, crypto ? funding(symbol) : null, news(crypto ? symbol : ''),
    ]);
    return { ticker: t, fearGreed: fg, funding: fu, news: nw };
  }

  const api = { klines, context, normalizeCrypto, isCrypto };
  root.Data = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
