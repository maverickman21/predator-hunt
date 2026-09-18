/**
 * PREDATOR VACUUM v0 — FADE SIM (board #2, 2026-09-18)
 *
 * Hypothesis: an announcement-grade push with NO pain behind it (crowd-side liq smoke
 * below P50 of the prior week's 15-min windows) exhausts on contact and snaps back.
 * Trade: FADE it — enter opposite the push, PT 600 / SL 300, session-flat, cutoff 0.
 *
 * PRE-REGISTERED (written before running):
 *   The vacuum book DIES if the LOW-SMOKE fades do not show positive expectancy at 600/300,
 *   OR if the HIGH-SMOKE control group (fading a real burn) does not lose.
 *
 * Inputs on the VPS: digest_fires.csv, eth_pillars_v3_*.csv, eth_liquidations_v2_*.csv,
 *                    MNQ_SEP26_1min.txt, MNQ_DEC26_1min.txt (NT export — timestamps are UTC)
 * Run: node vacuum-sim.js -> vacuum_sim.txt
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TICK = 0.25;

// ─── MNQ bars -> [ms(UTC), o, h, l, c] ───────────────────────────────────────
function loadBars(file) {
    const arr = [];
    if (!fs.existsSync(path.join(DIR, file))) { console.log('missing ' + file); return arr; }
    for (const line of fs.readFileSync(path.join(DIR, file), 'utf8').split(/\r?\n/)) {
        const p = line.split(';'); if (p.length < 5) continue;
        const dt = p[0].trim(); if (!/^\d{8} \d{6}$/.test(dt)) continue;
        const ms = Date.UTC(+dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8), +dt.slice(9, 11), +dt.slice(11, 13), +dt.slice(13, 15));   // NT export verified UTC (2026-09-18)
        arr.push([ms, +p[1], +p[2], +p[3], +p[4]]);
    }
    arr.sort((a, b) => a[0] - b[0]);
    return arr;
}
const SEP = loadBars('MNQ_SEP26_1min.txt'), DEC = loadBars('MNQ_DEC26_1min.txt');
const ROLL_MS = Date.parse('2026-09-10T08:00:00+10:00');
console.log('bars SEP ' + SEP.length + ', DEC ' + DEC.length);
function barsFor(ms) { return ms < ROLL_MS ? SEP : DEC; }
function firstBarAtOrAfter(bars, ms) {
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid][0] >= ms) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
}
const qldHour = ms => new Date(ms + 10 * 3600e3).getUTCHours();
function sessionEnd(ms) {   // next 06:59 Qld strictly after ms
    const q = new Date(ms + 10 * 3600e3);
    let end = Date.UTC(q.getUTCFullYear(), q.getUTCMonth(), q.getUTCDate(), 6, 59) - 10 * 3600e3;
    if (end <= ms) end += 86400e3;
    return end;
}

// ─── funding + liqs (for smoke tagging, same as Phase 1) ─────────────────────
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
    const hdr = lines[0].split(','); const ti = hdr.indexOf('log_time'), si = hdr.indexOf('side'), ui = hdr.indexOf('usd_value');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 5) continue;
        const ms = Date.parse(c[ti]), usd = parseFloat(c[ui]), side = parseInt(c[si]); if (isFinite(ms) && isFinite(usd)) liqs.push([ms, side, usd]); }
}
liqs.sort((a, b) => a[0] - b[0]);
function liqSum(from, to) {
    let L = 0, S = 0, lo = 0, hi = liqs.length - 1, start = liqs.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (liqs[mid][0] >= from) { start = mid; hi = mid - 1; } else lo = mid + 1; }
    for (let i = start; i < liqs.length && liqs[i][0] <= to; i++) { if (liqs[i][1] === 1) L += liqs[i][2]; else if (liqs[i][1] === 2) S += liqs[i][2]; }
    return { L: L / 1e6, S: S / 1e6 };
}
function smokePct(ms, side, x) {
    const vals = [];
    for (let t = ms - 7 * 86400e3; t < ms; t += 15 * 60e3) { const s = liqSum(t, t + 15 * 60e3); vals.push(side === 'SHORT' ? s.L : s.S); }
    return vals.length ? vals.filter(v => v < x).length / vals.length : null;
}
function fundingAt(ms) { let lo = 0, hi = fund.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (fund[mid][0] <= ms) { best = fund[mid]; lo = mid + 1; } else hi = mid - 1; } return best ? best[1] : null; }

// ─── fires ───────────────────────────────────────────────────────────────────
const fires = [];
for (const line of fs.readFileSync(path.join(DIR, 'digest_fires.csv'), 'utf8').split(/\r?\n/)) {
    const c = line.split(','); if (c.length < 8 || c[0] === 'ts_utc') continue;
    const ms = Date.parse(c[0]); if (!isFinite(ms)) continue;
    fires.push({ ms, qld: c[1], side: c[2].toUpperCase(), via: c[3], thumb: +c[6], floor: +c[7] });
}
fires.sort((a, b) => a.ms - b.ms);

// ─── the fade simulator ──────────────────────────────────────────────────────
// dir: +1 = long fade, -1 = short fade. Returns {ticks, exit, mfe, mae, bars}
function simulate(fireMs, dir, ptTicks, slTicks, trail) {
    const bars = barsFor(fireMs);
    const i0 = firstBarAtOrAfter(bars, fireMs);
    if (i0 < 0 || i0 + 1 >= bars.length) return null;
    const entry = bars[i0 + 1][1];                 // next bar's open (realistic fill)
    const end = sessionEnd(fireMs);
    const pt = ptTicks * TICK, sl = slTicks * TICK;
    let stop = dir > 0 ? entry - sl : entry + sl;
    let mfe = 0, mae = 0, n = 0;
    for (let i = i0 + 1; i < bars.length; i++) {
        const [ms, o, h, l, c] = bars[i];
        if (ms >= end) return { ticks: Math.round((c - entry) * dir / TICK), exit: 'close', mfe, mae, bars: n };
        n++;
        const fav = dir > 0 ? (h - entry) : (entry - l), adv = dir > 0 ? (entry - l) : (h - entry);
        if (fav > mfe) mfe = fav; if (adv > mae) mae = adv;
        // stop first (conservative), then target
        if (dir > 0 ? l <= stop : h >= stop) return { ticks: Math.round((stop - entry) * dir / TICK), exit: 'stop', mfe, mae, bars: n };
        if (ptTicks > 0 && (dir > 0 ? h >= entry + pt : l <= entry - pt)) return { ticks: ptTicks, exit: 'target', mfe, mae, bars: n };
        if (trail && mfe >= trail.activate * TICK) {
            const newStop = dir > 0 ? (entry + mfe) - trail.dist * TICK : (entry - mfe) + trail.dist * TICK;
            if (dir > 0 ? newStop > stop : newStop < stop) stop = newStop;
        }
    }
    return null;
}

// ─── run ─────────────────────────────────────────────────────────────────────
const out = [];
out.push('PREDATOR VACUUM v0 — FADE SIM (MNQ 1-min, next-bar-open fills, stop checked before target)');
out.push('generated ' + new Date().toISOString());
out.push('');
out.push('PRE-REGISTERED: the vacuum book DIES if low-smoke fades (<P50) lack positive expectancy at 600/300,');
out.push('                OR if the high-smoke control (>=P75, fading a real burn) does not lose.');
out.push('doctrine applied to fades: no entries 00:00-08:00 Qld (cutoff 0); session-flat 06:59.');
out.push('');
out.push('   fire qld          push   fade  smokePct  fr@fire   | 300/300   450/300   600/300   trail(+300,300)  mfe(t)');
out.push('-'.repeat(120));

const VARIANTS = [[300, 300, null], [450, 300, null], [600, 300, null], [0, 300, { activate: 300, dist: 300 }]];
const rows = [];
for (const f of fires) {
    const h = qldHour(f.ms); if (h >= 0 && h < 8) continue;          // cutoff 0
    const ep = liqSum(f.ms - 15 * 60e3, f.ms);
    const smoke = f.side === 'SHORT' ? ep.L : ep.S;
    const pct = smokePct(f.ms, f.side, smoke);
    const dir = f.side === 'SHORT' ? +1 : -1;                          // fade = opposite the push
    const res = VARIANTS.map(([pt, sl, tr]) => simulate(f.ms, dir, pt, sl, tr));
    if (res.some(r => r === null)) continue;
    const row = { f, pct, fr: fundingAt(f.ms), res };
    rows.push(row);
    const cell = r => (String(r.ticks).padStart(5) + r.exit[0]).padEnd(8);
    out.push(f.qld + '  ' + f.side.padEnd(5) + '  ' + (dir > 0 ? 'LONG ' : 'SHORT') + '  ' +
        (pct !== null ? (pct * 100).toFixed(0).padStart(5) + '%' : '    ?') + '   ' +
        (row.fr !== null ? row.fr.toFixed(5) : '   ?   ').padStart(8) + '  | ' +
        cell(res[0]) + '  ' + cell(res[1]) + '  ' + cell(res[2]) + '  ' + cell(res[3]).padEnd(16) + '  ' +
        String(Math.round(res[2].mfe / TICK)).padStart(5));
}

function summary(name, rs) {
    out.push('');
    out.push('── ' + name + ' (' + rs.length + ' fades)');
    if (!rs.length) return;
    VARIANTS.forEach(([pt, sl, tr], k) => {
        const t = rs.map(r => r.res[k].ticks);
        const net = t.reduce((s, x) => s + x, 0), w = t.filter(x => x > 0).length;
        const label = tr ? 'trail(+300,300)' : (pt + '/' + sl);
        out.push('   ' + label.padEnd(16) + ' net ' + String(net).padStart(6) + 't  W/L ' + w + '/' + (t.length - w) +
            '  (' + (100 * w / t.length).toFixed(0) + '%)  avg ' + (net / t.length).toFixed(0) + 't/fade' +
            '  exits: ' + ['target', 'stop', 'close'].map(e => e[0] + '=' + rs.filter(r => r.res[k].exit === e).length).join(' '));
    });
}
out.push('');
out.push('═══ GROUPS ═══');
summary('LOW-SMOKE  (<P50)  — the vacuum candidates', rows.filter(r => r.pct !== null && r.pct < 0.5));
summary('MID-SMOKE  (P50-P75)', rows.filter(r => r.pct !== null && r.pct >= 0.5 && r.pct < 0.75));
summary('HIGH-SMOKE (>=P75) — CONTROL: fading a real burn should LOSE', rows.filter(r => r.pct !== null && r.pct >= 0.75));
summary('ALL fades', rows);

fs.writeFileSync(path.join(DIR, 'vacuum_sim.txt'), out.join('\n') + '\n');
console.log(out.join('\n'));
