/* Chart analysis engine. Turns raw candles into structured facts and a trade plan.
   Everything numeric is computed here in code; the AI only interprets these facts. */
(function (root) {
  const TA = root.TA || require('./indicators.js');
  const last = (a) => a[a.length - 1];
  const lastVal = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
  const r = (x, d) => (x == null || !isFinite(x) ? null : +x.toFixed(d));

  function decimals(price) {
    if (price >= 1000) return 2;
    if (price >= 100) return 3;
    if (price >= 1) return 4;
    if (price >= 0.01) return 6;
    return 8;
  }

  // Cluster swing pivots into support/resistance zones.
  function levels(cs, piv, atrVal, price) {
    const tol = Math.max(atrVal * 0.6, price * 0.0015);
    const clusters = [];
    for (const p of piv) {
      let hit = clusters.find((c) => Math.abs(c.price - p.price) <= tol);
      if (hit) {
        hit.touches++;
        hit.price = (hit.price * (hit.touches - 1) + p.price) / hit.touches;
        hit.lastIdx = Math.max(hit.lastIdx, p.i);
        hit.lo = Math.min(hit.lo, p.price);
        hit.hi = Math.max(hit.hi, p.price);
      } else {
        clusters.push({ price: p.price, touches: 1, lastIdx: p.i, lo: p.price, hi: p.price });
      }
    }
    const n = cs.length;
    for (const c of clusters) {
      const recency = c.lastIdx / n; // 0..1
      c.strength = +(c.touches + recency * 1.5).toFixed(2);
    }
    const sup = clusters.filter((c) => c.price < price).sort((a, b) => b.price - a.price);
    const res = clusters.filter((c) => c.price > price).sort((a, b) => a.price - b.price);
    const pick = (arr) => arr.slice(0, 4).map((c) => ({
      price: c.price, zoneLow: c.lo, zoneHigh: c.hi, touches: c.touches, strength: c.strength,
    }));
    return { supports: pick(sup), resistances: pick(res), tol };
  }

  function structure(piv, cs) {
    const highs = piv.filter((p) => p.type === 'high').slice(-3);
    const lows = piv.filter((p) => p.type === 'low').slice(-3);
    if (highs.length < 2 || lows.length < 2) return { label: 'unclear', detail: 'not enough swings' };
    const hh = last(highs).price > highs[highs.length - 2].price;
    const hl = last(lows).price > lows[lows.length - 2].price;
    let label = 'range';
    if (hh && hl) label = 'uptrend (HH+HL)';
    else if (!hh && !hl) label = 'downtrend (LH+LL)';
    else if (hh && !hl) label = 'expanding / choppy (HH+LL)';
    else label = 'contracting (LH+HL)';
    const close = last(cs).close;
    let bos = null;
    if (close > last(highs).price) bos = 'closed above last swing high (bullish break of structure)';
    else if (close < last(lows).price) bos = 'closed below last swing low (bearish break of structure)';
    return {
      label, bos,
      lastSwingHigh: last(highs).price, lastSwingLow: last(lows).price,
    };
  }

  function patterns(cs, atrVal) {
    const out = [];
    if (cs.length < 3) return out;
    const c = cs[cs.length - 1], p = cs[cs.length - 2], pp = cs[cs.length - 3];
    const body = (x) => Math.abs(x.close - x.open);
    const range = (x) => x.high - x.low || 1e-12;
    const upper = (x) => x.high - Math.max(x.open, x.close);
    const lower = (x) => Math.min(x.open, x.close) - x.low;
    const bull = (x) => x.close > x.open, bear = (x) => x.close < x.open;

    if (bull(c) && bear(p) && c.close >= p.open && c.open <= p.close && body(c) > body(p))
      out.push('bullish engulfing');
    if (bear(c) && bull(p) && c.close <= p.open && c.open >= p.close && body(c) > body(p))
      out.push('bearish engulfing');
    if (lower(c) >= 2 * body(c) && upper(c) <= body(c) && range(c) > atrVal * 0.8)
      out.push('hammer / bullish pin bar');
    if (upper(c) >= 2 * body(c) && lower(c) <= body(c) && range(c) > atrVal * 0.8)
      out.push('shooting star / bearish pin bar');
    if (body(c) <= range(c) * 0.1) out.push('doji (indecision)');
    if (c.high < p.high && c.low > p.low) out.push('inside bar (compression)');
    if (bull(c) && bull(p) && bull(pp) && c.close > p.close && p.close > pp.close)
      out.push('three rising closes');
    if (bear(c) && bear(p) && bear(pp) && c.close < p.close && p.close < pp.close)
      out.push('three falling closes');
    // liquidity sweep: wick beyond prior candle extreme but close back inside
    if (c.low < p.low && c.close > p.low && lower(c) > body(c)) out.push('sell-side sweep (wick below prior low, closed back above)');
    if (c.high > p.high && c.close < p.high && upper(c) > body(c)) out.push('buy-side sweep (wick above prior high, closed back below)');
    return out;
  }

  function analyze(cs, tf, opts = {}) {
    if (!cs || cs.length < 60) return { tf, error: 'not enough candles (' + (cs ? cs.length : 0) + ')' };
    const closes = cs.map((c) => c.close);
    const vols = cs.map((c) => c.volume);
    const price = last(closes);
    const dp = decimals(price);

    const e20 = TA.ema(closes, 20), e50 = TA.ema(closes, 50), e200 = TA.ema(closes, 200);
    const rs = TA.rsi(closes, 14);
    const mc = TA.macd(closes);
    const at = TA.atr(cs, 14);
    const bb = TA.bollinger(closes, 20, 2);
    const atrVal = lastVal(at);
    const piv = TA.pivots(cs, 3, 3);
    const lv = levels(cs, piv, atrVal, price);
    const st = structure(piv, cs);
    // when the newest candle is still forming, judge candle patterns on closed candles only
    const pats = patterns(opts.forming ? cs.slice(0, -1) : cs, atrVal);

    // relative volume: last closed candle vs 20-bar average (exclude the forming one)
    const volAvg = TA.sma(vols, 20);
    const relVol = volAvg[cs.length - 2] ? vols[cs.length - 2] / volAvg[cs.length - 2] : null;

    // MACD cross in last 3 bars
    let cross = null;
    for (let i = cs.length - 3; i < cs.length; i++) {
      const h0 = mc.hist[i - 1], h1 = mc.hist[i];
      if (h0 != null && h1 != null) {
        if (h0 <= 0 && h1 > 0) cross = 'bullish cross';
        if (h0 >= 0 && h1 < 0) cross = 'bearish cross';
      }
    }

    // RSI divergence over last ~30 bars (price makes extreme, RSI does not)
    let divergence = null;
    const w = 30, s = cs.length - w;
    if (s > 0) {
      const hi = piv.filter((p) => p.type === 'high' && p.i >= s).slice(-2);
      const lo = piv.filter((p) => p.type === 'low' && p.i >= s).slice(-2);
      if (hi.length === 2 && rs[hi[0].i] != null && rs[hi[1].i] != null &&
        hi[1].price > hi[0].price && rs[hi[1].i] < rs[hi[0].i]) divergence = 'bearish RSI divergence';
      if (lo.length === 2 && rs[lo[0].i] != null && rs[lo[1].i] != null &&
        lo[1].price < lo[0].price && rs[lo[1].i] > rs[lo[0].i]) divergence = 'bullish RSI divergence';
    }

    // Trend score -100..100
    let score = 0;
    const v20 = lastVal(e20), v50 = lastVal(e50), v200 = lastVal(e200);
    if (v20 != null) score += price > v20 ? 12 : -12;
    if (v50 != null) score += price > v50 ? 14 : -14;
    if (v200 != null) score += price > v200 ? 16 : -16;
    if (v20 != null && v50 != null) score += v20 > v50 ? 12 : -12;
    if (v50 != null && v200 != null) score += v50 > v200 ? 8 : -8;
    if (st.label.startsWith('uptrend')) score += 20;
    else if (st.label.startsWith('downtrend')) score -= 20;
    const mh = lastVal(mc.hist);
    if (mh != null) score += mh > 0 ? 8 : -8;
    const rv = lastVal(rs);
    if (rv != null) score += rv > 55 ? 6 : rv < 45 ? -6 : 0;
    if (st.bos && st.bos.includes('bullish')) score += 6;
    if (st.bos && st.bos.includes('bearish')) score -= 6;
    score = Math.max(-100, Math.min(100, score));
    const label = score >= 45 ? 'strong bullish' : score >= 15 ? 'bullish'
      : score <= -45 ? 'strong bearish' : score <= -15 ? 'bearish' : 'neutral / mixed';

    const bw = lastVal(bb.upper) - lastVal(bb.lower);
    const bbPos = bw ? (price - lastVal(bb.lower)) / bw : null;

    const rd = (x) => r(x, dp);
    return {
      tf, price: rd(price), decimals: dp, candles: cs.length,
      trend: { label, score },
      structure: st,
      ema: { e20: rd(v20), e50: rd(v50), e200: rd(v200) },
      rsi: r(rv, 1),
      macd: { hist: r(mh, dp + 2), cross },
      atr: rd(atrVal), atrPct: r((atrVal / price) * 100, 2),
      bollinger: { upper: rd(lastVal(bb.upper)), lower: rd(lastVal(bb.lower)), position: r(bbPos, 2), widthPct: r((bw / price) * 100, 2) },
      relativeVolume: r(relVol, 2),
      divergence, patterns: pats,
      levels: {
        supports: lv.supports.map((x) => ({ ...x, price: rd(x.price), zoneLow: rd(x.zoneLow), zoneHigh: rd(x.zoneHigh) })),
        resistances: lv.resistances.map((x) => ({ ...x, price: rd(x.price), zoneLow: rd(x.zoneLow), zoneHigh: rd(x.zoneHigh) })),
      },
    };
  }

  const TF_WEIGHT = { '1m': 0.05, '5m': 0.1, '15m': 0.15, '30m': 0.2, '1h': 0.25, '2h': 0.3, '4h': 0.35, '1d': 0.4, '1w': 0.3 };

  // Combine timeframes into one bias, then build a plan on the trigger timeframe.
  function plan(multi, triggerTf, opts = {}) {
    const ok = Object.values(multi).filter((a) => a && !a.error);
    if (!ok.length) return { error: 'no analysis available' };
    let wsum = 0, ssum = 0;
    for (const a of ok) { const w = TF_WEIGHT[a.tf] || 0.2; wsum += w; ssum += w * a.trend.score; }
    const bias = ssum / wsum;
    const aligned = ok.filter((a) => Math.sign(a.trend.score) === Math.sign(bias) && Math.abs(a.trend.score) >= 15).length;
    const trig = multi[triggerTf] && !multi[triggerTf].error ? multi[triggerTf] : ok[0];
    const price = trig.price, atrV = trig.atr;
    const dir = bias >= 20 ? 'long' : bias <= -20 ? 'short' : 'wait';
    const out = {
      triggerTf: trig.tf, price, bias: r(bias, 1), alignment: `${aligned}/${ok.length} timeframes agree`,
      direction: dir, confidence: 'low', notes: [],
    };
    const conf = Math.abs(bias);
    out.confidence = conf >= 55 && aligned >= Math.ceil(ok.length * 0.75) ? 'high' : conf >= 30 ? 'medium' : 'low';

    if (dir === 'wait') {
      out.notes.push('Timeframes disagree or momentum is flat. No edge: waiting is a valid position.');
      out.watch = { above: trig.levels.resistances[0] ? trig.levels.resistances[0].price : null, below: trig.levels.supports[0] ? trig.levels.supports[0].price : null };
      return out;
    }

    const dp = trig.decimals;
    const dec = (x) => r(x, dp);
    if (dir === 'long') {
      const sup = trig.levels.supports[0];
      const nearSup = sup && price - sup.price <= atrV * 1.2;
      const entry = nearSup ? price : (sup ? sup.price + atrV * 0.1 : price);
      const base = sup ? Math.min(sup.zoneLow, sup.price) : price - atrV * 1.5;
      const stop = base - atrV * 0.5;
      const risk = entry - stop;
      const tps = trig.levels.resistances.filter((x) => x.price > entry + risk * 0.8).slice(0, 3).map((x) => x.price);
      while (tps.length < 2) tps.push(entry + risk * (tps.length + 1.5) * (tps.length ? 1.3 : 1));
      out.entryStyle = nearSup ? 'market / on pullback (price already near support)' : 'limit near support, wait for the pullback';
      out.entry = dec(entry); out.stop = dec(stop);
      out.targets = tps.slice(0, 3).map((t) => ({ price: dec(t), rr: r((t - entry) / risk, 2) }));
      out.invalidation = `Close below ${dec(stop)} (beyond the support zone and 0.5 ATR buffer).`;
      out.riskPerUnit = dec(risk);
    } else {
      const res = trig.levels.resistances[0];
      const nearRes = res && res.price - price <= atrV * 1.2;
      const entry = nearRes ? price : (res ? res.price - atrV * 0.1 : price);
      const base = res ? Math.max(res.zoneHigh, res.price) : price + atrV * 1.5;
      const stop = base + atrV * 0.5;
      const risk = stop - entry;
      const tps = trig.levels.supports.filter((x) => x.price < entry - risk * 0.8).slice(0, 3).map((x) => x.price);
      while (tps.length < 2) tps.push(entry - risk * (tps.length + 1.5) * (tps.length ? 1.3 : 1));
      out.entryStyle = nearRes ? 'market / on bounce (price already near resistance)' : 'limit near resistance, wait for the bounce';
      out.entry = dec(entry); out.stop = dec(stop);
      out.targets = tps.slice(0, 3).map((t) => ({ price: dec(t), rr: r((entry - t) / risk, 2) }));
      out.invalidation = `Close above ${dec(stop)} (beyond the resistance zone and 0.5 ATR buffer).`;
      out.riskPerUnit = dec(risk);
    }
    if (out.targets[0].rr < 1.5) out.notes.push('First target is under 1.5R. Poor reward for the risk; consider skipping or waiting for a better entry.');
    if (trig.rsi != null && ((dir === 'long' && trig.rsi > 72) || (dir === 'short' && trig.rsi < 28)))
      out.notes.push('RSI is stretched in the trade direction. Chasing here is risky; prefer a pullback.');
    if (trig.divergence) out.notes.push('Trigger timeframe shows ' + trig.divergence + '.');
    if (out.confidence === 'low') out.notes.push('Low confidence: signals are only weakly aligned.');

    if (opts.account && opts.riskPct) {
      const riskMoney = (opts.account * opts.riskPct) / 100;
      out.sizing = { riskMoney: r(riskMoney, 2), units: r(riskMoney / out.riskPerUnit, 6) };
    }
    return out;
  }

  const api = { analyze, plan, decimals };
  root.Analysis = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
