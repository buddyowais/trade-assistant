/* App UI: chart, AI chat, journal, stats, settings. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TFS = ['5m', '15m', '1h', '4h', '1d'];
  const ANALYSIS_TFS = ['15m', '1h', '4h', '1d'];
  const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800 };
  const SKEY = 'ta.settings.v1';

  // ---------- settings ----------
  const defaults = { provider: 'groq', symbol: 'BTCUSDT', tf: '1h', account: '', riskPct: 1, ollamaUrl: 'http://localhost:11434' };
  let settings = (() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch (e) { return { ...defaults }; } })();
  const saveSettings = () => localStorage.setItem(SKEY, JSON.stringify(settings));

  // ---------- status ----------
  let statusTimer;
  function setStatus(text, kind = '') {
    const el = $('#status'); el.textContent = text || ''; el.className = 'status ' + kind;
    clearTimeout(statusTimer);
    if (text && kind !== 'busy') statusTimer = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 6000);
  }

  // ---------- navigation ----------
  function show(view) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    window.scrollTo(0, 0);
    if (view === 'chart' && chart) setTimeout(resizeChart, 30);
    if (view === 'journal') renderJournal();
    if (view === 'stats') renderStats();
    if (view === 'settings') fillSettings();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // ---------- chart ----------
  const state = { symbol: settings.symbol, tf: settings.tf, snap: null, candles: [], loading: false, tick: 0 };
  let chart, candleS, ema20S, ema50S, lines = [];

  function initChart() {
    const box = $('#chart');
    if (!window.LightweightCharts) { box.innerHTML = '<p class="muted" style="padding:16px">Chart library could not load (check your connection). Analysis and AI still work.</p>'; return; }
    chart = LightweightCharts.createChart(box, {
      width: box.clientWidth, height: 360,
      layout: { background: { type: 'solid', color: '#0b0f17' }, textColor: '#8b97ab', fontSize: 11 },
      grid: { vertLines: { color: '#151d2b' }, horzLines: { color: '#151d2b' } },
      rightPriceScale: { borderColor: '#243049' }, timeScale: { borderColor: '#243049', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }, handleScale: { pinch: true, mouseWheel: true }, handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    candleS = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
    ema20S = chart.addLineSeries({ color: '#f5b942', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema50S = chart.addLineSeries({ color: '#4f8cff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    new ResizeObserver(resizeChart).observe(box);
  }
  function resizeChart() { if (chart) { const w = $('#chart').clientWidth; if (w > 0) chart.applyOptions({ width: w }); } }

  const px = (x, dp) => (x == null || !isFinite(x) ? '–' : Number(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const dpOf = (price) => Analysis.decimals(price);

  function cleanCandles(cs) {
    const seen = new Set(), out = [];
    for (const c of cs.slice().sort((a, b) => a.time - b.time)) if (!seen.has(c.time) && isFinite(c.open + c.high + c.low + c.close)) { seen.add(c.time); out.push(c); }
    return out;
  }

  function drawCandles(cs) {
    if (!chart) return;
    const closes = cs.map((c) => c.close);
    const dp = dpOf(closes[closes.length - 1]);
    candleS.applyOptions({ priceFormat: { type: 'price', precision: dp, minMove: Math.pow(10, -dp) } });
    candleS.setData(cs);
    const e20 = TA.ema(closes, 20), e50 = TA.ema(closes, 50);
    ema20S.setData(cs.map((c, i) => e20[i] != null ? { time: c.time, value: e20[i] } : null).filter(Boolean));
    ema50S.setData(cs.map((c, i) => e50[i] != null ? { time: c.time, value: e50[i] } : null).filter(Boolean));
    chart.timeScale().fitContent();
    const n = Math.min(cs.length, 110); chart.timeScale().setVisibleLogicalRange({ from: cs.length - n, to: cs.length + 4 });
  }

  function drawLevels(snap) {
    if (!candleS) return;
    lines.forEach((l) => { try { candleS.removePriceLine(l); } catch (e) { /* gone */ } }); lines = [];
    if (!snap || !snap.plan || snap.plan.error) return;
    const a = snap.multi[snap.plan.triggerTf]; if (!a || a.error) return;
    const add = (price, color, title, style = 2) => { if (price != null) lines.push(candleS.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
    a.levels.supports.slice(0, 3).forEach((l) => add(l.price, 'rgba(38,166,154,.75)', 'S'));
    a.levels.resistances.slice(0, 3).forEach((l) => add(l.price, 'rgba(239,83,80,.75)', 'R'));
    const p = snap.plan;
    if (p.direction !== 'wait' && p.entry != null) {
      add(p.entry, '#4f8cff', 'ENTRY', 0); add(p.stop, '#ef5350', 'STOP', 0);
      p.targets.forEach((t, i) => add(t.price, '#26a69a', 'TP' + (i + 1), 0));
    }
  }

  const tfOrder = (arr) => [...new Set(arr)].sort((a, b) => TF_SEC[a] - TF_SEC[b]);

  async function buildSnapshot(symbol, tf, mainRes) {
    const tfs = tfOrder([tf, ...ANALYSIS_TFS]);
    const res = await Promise.allSettled(tfs.map((t) => (t === tf && mainRes ? Promise.resolve(mainRes) : Data.klines(symbol, t, 400, settings))));
    const multi = {}; let source = '', sym = symbol, firstErr = null;
    res.forEach((r, i) => {
      const t = tfs[i];
      if (r.status === 'fulfilled') {
        source = r.value.source; sym = r.value.symbol;
        const cs = cleanCandles(r.value.candles);
        const forming = cs.length && (cs[cs.length - 1].time + TF_SEC[t]) * 1000 > Date.now();
        multi[t] = Analysis.analyze(cs, t, { forming });
      } else { firstErr = firstErr || r.reason; multi[t] = { tf: t, error: r.reason && r.reason.message }; }
    });
    if (!Object.values(multi).some((a) => a && !a.error)) throw firstErr || new Error('No data');
    const plan = Analysis.plan(multi, tf, { account: +settings.account || 0, riskPct: +settings.riskPct || 0 });
    const context = await Data.context(sym, settings).catch(() => ({}));
    return { symbol: sym, source, tf, multi, plan, context, ts: Date.now() };
  }

  async function loadSymbol(raw, tf) {
    if (state.loading) { state.pending = [raw, tf]; setStatus('Queued ' + raw.toUpperCase() + '…', 'busy'); return; } // run the latest request when the current one ends
    state.loading = true;
    setStatus('Loading ' + raw.toUpperCase() + '…', 'busy');
    try {
      const main = await Data.klines(raw, tf, 500, settings);
      state.symbol = main.symbol; state.tf = tf; state.candles = cleanCandles(main.candles);
      settings.symbol = state.symbol; settings.tf = tf; saveSettings();
      $('#symInput').value = state.symbol; renderTfRow();
      drawCandles(state.candles);
      const last = state.candles[state.candles.length - 1];
      $('#pxNow').textContent = px(last.close, dpOf(last.close)); $('#pxSrc').textContent = main.source;
      state.snap = await buildSnapshot(state.symbol, tf, main);
      renderAnalysis(state.snap); drawLevels(state.snap);
      const tk = state.snap.context && state.snap.context.ticker;
      const chg = $('#pxChg'); if (tk) { chg.textContent = (tk.change24hPct >= 0 ? '+' : '') + tk.change24hPct.toFixed(2) + '% 24h'; chg.className = 'chg ' + (tk.change24hPct >= 0 ? 'up' : 'down'); } else { chg.textContent = ''; }
      setStatus('Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      setStatus('Failed', 'err');
      $('#analysis').innerHTML = `<p class="down">Could not load ${esc(raw)}.</p><p class="muted small">${esc(e.message)}</p><p class="muted small">Crypto pairs work without a key (e.g. BTCUSDT). Stocks and forex need a free Twelve Data key in Settings.</p>`;
    } finally {
      state.loading = false;
      if (state.pending) { const [r, f] = state.pending; state.pending = null; loadSymbol(r, f); }
    }
  }

  function renderTfRow() {
    $('#tfRow').innerHTML = TFS.map((t) => `<button type="button" class="chip ${t === state.tf ? 'active' : ''}" data-tf="${t}">${t}</button>`).join('');
  }
  $('#tfRow').addEventListener('click', (e) => { const b = e.target.closest('[data-tf]'); if (b) loadSymbol(state.symbol, b.dataset.tf); });
  $('#symForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#symInput').value.trim(); if (v) { $('#symInput').blur(); loadSymbol(v, state.tf); } });

  function renderAnalysis(snap) {
    const el = $('#analysis'), p = snap.plan;
    if (!p || p.error) { el.innerHTML = '<p class="muted">No analysis available.</p>'; return; }
    const trig = snap.multi[p.triggerTf]; const dp = trig && !trig.error ? trig.decimals : 2;
    const f = (x) => px(x, dp);
    let h = `<div class="row" style="justify-content:space-between"><div><span class="badge ${p.direction}">${p.direction.toUpperCase()}</span> <span class="muted small">${esc(p.confidence)} confidence · ${esc(p.alignment)}</span></div><div class="muted small">bias ${p.bias}</div></div>`;
    h += '<table style="margin-top:10px"><tr><th>TF</th><th>Trend</th><th class="r">RSI</th><th>Structure</th></tr>';
    for (const t of tfOrder(Object.keys(snap.multi))) {
      const a = snap.multi[t];
      if (a.error) { h += `<tr><td>${t}</td><td colspan="3" class="muted">unavailable</td></tr>`; continue; }
      const cls = a.trend.score > 14 ? 'up' : a.trend.score < -14 ? 'down' : '';
      h += `<tr><td>${t}</td><td class="${cls}">${esc(a.trend.label)}</td><td class="r">${a.rsi ?? '–'}</td><td class="muted">${esc(a.structure.label.split(' ')[0])}</td></tr>`;
    }
    h += '</table>';
    if (p.direction !== 'wait') {
      h += `<div class="kv"><div><small>Entry</small><b>${f(p.entry)}</b></div><div><small>Stop</small><b class="down">${f(p.stop)}</b></div><div><small>Risk/unit</small><b>${f(p.riskPerUnit)}</b></div>`;
      p.targets.forEach((t, i) => { h += `<div><small>TP${i + 1} · ${t.rr}R</small><b class="up">${f(t.price)}</b></div>`; });
      h += '</div>';
      h += `<p class="small muted" style="margin:4px 0">${esc(p.entryStyle)}. ${esc(p.invalidation)}</p>`;
      if (p.sizing) h += `<p class="small">Position size for ${settings.riskPct}% risk of ${px(+settings.account, 2)}: <b>${p.sizing.units}</b> units (risking ${p.sizing.riskMoney}).</p>`;
      else h += '<p class="small muted">Set account size and risk % in Settings to get position size.</p>';
    } else if (p.watch) {
      h += `<p style="margin:10px 0 0" class="small">Waiting for a break above <b>${f(p.watch.above)}</b> or below <b>${f(p.watch.below)}</b> with the higher timeframes agreeing.</p>`;
    }
    (p.notes || []).forEach((n) => { h += `<p class="note">⚠ ${esc(n)}</p>`; });
    if (trig && !trig.error) {
      h += `<h3 style="margin:14px 0 4px">Key levels (${trig.tf})</h3><table>`;
      trig.levels.resistances.slice().reverse().forEach((l) => { h += `<tr><td class="down">Resistance</td><td class="r">${f(l.price)}</td><td class="r muted">${l.touches}× touched</td></tr>`; });
      h += `<tr><td><b>Price</b></td><td class="r"><b>${f(trig.price)}</b></td><td class="r muted">ATR ${f(trig.atr)}</td></tr>`;
      trig.levels.supports.forEach((l) => { h += `<tr><td class="up">Support</td><td class="r">${f(l.price)}</td><td class="r muted">${l.touches}× touched</td></tr>`; });
      h += '</table>';
      const bits = [];
      if (trig.patterns.length) bits.push('Candles: ' + trig.patterns.join(', '));
      if (trig.divergence) bits.push(trig.divergence);
      if (trig.structure.bos) bits.push(trig.structure.bos);
      if (trig.macd.cross) bits.push('MACD ' + trig.macd.cross);
      if (trig.relativeVolume) bits.push('rel. volume ' + trig.relativeVolume + '×');
      if (bits.length) h += `<p class="small muted" style="margin-top:8px">${esc(bits.join(' · '))}</p>`;
    }
    const c = snap.context || {};
    const chips = [];
    if (c.fearGreed) chips.push(`Fear &amp; Greed ${c.fearGreed.value} (${esc(c.fearGreed.label)})`);
    if (c.funding) chips.push(`Funding ${c.funding.fundingRatePct}%`);
    if (c.ticker) chips.push(`24h range ${f(c.ticker.low24h)} – ${f(c.ticker.high24h)}`);
    if (chips.length) h += `<p class="small muted" style="margin-top:8px">${chips.join(' · ')}</p>`;
    if (c.news && c.news.length) {
      h += '<h3 style="margin:14px 0 2px">Latest news</h3><div class="news">';
      c.news.slice(0, 5).forEach((n) => { h += `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}<br><small>${esc(n.source)} · ${new Date(n.published).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></a>`; });
      h += '</div>';
    }
    h += `<p class="small muted" style="margin-top:10px">Data: ${esc(snap.source)} · latest candle may still be forming. Not financial advice.</p>`;
    el.innerHTML = h;
  }

  // live refresh: update newest candles every 15s (60s for key-limited sources), re-analyse every ~90s
  setInterval(async () => {
    if (document.hidden || !$('#view-chart').classList.contains('active') || state.loading || !chart || !state.candles.length) return;
    const slow = state.snap && state.snap.source === 'Twelve Data';
    state.tick++; if (slow && state.tick % 4) return;
    try {
      const r = await Data.klines(state.symbol, state.tf, slow ? 5 : 3, settings);
      for (const c of cleanCandles(r.candles).slice(-2)) {
        candleS.update(c);
        const i = state.candles.findIndex((x) => x.time === c.time);
        if (i >= 0) state.candles[i] = c; else if (c.time > state.candles[state.candles.length - 1].time) state.candles.push(c);
      }
      const last = state.candles[state.candles.length - 1];
      $('#pxNow').textContent = px(last.close, dpOf(last.close));
      if (state.tick % 6 === 0) { state.snap = await buildSnapshot(state.symbol, state.tf); renderAnalysis(state.snap); drawLevels(state.snap); }
    } catch (e) { /* transient network error: keep showing last data */ }
  }, 15000);

  $('#btnExplain').addEventListener('click', () => { show('chat'); sendChat('Break down this chart across all timeframes and tell me the best trade, or if I should wait.'); });
  $('#btnLogTrade').addEventListener('click', () => {
    show('journal'); const f = $('#tradeForm'); f.hidden = false;
    const p = state.snap && state.snap.plan;
    f.symbol.value = state.symbol; if (p && p.direction !== 'wait') { f.side.value = p.direction; f.entry.value = p.entry; f.stop.value = p.stop; }
    f.entry.focus();
  });

  // ---------- AI chat ----------
  const history = []; let attached = null; let busy = false;

  function md(src) {
    const lines = esc(src).split('\n'); let out = '', list = false;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) { if (!list) { out += '<ul>'; list = true; } out += '<li>' + inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, '')) + '</li>'; continue; }
      if (list) { out += '</ul>'; list = false; }
      if (/^#{1,4}\s+/.test(line)) out += '<h4>' + inline(line.replace(/^#{1,4}\s+/, '')) + '</h4>';
      else if (line.trim()) out += '<p>' + inline(line) + '</p>';
    }
    return out + (list ? '</ul>' : '');
  }
  function addMsg(role, html, img) {
    const d = document.createElement('div'); d.className = 'msg ' + role;
    d.innerHTML = (img ? `<img src="${img}" alt="Attached chart">` : '') + html;
    const log = $('#chatLog'); log.appendChild(d); d.scrollIntoView({ block: 'end', behavior: 'smooth' }); return d;
  }

  function aiData(snap) {
    const out = { generatedUtc: new Date().toISOString(), note: 'Newest candle on each timeframe may still be forming. All numbers computed by code.' };
    if (snap) {
      out.symbol = snap.symbol; out.dataSource = snap.source; out.selectedTimeframe = snap.tf;
      out.timeframes = {};
      for (const [t, a] of Object.entries(snap.multi)) {
        if (a.error) { out.timeframes[t] = { error: a.error }; continue; }
        out.timeframes[t] = {
          price: a.price, trend: a.trend, structure: { label: a.structure.label, breakOfStructure: a.structure.bos, lastSwingHigh: a.structure.lastSwingHigh, lastSwingLow: a.structure.lastSwingLow },
          ema: a.ema, rsi: a.rsi, macd: a.macd, atr: a.atr, atrPct: a.atrPct, bollinger: a.bollinger, relativeVolume: a.relativeVolume,
          divergence: a.divergence, candlePatterns: a.patterns,
          supports: a.levels.supports.slice(0, 3).map((l) => ({ price: l.price, touches: l.touches })),
          resistances: a.levels.resistances.slice(0, 3).map((l) => ({ price: l.price, touches: l.touches })),
        };
      }
      out.computedPlan = snap.plan;
      const c = snap.context || {};
      out.market = { ticker24h: c.ticker, fearGreed: c.fearGreed, funding: c.funding };
      out.news = (c.news || []).slice(0, 8).map((n) => ({ title: n.title, source: n.source, published: n.published }));
    } else out.note += ' No live symbol is loaded.';
    const list = Journal.load(); const s = Journal.stats(list);
    if (s.n) { const { curve, bySymbol, byWeekday, byTag, ...rest } = s; out.journal = { ...rest, bySymbol: bySymbol.slice(0, 6), byWeekday, byTag: byTag.slice(0, 6), lastTrades: list.slice(-8).map((t) => ({ date: t.date, symbol: t.symbol, side: t.side, r: t.r != null ? +t.r.toFixed(2) : null, pnl: t.pnl, tags: t.tags, notes: t.notes })) }; }
    out.userRisk = { account: +settings.account || null, riskPct: +settings.riskPct || null };
    return out;
  }

  function mapTf(s) {
    s = String(s || '').toLowerCase().replace(/\s/g, '');
    const m = { '1': '1m', '1m': '1m', '5': '5m', '5m': '5m', '15': '15m', '15m': '15m', '30': '30m', '30m': '30m', '60': '1h', '1h': '1h', '120': '2h', '2h': '2h', '240': '4h', '4h': '4h', 'd': '1d', '1d': '1d', 'daily': '1d', 'w': '1w', '1w': '1w', 'weekly': '1w' };
    return m[s] || null;
  }
  function cleanSymbol(s) { return String(s || '').split(':').pop().replace(/\.P$|PERP$/i, '').replace(/[^A-Za-z0-9/]/g, '').toUpperCase(); }

  async function downscale(file) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1400, k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  }
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { attached = await downscale(f); $('#attachPrev').hidden = false; $('#attachPrev').innerHTML = `<img src="${attached}" alt=""><span class="small muted">Chart screenshot ready</span><button type="button" class="btn" id="btnRmAttach">Remove</button>`; }
    catch (err) { setStatus('Could not read image', 'err'); }
  });
  $('#attachPrev').addEventListener('click', (e) => { if (e.target.id === 'btnRmAttach') { attached = null; $('#attachPrev').hidden = true; } });

  async function sendChat(text, forceImage) {
    if (busy) return;
    const image = forceImage || attached; text = (text || '').trim();
    if (!text && !image) return;
    if (!text) text = 'Break down this chart: bias, key levels, and the best trade plan.';
    busy = true; $('#chatInput').value = ''; autosize(); attached = null; $('#attachPrev').hidden = true;
    addMsg('user', md(text), image);
    const wait = addMsg('sys', 'Thinking…');
    try {
      if (!AI.available(settings).length) throw new Error('No AI provider set up yet. Open Settings and paste a free Groq or Gemini key.');
      let reading = null, note = '';
      // 1) If a screenshot is attached, read it first to find the symbol/timeframe.
      if (image) {
        wait.textContent = 'Reading your chart…';
        const r = await AI.chat(settings, [{ role: 'user', content: 'Read this trading chart screenshot. Reply with ONLY compact JSON: {"symbol":"ticker as shown e.g. BTCUSDT or EURUSD or AAPL, or null","timeframe":"as shown e.g. 1h, 4h, D, or null","priceVisible":number or null,"visibleLevels":[numbers of horizontal lines/zones drawn],"indicatorsVisible":["names"],"pattern":"one short phrase describing what price is doing"}' }],
          { image, system: 'You extract structured facts from trading chart screenshots. Output only valid JSON. Use null when unsure; never guess a symbol.', temperature: 0.1, maxTokens: 400 });
        const m = r.text.match(/\{[\s\S]*\}/); try { reading = m ? JSON.parse(m[0]) : null; } catch (e) { reading = null; }
      }
      // 2) Make sure we have live data for the right symbol.
      let target = null, tf = state.tf;
      if (reading && reading.symbol) { target = cleanSymbol(reading.symbol); tf = mapTf(reading.timeframe) || tf; }
      const typed = (text.match(/\b([A-Z0-9]{2,10}(?:USDT|USD|PERP)|BTC|ETH|SOL|XRP|DOGE|BNB)\b/) || [])[1];
      if (!image && typed && typed !== 'USD') target = cleanSymbol(typed);
      let snap = state.snap;
      if (target && (!snap || cleanSymbol(snap.symbol) !== target)) {
        wait.textContent = 'Fetching live data for ' + target + '…';
        try { snap = await buildSnapshot(target, tf); state.snap = snap; state.symbol = snap.symbol; state.tf = tf; }
        catch (e) { note = `Could not load live data for ${target} (${e.message}). `; snap = image ? null : snap; }
      } else if (!snap) {
        wait.textContent = 'Fetching live data…';
        try { snap = await buildSnapshot(state.symbol, state.tf); state.snap = snap; } catch (e) { note = 'Live data unavailable: ' + e.message + '. '; }
      } else if (Date.now() - snap.ts > 60000) {
        try { snap = await buildSnapshot(snap.symbol, snap.tf); state.snap = snap; } catch (e) { /* use older snapshot */ }
      }
      // 3) Ask the model with the data attached.
      wait.textContent = 'Analysing…';
      const data = aiData(snap);
      let content = '';
      if (reading) content += `SCREENSHOT READING (from a vision pass, may contain errors; where it disagrees with DATA prices, trust DATA):\n${JSON.stringify(reading)}\n\n`;
      if (note) content += `NOTE: ${note}Base the answer on the screenshot only and say levels are approximate.\n\n`;
      content += `DATA (live, computed by code):\n${JSON.stringify(data)}\n\nUSER REQUEST: ${text}`;
      const msgs = history.slice(-8).concat([{ role: 'user', content }]);
      const res = await AI.chat(settings, msgs, { image, maxTokens: 1500 });
      history.push({ role: 'user', content: text + (snap ? ` [context: ${snap.symbol} ${snap.tf}]` : '') }, { role: 'assistant', content: res.text });
      wait.remove();
      const d = addMsg('ai', md(res.text) + `<p class="small muted" style="margin-top:8px">${esc(res.provider)} · ${esc(res.model)}${snap ? ' · live ' + esc(snap.symbol) : ''}</p>`);
      if (snap && target) { $('#symInput').value = snap.symbol; }
    } catch (e) {
      wait.className = 'msg ai'; wait.innerHTML = `<p class="down">Something went wrong.</p><p class="small muted">${esc(e.message)}</p>`;
    } finally { busy = false; }
  }
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chatInput').value); });
  $('#quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) sendChat(b.dataset.q); });
  function autosize() { const t = $('#chatInput'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; }
  $('#chatInput').addEventListener('input', autosize);
  addMsg('sys', 'Ask about any chart, attach a screenshot, or tap a shortcut below. Live data is attached to every question automatically.');

  // ---------- journal ----------
  function renderJournal() {
    const list = Journal.load().slice().sort((a, b) => b.date.localeCompare(a.date));
    const el = $('#tradeList');
    if (!list.length) { el.innerHTML = '<p class="muted center pad">No trades yet. Add one, or import a CSV from your broker.</p>'; return; }
    el.innerHTML = list.map((t) => {
      const res = !t.closed ? '<span class="warn">OPEN</span>' : `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${t.r != null ? (t.r >= 0 ? '+' : '') + t.r.toFixed(2) + 'R' : (t.pnl >= 0 ? '+' : '') + (+t.pnl).toFixed(2)}</span>`;
      return `<div class="trade" data-id="${esc(t.id)}"><div class="top2"><div><span class="sym">${esc(t.symbol)}</span> <span class="badge ${t.side}">${esc(t.side)}</span></div><b>${res}</b></div>
        <div class="meta">${esc(t.date.replace('T', ' '))} · ${esc(t.entry)}${t.exit !== '' && t.exit != null ? ' → ' + esc(t.exit) : ''}${t.stop ? ' · SL ' + esc(t.stop) : ''}${t.closed && t.pnl != null ? ' · P&amp;L ' + (+t.pnl).toFixed(2) : ''}</div>
        ${t.tags ? `<div class="meta">#${esc(t.tags).split(',').map((s) => s.trim()).join(' #')}</div>` : ''}${t.notes ? `<div class="meta">${esc(t.notes)}</div>` : ''}
        <div class="acts">${!t.closed ? '<button class="btn" data-act="close">Close trade</button>' : ''}<button class="btn" data-act="del">Delete</button></div></div>`;
    }).join('');
  }
  $('#btnAddTrade').addEventListener('click', () => { const f = $('#tradeForm'); f.hidden = !f.hidden; if (!f.hidden) f.symbol.value = f.symbol.value || state.symbol; });
  $('#btnCancelTrade').addEventListener('click', () => { $('#tradeForm').hidden = true; });
  $('#tradeForm').addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target; const v = (n) => f[n].value.trim();
    Journal.add({ symbol: v('symbol').toUpperCase(), side: v('side'), entry: v('entry'), stop: v('stop'), exit: v('exit'), size: v('size') || 1, pnl: v('pnl'), tags: v('tags'), notes: v('notes') });
    f.reset(); f.hidden = true; renderJournal(); setStatus('Trade saved');
  });
  $('#tradeList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; const id = b.closest('.trade').dataset.id;
    if (b.dataset.act === 'del' && confirm('Delete this trade?')) { Journal.remove(id); renderJournal(); }
    if (b.dataset.act === 'close') { const x = prompt('Exit price?'); if (x && isFinite(+x)) { Journal.update(id, { exit: +x }); renderJournal(); } }
  });
  $('#csvIn').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = Journal.importCSV(await f.text());
    setStatus(r.error ? r.error : `Imported ${r.added} trades` + (r.skipped ? `, skipped ${r.skipped}` : ''), r.error ? 'err' : ''); if (r.error) alert(r.error); renderJournal();
  });
  $('#btnExport').addEventListener('click', () => {
    const list = Journal.load(); if (!list.length) return setStatus('Nothing to export', 'err');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([Journal.exportCSV(list)], { type: 'text/csv' })); a.download = 'trades.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- stats ----------
  function renderStats() {
    const s = Journal.stats(Journal.load()); const el = $('#statsBox');
    if (!s.n) { el.innerHTML = '<p class="muted center pad">Close at least one trade in the Journal to see your performance.</p>'; return; }
    const pc = (x) => (x == null ? '–' : (x * 100).toFixed(0) + '%');
    const card = (k, v, cls = '') => `<div class="stat"><small>${k}</small><b class="${cls}">${v}</b></div>`;
    let h = '<div class="stat-grid">' +
      card('Closed trades', s.n) + card('Win rate', pc(s.winRate)) + card('Profit factor', s.profitFactor ?? '–', s.profitFactor >= 1 ? 'up' : 'down') +
      card('Expectancy / trade', s.expectancy, s.expectancy >= 0 ? 'up' : 'down') + card('Average R', s.avgR ?? '–', s.avgR >= 0 ? 'up' : 'down') +
      card('Total P&L', s.totalPnl, s.totalPnl >= 0 ? 'up' : 'down') + card('Max drawdown', s.maxDrawdown, 'down') + card('Longest loss streak', s.maxLossStreak) + '</div>';
    // equity curve
    if (s.curve.length > 1) {
      const c = s.curve, mn = Math.min(0, ...c), mx = Math.max(0, ...c), W = 300, H = 110, rng = mx - mn || 1;
      const pts = c.map((v, i) => `${(i / (c.length - 1)) * W},${H - ((v - mn) / rng) * (H - 10) - 5}`).join(' ');
      const zero = H - ((0 - mn) / rng) * (H - 10) - 5;
      h += `<div class="card"><h3>Equity curve</h3><svg class="curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="#243049" stroke-dasharray="3 3"/><polyline fill="none" stroke="${c[c.length - 1] >= 0 ? '#26a69a' : '#ef5350'}" stroke-width="2" points="${pts}" vector-effect="non-scaling-stroke"/></svg></div>`;
    }
    // rule-based behaviour insights
    const ins = [];
    if (s.n < 20) ins.push(['', `Only ${s.n} closed trades. Treat these numbers as noisy until you have 30+.`]);
    if (s.winRate > 0.5 && s.expectancy < 0) ins.push(['', 'You win more than half your trades but still lose money: your average loser is bigger than your average winner. Cut losses at the stop and stop widening it.']);
    if (s.winRate < 0.4 && s.avgLoss && s.avgWin / s.avgLoss < 1.5) ins.push(['', 'Low win rate and winners barely bigger than losers. You need either better entries or to let winners run to 2R or more.']);
    if (s.winRateAfterTwoLosses != null && s.tradesAfterTwoLosses >= 5 && s.winRateAfterTwoLosses < s.winRate - 0.15) ins.push(['', `After two losses in a row your win rate drops to ${pc(s.winRateAfterTwoLosses)} (vs ${pc(s.winRate)} overall). Add a rule: stop for the day after two losses.`]);
    if (s.currentLossStreak >= 3) ins.push(['', `You are on a ${s.currentLossStreak}-trade losing streak. Reduce size or pause and review before the next trade.`]);
    const worstSym = s.bySymbol.filter((x) => x.trades >= 5).slice(-1)[0]; if (worstSym && worstSym.pnl < 0) ins.push(['', `${worstSym.key} is your weakest market (${worstSym.trades} trades, P&L ${worstSym.pnl}). Consider dropping it.`]);
    const wd = s.byWeekday.filter((x) => x.trades >= 5); if (wd.length > 1 && wd[wd.length - 1].pnl < 0) ins.push(['', `${wd[wd.length - 1].key} is your worst day (P&L ${wd[wd.length - 1].pnl}).`]);
    if (s.profitFactor >= 1.5 && s.n >= 30) ins.push(['good', 'Solid edge so far: profit factor above 1.5 over 30+ trades. Keep risk per trade constant.']);
    if (ins.length) h += '<div class="card"><h3>What your data says</h3>' + ins.map(([c, t]) => `<div class="insight ${c}">${esc(t)}</div>`).join('') + '</div>';
    const tbl = (title, rows) => rows.length ? `<div class="card"><h3>${title}</h3><table><tr><th></th><th class="r">Trades</th><th class="r">Win%</th><th class="r">P&amp;L</th></tr>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.trades}</td><td class="r">${pc(r.winRate)}</td><td class="r ${r.pnl >= 0 ? 'up' : 'down'}">${r.pnl}</td></tr>`).join('')}</table></div>` : '';
    h += tbl('By market', s.bySymbol) + tbl('By setup tag', s.byTag) + tbl('By weekday', s.byWeekday) + tbl('By side', s.bySide);
    h += '<div class="row gap"><button id="btnCoach" class="btn primary grow">Coach me with AI</button></div>';
    el.innerHTML = h;
    const cb = $('#btnCoach'); if (cb) cb.addEventListener('click', () => { show('chat'); sendChat('Review my trading journal stats. What mistakes am I making and what should I fix first? Give me 3 concrete rules.'); });
  }

  // ---------- settings ----------
  const FIELDS = ['provider', 'groqKey', 'geminiKey', 'openrouterKey', 'ollamaUrl', 'groqModel', 'groqVisionModel', 'geminiModel', 'geminiVisionModel', 'openrouterModel', 'openrouterVisionModel', 'ollamaModel', 'ollamaVisionModel', 'twelveKey', 'account', 'riskPct'];
  function fillSettings() {
    const f = $('#settingsForm');
    FIELDS.forEach((n) => { if (f[n]) f[n].value = settings[n] ?? ''; });
    f.ollamaEnabled.checked = !!settings.ollamaEnabled;
    for (const p of ['groq', 'gemini', 'openrouter', 'ollama']) {
      if (!f[p + 'Model'].value) f[p + 'Model'].placeholder = AI.DEFAULTS[p].model;
      if (!f[p + 'VisionModel'].value) f[p + 'VisionModel'].placeholder = AI.DEFAULTS[p].vision;
    }
  }
  function readSettings() {
    const f = $('#settingsForm');
    FIELDS.forEach((n) => { if (f[n]) settings[n] = f[n].value.trim(); });
    settings.ollamaEnabled = f.ollamaEnabled.checked; saveSettings();
  }
  $('#settingsForm').addEventListener('submit', (e) => { e.preventDefault(); readSettings(); $('#settingsMsg').textContent = 'Saved.'; setStatus('Settings saved'); });
  $('#btnTestAI').addEventListener('click', async () => {
    readSettings(); const m = $('#settingsMsg'); m.textContent = 'Testing…';
    try { const r = await AI.chat(settings, [{ role: 'user', content: 'Reply with the single word OK.' }], { maxTokens: 20, temperature: 0 }); m.textContent = `Working: ${r.provider} (${r.model}) replied "${r.text.trim().slice(0, 30)}".`; }
    catch (e) { m.textContent = e.message; }
  });
  $('#btnWipe').addEventListener('click', () => { if (confirm('Erase every trade in your journal? This cannot be undone.')) { Journal.save([]); setStatus('Journal erased'); renderJournal(); } });

  // ---------- boot ----------
  initChart(); renderTfRow(); $('#symInput').value = state.symbol; fillSettings();
  loadSymbol(state.symbol, state.tf);
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
