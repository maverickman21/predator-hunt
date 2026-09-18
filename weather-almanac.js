/**
 * BOARD #2 — WEATHER ALMANAC (2026-09-18)
 * Question: do harvest days sit in a different PRESSURE REGIME from desert days?
 *
 * Per Qld trading day (08:00 -> 07:00 next day) we stamp:
 *   range_t     : MNQ high-low in ticks (from NT 1-min export; timestamps UTC)
 *   dgs30       : 30y yield (last US close before the session)
 *   d30_30d     : 30y change over the prior 30 calendar days (bp)
 *   d30_vol     : 30-day realised vol of the 30y (stdev of daily changes, bp)  <- bond-uncertainty proxy
 *   vix         : VIX (last US close before the session)
 *   runwayA     : calendar days until the next Tier-A event
 *   runwayAB    : calendar days until the next Tier-A or Tier-B event
 *   fr_max      : max |funding| during the session
 *   fr_hrs_hi   : hours funding spent above 0.005 (|.|)
 *   crossings   : funding zero-crossings during the session
 *   liq_M       : total liquidation $M during the session
 *   outcome     : net ticks of trades ENTERED that day; harvest = any win >= 1000
 *
 * PRE-REGISTERED: the almanac dies if harvest days do not sit in a visibly different
 * regime from desert days (Aug 21 -> Sep 17) on these variables.
 *
 * Run: node weather-almanac.js -> weather_almanac.txt
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const T = ms => new Date(ms);

// ─── MNQ bars (NT export: yyyyMMdd HHmmss;O;H;L;C;V, local Qld time) ─────────
const days = new Map();   // qldDate -> {hi, lo, bars}
function loadMNQ(file) {
    if (!fs.existsSync(path.join(DIR, file))) { console.log('missing ' + file); return; }
    for (const line of fs.readFileSync(path.join(DIR, file), 'utf8').split(/\r?\n/)) {
        const p = line.split(';'); if (p.length < 5) continue;
        const dt = p[0].trim(); if (!/^\d{8} \d{6}$/.test(dt)) continue;
        // NT export timestamps are UTC (verified 2026-09-18): shift to Qld, then apply the 08:00 session rule
        const q = new Date(Date.UTC(+dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8), +dt.slice(9, 11), +dt.slice(11, 13), +dt.slice(13, 15)) + 10 * 3600e3);
        const h = q.getUTCHours();
        let sd = new Date(Date.UTC(q.getUTCFullYear(), q.getUTCMonth(), q.getUTCDate())); if (h < 8) sd = new Date(sd.getTime() - 86400e3);
        const key = sd.toISOString().slice(0, 10);
        const hi = parseFloat(p[2]), lo = parseFloat(p[3]);
        const r = days.get(key) || { hi: -Infinity, lo: Infinity, bars: 0 };
        if (hi > r.hi) r.hi = hi; if (lo < r.lo) r.lo = lo; r.bars++;
        days.set(key, r);
    }
}
loadMNQ('MNQ_SEP26_1min.txt'); loadMNQ('MNQ_DEC26_1min.txt');
console.log('MNQ session days: ' + days.size);

// ─── FRED daily series ───────────────────────────────────────────────────────
function loadFred(file) {
    const m = new Map();
    if (!fs.existsSync(path.join(DIR, file))) { console.log('missing ' + file); return m; }
    for (const line of fs.readFileSync(path.join(DIR, file), 'utf8').split(/\r?\n/)) {
        const p = line.split(','); if (p.length < 2) continue;
        const v = parseFloat(p[1]); if (!/^\d{4}-\d{2}-\d{2}/.test(p[0]) || !isFinite(v)) continue;
        m.set(p[0].slice(0, 10), v);
    }
    return m;
}
const dgs30 = loadFred('DGS30.csv'), vix = loadFred('VIXCLS.csv');
function loadCboe(file) {
    const m = new Map();
    if (!fs.existsSync(path.join(DIR, file))) { console.log('missing ' + file); return m; }
    const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split(/\r?\n/);
    const hdr = (lines[0] || '').toUpperCase().split(',').map(s => s.trim());
    const di = hdr.findIndex(h => /DATE/.test(h)), ci = hdr.findIndex(h => /CLOSE/.test(h));
    for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(','); if (p.length < 2) continue;
        let d = (p[di >= 0 ? di : 0] || '').trim(); const v = parseFloat(p[ci >= 0 ? ci : p.length - 1]);
        const mdy = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (mdy) d = mdy[3] + '-' + mdy[1].padStart(2, '0') + '-' + mdy[2].padStart(2, '0');
        if (/^\d{4}-\d{2}-\d{2}/.test(d) && isFinite(v)) m.set(d.slice(0, 10), v);
    }
    return m;
}
const vxtlt = loadCboe('vxtlt-history.csv');
console.log('DGS30 pts ' + dgs30.size + ', VIX pts ' + vix.size + ', VXTLT pts ' + vxtlt.size);
function lastBefore(m, dateStr) {   // latest value strictly before the Qld session date
    const keys = [...m.keys()].filter(k => k < dateStr).sort();
    return keys.length ? { date: keys[keys.length - 1], v: m.get(keys[keys.length - 1]) } : null;
}
function fredChange(m, dateStr, backDays) {
    const now = lastBefore(m, dateStr); if (!now) return null;
    const then = lastBefore(m, new Date(Date.parse(dateStr) - backDays * 86400e3).toISOString().slice(0, 10));
    return then ? (now.v - then.v) * 100 : null;   // bp
}
function fredVol(m, dateStr, backDays) {
    const keys = [...m.keys()].filter(k => k < dateStr && k >= new Date(Date.parse(dateStr) - backDays * 86400e3).toISOString().slice(0, 10)).sort();
    const d = []; for (let i = 1; i < keys.length; i++) d.push((m.get(keys[i]) - m.get(keys[i - 1])) * 100);
    if (d.length < 5) return null;
    const mu = d.reduce((s, x) => s + x, 0) / d.length;
    return Math.sqrt(d.reduce((s, x) => s + (x - mu) ** 2, 0) / d.length);
}

// ─── calendar ────────────────────────────────────────────────────────────────
let events = [];
try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, 'economic-calendar.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : (j.events || Object.values(j)[0]);
    for (const e of arr) {
        const date = (e.date || e.day || '').slice(0, 10);
        const name = (e.name || e.event || e.title || '').toString();
        let tier = (e.tier || e.Tier || '').toString().toUpperCase().replace('TIER', '').trim();
        if (!tier) tier = /FOMC|CPI/i.test(name) ? 'A' : /PPI|GDP|NFP|PAYROLL|PCE/i.test(name) ? 'B' : 'C';
        if (date) events.push({ date, name, tier });
    }
} catch (e) { console.log('calendar load failed: ' + e.message); }
events.sort((a, b) => a.date.localeCompare(b.date));
function runway(dateStr, tiers) {
    for (const e of events) if (e.date >= dateStr && tiers.includes(e.tier))
        return Math.round((Date.parse(e.date) - Date.parse(dateStr)) / 86400e3);
    return null;
}

// ─── funding + liqs per session ──────────────────────────────────────────────
const fund = [];
for (const f of fs.readdirSync(DIR).filter(x => /^eth_pillars_v3_\d{4}-\d{2}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const hdr = lines[0].split(','); const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_close');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 6) continue;
        const ms = Date.parse(c[ti]), v = parseFloat(c[fi]); if (isFinite(ms) && isFinite(v)) fund.push([ms, v]); }
}
fund.sort((a, b) => a[0] - b[0]);
const liqs = [];
for (const f of fs.readdirSync(DIR).filter(x => /^eth_liquidations_v2_\d{4}-\d{2}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const hdr = lines[0].split(','); const ti = hdr.indexOf('log_time'), ui = hdr.indexOf('usd_value');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 5) continue;
        const ms = Date.parse(c[ti]), usd = parseFloat(c[ui]); if (isFinite(ms) && isFinite(usd)) liqs.push([ms, usd]); }
}
liqs.sort((a, b) => a[0] - b[0]);
function sessionBounds(dateStr) { const s = Date.parse(dateStr + 'T08:00:00+10:00'); return [s, s + 23 * 3600e3]; }
function fundingStats(dateStr) {
    const [a, b] = sessionBounds(dateStr); let max = 0, hi = 0, cross = 0, prev = null, n = 0;
    for (const [t, v] of fund) { if (t < a) continue; if (t > b) break; n++;
        if (Math.abs(v) > max) max = Math.abs(v); if (Math.abs(v) > 0.005) hi++;
        if (prev !== null && Math.sign(v) !== Math.sign(prev) && v !== 0 && prev !== 0) cross++; prev = v; }
    return { max, hiHrs: hi / 60, cross, n };
}
function liqTotal(dateStr) { const [a, b] = sessionBounds(dateStr); let s = 0;
    for (const [t, usd] of liqs) { if (t < a) continue; if (t > b) break; s += usd; } return s / 1e6; }

// ─── outcomes by entry day ───────────────────────────────────────────────────
const TRADES = [
    ['2026-07-06', -304], ['2026-07-13', -304], ['2026-07-13', 1996], ['2026-07-14', -304], ['2026-07-14', 1996],
    ['2026-07-15', 1996], ['2026-07-16', 1563], ['2026-07-17', 1996], ['2026-07-20', -304], ['2026-07-24', -304],
    ['2026-07-27', -304], ['2026-07-27', -304], ['2026-07-28', 1996], ['2026-08-03', -304], ['2026-08-07', -304],
    ['2026-08-08', -304], ['2026-08-10', -304], ['2026-08-11', 297], ['2026-08-12', 339], ['2026-08-13', -304],
    ['2026-08-13', -304], ['2026-08-14', -304], ['2026-08-14', -304], ['2026-08-18', 1393], ['2026-08-20', -301],
    ['2026-08-20', 1272], ['2026-09-15', -300], ['2026-09-15', -300],
];
// note: entries after midnight are attributed to the session that began the previous 08:00
const outcome = new Map();
for (const [d, t] of TRADES) { const o = outcome.get(d) || { net: 0, n: 0, best: 0 }; o.net += t; o.n++; if (t > o.best) o.best = t; outcome.set(d, o); }

// ─── build the daily table ───────────────────────────────────────────────────
const out = [];
out.push('BOARD #2 — WEATHER ALMANAC'); out.push('generated ' + new Date().toISOString()); out.push('');
out.push('PRE-REGISTERED: dies if harvest days do not sit in a visibly different pressure regime from desert days.');
out.push('');
out.push('date        dow  range_t  dgs30  d30_30d  d30vol  vxtlt   vix   runA  runAB  fr_max   fr_hrs>.005  cross  liq_M   trades  net    class');
out.push('-'.repeat(130));
const rows = [];
const sortedDays = [...days.keys()].filter(k => k >= '2026-07-06').sort();
for (const d of sortedDays) {
    const r = days.get(d); if (r.bars < 200) continue;          // skip partial/holiday sessions
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d).getUTCDay()];
    const y = lastBefore(dgs30, d), v = lastBefore(vix, d), bx = lastBefore(vxtlt, d);
    const fs_ = fundingStats(d);
    const o = outcome.get(d);
    let cls = 'quiet';
    if (o) cls = o.best >= 1000 ? 'HARVEST' : (o.net > 0 ? 'win' : 'LOSS');
    if (d >= '2026-08-21' && d <= '2026-09-17' && !o) cls = 'desert';
    const row = { d, dow, range: (r.hi - r.lo) * 4, dgs30: y ? y.v : null, d30: fredChange(dgs30, d, 30), vol: fredVol(dgs30, d, 30),
        vix: v ? v.v : null, vxtlt: bx ? bx.v : null, runA: runway(d, ['A']), runAB: runway(d, ['A', 'B']), frmax: fs_.max, frhrs: fs_.hiHrs, cross: fs_.cross,
        liq: liqTotal(d), n: o ? o.n : 0, net: o ? o.net : 0, cls };
    rows.push(row);
    const f = (x, w, p = 1) => (x === null || x === undefined ? '-' : (typeof x === 'number' ? x.toFixed(p) : String(x))).padStart(w);
    out.push(d + '  ' + dow + '  ' + f(row.range, 6, 0) + '  ' + f(row.dgs30, 5, 2) + '  ' + f(row.d30, 6, 0) + '  ' + f(row.vol, 5, 1) + '  ' +
        f(row.vxtlt, 5, 1) + '  ' + f(row.vix, 5, 1) + '  ' + f(row.runA, 4, 0) + '  ' + f(row.runAB, 5, 0) + '  ' + f(row.frmax, 7, 4) + '  ' + f(row.frhrs, 10, 1) + '  ' +
        f(row.cross, 5, 0) + '  ' + f(row.liq, 6, 1) + '  ' + f(row.n, 5, 0) + '  ' + f(row.net, 5, 0) + '   ' + cls);
}

// ─── group comparison ────────────────────────────────────────────────────────
const med = a => { const s = a.filter(x => x !== null && x !== undefined && isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const groups = { HARVEST: rows.filter(r => r.cls === 'HARVEST'), LOSS: rows.filter(r => r.cls === 'LOSS'), desert: rows.filter(r => r.cls === 'desert'), quiet: rows.filter(r => r.cls === 'quiet') };
out.push(''); out.push('═══ GROUP MEDIANS ═══');
out.push('group     n   range_t  dgs30  d30_30d  d30vol  vxtlt   vix   runA  runAB  fr_max   fr_hrs  cross  liq_M');
for (const [g, rs] of Object.entries(groups)) {
    const f = (x, w, p = 1) => (x === null ? '-' : x.toFixed(p)).padStart(w);
    out.push(g.padEnd(8) + String(rs.length).padStart(3) + '  ' + f(med(rs.map(r => r.range)), 7, 0) + '  ' + f(med(rs.map(r => r.dgs30)), 5, 2) + '  ' +
        f(med(rs.map(r => r.d30)), 6, 0) + '  ' + f(med(rs.map(r => r.vol)), 5, 1) + '  ' + f(med(rs.map(r => r.vxtlt)), 5, 1) + '  ' + f(med(rs.map(r => r.vix)), 5, 1) + '  ' +
        f(med(rs.map(r => r.runA)), 4, 0) + '  ' + f(med(rs.map(r => r.runAB)), 5, 0) + '  ' + f(med(rs.map(r => r.frmax)), 7, 4) + '  ' +
        f(med(rs.map(r => r.frhrs)), 6, 1) + '  ' + f(med(rs.map(r => r.cross)), 5, 0) + '  ' + f(med(rs.map(r => r.liq)), 6, 1));
}
out.push(''); out.push('Read: a variable that separates HARVEST from desert (and ideally from LOSS) is a pressure system. One that does not is weather noise.');

fs.writeFileSync(path.join(DIR, 'weather_almanac.txt'), out.join('\n') + '\n');
console.log(out.join('\n'));
