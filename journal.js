/* Trade journal + performance statistics. All numbers computed here, never by the LLM. */
(function (root) {
  const KEY = 'ta.trades.v1';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function save(list) { localStorage.setItem(KEY, JSON.stringify(list)); }

  // Derive pnl (price units * size) and R multiple from entry/exit/stop.
  function derive(t) {
    const dir = t.side === 'short' ? -1 : 1;
    const e = +t.entry, x = +t.exit, s = +t.stop, size = +t.size || 1;
    const out = { ...t };
    if (isFinite(e) && isFinite(x) && t.exit !== '' && t.exit != null) {
      out.pnl = t.pnl !== '' && t.pnl != null && isFinite(+t.pnl) ? +t.pnl : (x - e) * dir * size;
      if (isFinite(s) && t.stop !== '' && s !== e) out.r = (x - e) * dir / Math.abs(e - s);
      else out.r = null;
      out.closed = true;
    } else if (isFinite(+t.pnl) && t.pnl !== '' && t.pnl != null) {
      out.pnl = +t.pnl; out.r = t.r != null ? t.r : null; out.closed = true;
    } else { out.closed = false; out.pnl = null; out.r = null; }
    return out;
  }

  function add(t) {
    const list = load();
    const row = derive({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: new Date().toISOString().slice(0, 16), ...t });
    list.push(row); save(list); return row;
  }
  function update(id, patch) {
    const list = load().map((t) => (t.id === id ? derive({ ...t, ...patch }) : t));
    save(list);
  }
  function remove(id) { save(load().filter((t) => t.id !== id)); }

  function stats(list) {
    const closed = list.filter((t) => t.closed).sort((a, b) => a.date.localeCompare(b.date));
    const n = closed.length;
    if (!n) return { n: 0, open: list.length };
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const withR = closed.filter((t) => t.r != null);
    const avgR = withR.length ? withR.reduce((s, t) => s + t.r, 0) / withR.length : null;
    const winRate = wins.length / n;
    const avgWin = wins.length ? gp / wins.length : 0, avgLoss = losses.length ? gl / losses.length : 0;

    // equity curve + max drawdown (in pnl units)
    let eq = 0, peak = 0, maxDD = 0; const curve = [];
    for (const t of closed) { eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); curve.push(+eq.toFixed(4)); }

    // streaks
    let curW = 0, curL = 0, maxW = 0, maxL = 0;
    for (const t of closed) {
      if (t.pnl > 0) { curW++; curL = 0; } else if (t.pnl < 0) { curL++; curW = 0; } else { curW = 0; curL = 0; }
      maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
    }
    let curStreak = 0; for (let i = closed.length - 1; i >= 0 && closed[i].pnl < 0; i--) curStreak++;

    // behaviour after losses (revenge-trading check)
    const afterLoss = [];
    for (let i = 1; i < closed.length; i++) if (closed[i - 1].pnl < 0) afterLoss.push(closed[i]);
    const afterLossWin = afterLoss.length ? afterLoss.filter((t) => t.pnl > 0).length / afterLoss.length : null;
    const afterTwo = [];
    for (let i = 2; i < closed.length; i++) if (closed[i - 1].pnl < 0 && closed[i - 2].pnl < 0) afterTwo.push(closed[i]);

    const group = (keyFn) => {
      const m = {};
      for (const t of closed) { const k = keyFn(t) || 'n/a'; (m[k] = m[k] || []).push(t); }
      return Object.entries(m).map(([k, v]) => ({
        key: k, trades: v.length, pnl: +v.reduce((s, t) => s + t.pnl, 0).toFixed(4),
        winRate: +(v.filter((t) => t.pnl > 0).length / v.length).toFixed(3),
      })).sort((a, b) => b.pnl - a.pnl);
    };
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const tagRows = [];
    for (const t of closed) for (const g of (t.tags || '').split(',').map((x) => x.trim()).filter(Boolean)) tagRows.push({ ...t, _tag: g });
    const byTag = (() => {
      const m = {};
      for (const t of tagRows) (m[t._tag] = m[t._tag] || []).push(t);
      return Object.entries(m).map(([k, v]) => ({ key: k, trades: v.length, pnl: +v.reduce((s, t) => s + t.pnl, 0).toFixed(4), winRate: +(v.filter((t) => t.pnl > 0).length / v.length).toFixed(3) })).sort((a, b) => b.pnl - a.pnl);
    })();

    return {
      n, open: list.length - n,
      winRate: +winRate.toFixed(3), avgWin: +avgWin.toFixed(4), avgLoss: +avgLoss.toFixed(4),
      profitFactor: gl ? +(gp / gl).toFixed(2) : null,
      expectancy: +(winRate * avgWin - (1 - winRate) * avgLoss).toFixed(4),
      avgR: avgR != null ? +avgR.toFixed(2) : null, totalPnl: +eq.toFixed(4), maxDrawdown: +maxDD.toFixed(4),
      maxWinStreak: maxW, maxLossStreak: maxL, currentLossStreak: curStreak,
      winRateAfterLoss: afterLossWin != null ? +afterLossWin.toFixed(3) : null,
      tradesAfterTwoLosses: afterTwo.length,
      winRateAfterTwoLosses: afterTwo.length ? +(afterTwo.filter((t) => t.pnl > 0).length / afterTwo.length).toFixed(3) : null,
      bySymbol: group((t) => t.symbol), bySide: group((t) => t.side), byWeekday: group((t) => days[new Date(t.date).getDay()]),
      byTag, curve,
    };
  }

  // ---- CSV ----
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
    return rows;
  }

  const ALIASES = {
    date: ['date', 'time', 'datetime', 'open time', 'opened', 'close time', 'closed'],
    symbol: ['symbol', 'pair', 'instrument', 'ticker', 'market'],
    side: ['side', 'direction', 'type', 'action'],
    entry: ['entry', 'entry price', 'open price', 'price open', 'avg entry'],
    exit: ['exit', 'exit price', 'close price', 'price close', 'avg exit'],
    stop: ['stop', 'sl', 'stop loss', 'stoploss'],
    size: ['size', 'qty', 'quantity', 'volume', 'lots', 'amount'],
    pnl: ['pnl', 'profit', 'p&l', 'p/l', 'net profit', 'realized pnl', 'realized profit'],
    tags: ['tags', 'setup', 'strategy'],
    notes: ['notes', 'comment', 'comments', 'note'],
  };

  function importCSV(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { added: 0, skipped: 0, error: 'CSV needs a header row and at least one trade.' };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const idx = {};
    for (const [field, names] of Object.entries(ALIASES)) idx[field] = head.findIndex((h) => names.includes(h));
    if (idx.symbol < 0 || (idx.pnl < 0 && (idx.entry < 0 || idx.exit < 0)))
      return { added: 0, skipped: rows.length - 1, error: 'Need a symbol column, plus either pnl or entry+exit columns. Found: ' + head.join(', ') };
    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      const g = (f) => (idx[f] >= 0 ? (r[idx[f]] || '').trim() : '');
      const sideRaw = g('side').toLowerCase();
      const side = /sell|short/.test(sideRaw) ? 'short' : 'long';
      const num = (v) => (v === '' ? '' : +String(v).replace(/[^0-9.\-eE]/g, ''));
      const d = g('date') ? new Date(g('date')) : null;
      const t = { symbol: g('symbol').toUpperCase(), side, entry: num(g('entry')), exit: num(g('exit')), stop: num(g('stop')), size: num(g('size')) || 1, pnl: num(g('pnl')), tags: g('tags'), notes: g('notes') };
      if (d && !isNaN(d)) t.date = d.toISOString().slice(0, 16);
      if (!t.symbol) { skipped++; continue; }
      const row = add(t);
      if (!row.closed) { remove(row.id); skipped++; } else added++;
    }
    return { added, skipped };
  }

  function exportCSV(list) {
    const cols = ['date', 'symbol', 'side', 'entry', 'exit', 'stop', 'size', 'pnl', 'r', 'tags', 'notes'];
    const esc = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols.join(',')].concat(list.map((t) => cols.map((c) => esc(t[c])).join(','))).join('\n');
  }

  const api = { load, save, add, update, remove, derive, stats, importCSV, exportCSV, parseCSV };
  root.Journal = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
