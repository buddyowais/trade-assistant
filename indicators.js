/* Indicator math. Pure functions, no DOM, runs in browser and Node. */
(function (root) {
  const nulls = (n) => new Array(n).fill(null);

  function sma(v, p) {
    const out = nulls(v.length);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= p) s -= v[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  }

  function ema(v, p) {
    const out = nulls(v.length);
    if (v.length < p) return out;
    const k = 2 / (p + 1);
    let sum = 0;
    for (let i = 0; i < p; i++) sum += v[i];
    let prev = sum / p;
    out[p - 1] = prev;
    for (let i = p; i < v.length; i++) {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder RSI
  function rsi(c, p = 14) {
    const out = nulls(c.length);
    if (c.length <= p) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) {
      const d = c[i] - c[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= p; l /= p;
    out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function macd(c, fast = 12, slow = 26, sig = 9) {
    const ef = ema(c, fast), es = ema(c, slow);
    const line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const first = line.findIndex((x) => x != null);
    const signal = nulls(c.length);
    if (first >= 0) {
      const sub = ema(line.slice(first), sig);
      for (let i = 0; i < sub.length; i++) signal[first + i] = sub[i];
    }
    const hist = line.map((x, i) => (x != null && signal[i] != null ? x - signal[i] : null));
    return { line, signal, hist };
  }

  // Wilder ATR on candle objects
  function atr(cs, p = 14) {
    const out = nulls(cs.length);
    if (cs.length <= p) return out;
    const tr = cs.map((c, i) =>
      i === 0 ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close)));
    let a = 0;
    for (let i = 1; i <= p; i++) a += tr[i];
    a /= p;
    out[p] = a;
    for (let i = p + 1; i < cs.length; i++) {
      a = (a * (p - 1) + tr[i]) / p;
      out[i] = a;
    }
    return out;
  }

  function bollinger(c, p = 20, mult = 2) {
    const mid = sma(c, p);
    const upper = nulls(c.length), lower = nulls(c.length);
    for (let i = p - 1; i < c.length; i++) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / p);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  // Swing pivots: a high is a pivot if it is the highest in [i-left, i+right].
  function pivots(cs, left = 3, right = 3) {
    const out = [];
    for (let i = left; i < cs.length - right; i++) {
      let hi = true, lo = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (cs[j].high >= cs[i].high && (j < i || cs[j].high > cs[i].high)) hi = false;
        if (cs[j].low <= cs[i].low && (j < i || cs[j].low < cs[i].low)) lo = false;
      }
      if (hi) out.push({ i, price: cs[i].high, type: 'high', time: cs[i].time });
      if (lo) out.push({ i, price: cs[i].low, type: 'low', time: cs[i].time });
    }
    return out.sort((a, b) => a.i - b.i);
  }

  const api = { sma, ema, rsi, macd, atr, bollinger, pivots };
  root.TA = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
