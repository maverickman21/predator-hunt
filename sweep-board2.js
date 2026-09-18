/**
 * BOARD #2 — PHASE 1 SWEEP (2026-09-18)
 * VPS-archive-only tests. No MNQ price needed.
 *
 * For EVERY fire in digest_fires.csv, tag:
 *   epLiqL / epLiqS   : liquidation $ in the 15-min EPISODE ending at fire time
 *   smokeM            : crowd-side liq $ (SHORT fire -> longs are the crowd -> liqL; LONG -> liqS)
 *   smokePct          : percentile of smokeM against ALL 15-min crowd-side liq windows in the prior 7 days
 *   slope60           : funding now minus funding 60 min earlier (SHORT wants <0 = draining; LONG wants >0 = rising)
 *   fr / peak / drained%
 * Then join the graded trades (26 backtest + 2 live 15 Sep) and test clauses.
 *
 * FALSIFICATION CONDITIONS (written before running):
 *   SIZE FLOOR  dies if crowd-side liq at fire does NOT separate winners from losers
 *               (i.e. winners' median smokePct not clearly above losers'), or if any P-level
 *               that removes the 15 Sep losers also kills a July harvest.
 *   SLOPE CHECK dies if it blocks ANY winner (esp. the July 14 LONG harvest, #5).
 *   ZERO-LIQ VETO dies if it blocks any winner.
 *
 * Run: node sweep-board2.js  -> board2_phase1.txt
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

// ─── funding series ──────────────────────────────────────────────────────────
const fund = [];
for (const f of fs.readdirSync(DIR).filter(x => /^eth_pillars_v3_\d{4}-\d{2}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_close');
    if (ti < 0 || fi < 0) continue;
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(','); if (c.length < 6) continue;
        const ms = Date.parse(c[ti]); const v = parseFloat(c[fi]);
        if (isFinite(ms) && isFinite(v)) fund.push([ms, v]);
    }
}
fund.sort((a, b) => a[0] - b[0]);

// ─── liquidations ────────────────────────────────────────────────────────────
const liqs = [];   // [ms, side(1=long,2=short), usd]
for (const f of fs.readdirSync(DIR).filter(x => /^eth_liquidations_v2_\d{4}-\d{2}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('log_time'), si = hdr.indexOf('side'), ui = hdr.indexOf('usd_value');
    if (ti < 0) continue;
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(','); if (c.length < 5) continue;
        const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]); const side = parseInt(c[si]);
        if (isFinite(ms) && isFinite(usd)) liqs.push([ms, side, usd]);
    }
}
liqs.sort((a, b) => a[0] - b[0]);
console.log('funding pts ' + fund.length + ', liq events ' + liqs.length);

// ─── fires ───────────────────────────────────────────────────────────────────
const fires = [];
for (const line of fs.readFileSync(path.join(DIR, 'digest_fires.csv'), 'utf8').split(/\r?\n/)) {
    const c = line.split(',');
    if (c.length < 8 || c[0] === 'ts_utc') continue;
    const ms = Date.parse(c[0]); if (!isFinite(ms)) continue;
    fires.push({ ms, qld: c[1], side: c[2].toUpperCase(), via: c[3], dOIc: +c[4], delta: +c[5], thumb: +c[6], floor: +c[7] });
}
fires.sort((a, b) => a.ms - b.ms);
console.log('fires ' + fires.length);

// ─── graded trades (outcomes are ground truth) ───────────────────────────────
const TRADES = [
    { n: 1,  side:'SHORT', entryQld:'2026-07-06 22:11', ticks:-304 },
    { n: 2,  side:'SHORT', entryQld:'2026-07-13 08:51', ticks:-304 },
    { n: 3,  side:'SHORT', entryQld:'2026-07-13 10:41', ticks:1996 },
    { n: 4,  side:'LONG',  entryQld:'2026-07-14 08:16', ticks:-304 },
    { n: 5,  side:'LONG',  entryQld:'2026-07-14 09:31', ticks:1996 },
    { n: 6,  side:'SHORT', entryQld:'2026-07-15 17:31', ticks:1996 },
    { n: 7,  side:'SHORT', entryQld:'2026-07-16 17:46', ticks:1563 },
    { n: 8,  side:'SHORT', entryQld:'2026-07-17 09:26', ticks:1996 },
    { n: 9,  side:'SHORT', entryQld:'2026-07-20 16:36', ticks:-304 },
    { n:10,  side:'LONG',  entryQld:'2026-07-24 03:26', ticks:-304 },
    { n:11,  side:'SHORT', entryQld:'2026-07-27 11:41', ticks:-304 },
    { n:12,  side:'SHORT', entryQld:'2026-07-28 00:41', ticks:-304 },
    { n:13,  side:'SHORT', entryQld:'2026-07-28 08:46', ticks:1996 },
    { n:14,  side:'SHORT', entryQld:'2026-08-03 08:41', ticks:-304 },
    { n:15,  side:'SHORT', entryQld:'2026-08-08 00:11', ticks:-304 },
    { n:16,  side:'SHORT', entryQld:'2026-08-08 03:06', ticks:-304 },
    { n:17,  side:'SHORT', entryQld:'2026-08-11 01:01', ticks:-304 },
    { n:18,  side:'SHORT', entryQld:'2026-08-11 02:26', ticks:297 },
    { n:19,  side:'SHORT', entryQld:'2026-08-13 00:16', ticks:339 },
    { n:20,  side:'SHORT', entryQld:'2026-08-13 08:06', ticks:-304 },
    { n:21,  side:'SHORT', entryQld:'2026-08-13 16:11', ticks:-304 },
    { n:22,  side:'SHORT', entryQld:'2026-08-14 02:41', ticks:-304 },
    { n:23,  side:'LONG',  entryQld:'2026-08-14 23:36', ticks:-304 },
    { n:24,  side:'SHORT', entryQld:'2026-08-18 13:01', ticks:1393 },
    { n:25,  side:'SHORT', entryQld:'2026-08-20 08:10', ticks:-301 },
    { n:26,  side:'SHORT', entryQld:'2026-08-20 13:15', ticks:1272 },
    { n:27,  side:'LONG',  entryQld:'2026-09-15 13:35', ticks:-300, live:true },
    { n:28,  side:'LONG',  entryQld:'2026-09-15 15:35', ticks:-300, live:true },
];
const qldToMs = s => Date.parse(s.replace(' ', 'T') + ':00+10:00');

// ─── helpers ─────────────────────────────────────────────────────────────────
function fundingAt(ms) {
    let lo = 0, hi = fund.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (fund[mid][0] <= ms) { best = fund[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best ? best[1] : null;
}
function arcPeak(ms, sign) {
    const cutoff = ms - 36 * 3600e3; let peak = 0;
    for (let i = fund.length - 1; i >= 0; i--) {
        const [t, v] = fund[i]; if (t > ms) continue; if (t < cutoff) break;
        if (sign > 0 && v < 0) break; if (sign < 0 && v > 0) break;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
    }
    return peak;
}
// arc start = the last zero-crossing (or 36h back) before ms, on the fire's side
function arcStart(ms, sign) {
    const cutoff = ms - 36 * 3600e3; let start = cutoff;
    for (let i = fund.length - 1; i >= 0; i--) {
        const [t, v] = fund[i]; if (t > ms) continue; if (t < cutoff) break;
        if ((sign > 0 && v < 0) || (sign < 0 && v > 0)) { start = t; break; }
    }
    return start;
}
// liq sums in [from, to]
let liqIdx = 0;
function liqSum(from, to) {
    let L = 0, S = 0, n = 0;
    // binary search start
    let lo = 0, hi = liqs.length - 1, start = liqs.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (liqs[mid][0] >= from) { start = mid; hi = mid - 1; } else lo = mid + 1; }
    for (let i = start; i < liqs.length && liqs[i][0] <= to; i++) {
        n++; if (liqs[i][1] === 1) L += liqs[i][2]; else if (liqs[i][1] === 2) S += liqs[i][2];
    }
    return { L: L / 1e6, S: S / 1e6, n };
}
// percentile of x among 15-min crowd-side sums over the prior 7 days
function smokePercentile(ms, side, x) {
    const vals = [];
    for (let t = ms - 7 * 86400e3; t < ms; t += 15 * 60e3) {
        const s = liqSum(t, t + 15 * 60e3);
        vals.push(side === 'SHORT' ? s.L : s.S);
    }
    if (!vals.length) return null;
    const below = vals.filter(v => v < x).length;
    return below / vals.length;
}

// ─── tag every fire ──────────────────────────────────────────────────────────
const out = [];
out.push('BOARD #2 — PHASE 1 (episode liq size, funding slope, size floor, slope check)');
out.push('generated ' + new Date().toISOString());
out.push('');
out.push('FALSIFICATION CONDITIONS (pre-registered):');
out.push('  SIZE FLOOR dies if winners\' median smokePct is not clearly above losers\', or if the P-level that removes 15 Sep also kills a July harvest.');
out.push('  SLOPE CHECK dies if it blocks ANY winner (esp. #5, the July 14 LONG harvest).');
out.push('  ZERO-LIQ VETO dies if it blocks any winner.');
out.push('');
out.push('ALL FIRES (graded where an outcome exists):');
out.push('   qld              side  via     ticks  thumb/floor  fr@fire   drained  ep liqL/liqS   smoke$M  smokePct  slope60    arcPain$M  arcHrs  painRatio');
out.push('-'.repeat(120));

const tagged = [];
for (const f of fires) {
    const fr = fundingAt(f.ms);
    const sign = f.side === 'SHORT' ? 1 : -1;
    const peak = arcPeak(f.ms, sign);
    const drained = (peak !== 0 && fr !== null) ? Math.max(0, Math.min(100, (1 - fr / peak) * 100)) : null;
    const ep = liqSum(f.ms - 15 * 60e3, f.ms);
    const smoke = f.side === 'SHORT' ? ep.L : ep.S;
    const pct = smokePercentile(f.ms, f.side, smoke);
    const aStart = arcStart(f.ms, sign);
    const arcLiq = liqSum(aStart, f.ms);
    const arcPain = f.side === 'SHORT' ? arcLiq.L : arcLiq.S;          // cumulative crowd-side $M since arc start
    const painRatio = peak !== 0 ? arcPain / Math.abs(peak) / 1000 : null; // $M of pain per 0.001 of peak funding
    const arcHrs = (f.ms - aStart) / 3600e3;
    const f60 = fundingAt(f.ms - 3600e3);
    const slope = (fr !== null && f60 !== null) ? fr - f60 : null;
    // join to a graded trade within 20 min, same side
    let trade = null;
    for (const t of TRADES) { if (t.side === f.side && Math.abs(qldToMs(t.entryQld) - f.ms) <= 20 * 60e3) { trade = t; break; } }
    const row = { ...f, fr, peak, drained, epL: ep.L, epS: ep.S, smoke, pct, slope, trade, arcPain, painRatio, arcHrs };
    tagged.push(row);
    out.push(
        f.qld + '  ' + f.side.padEnd(5) + ' ' + f.via.padEnd(7) + ' ' +
        (trade ? String(trade.ticks).padStart(5) + (trade.live ? 'L' : ' ') : '   -- ') + ' ' +
        (f.thumb.toFixed(3) + '/' + f.floor.toFixed(3)) + '  ' +
        (fr !== null ? fr.toFixed(6) : '   ?   ').padStart(9) + '  ' +
        (drained !== null ? String(drained.toFixed(0)).padStart(4) + '%' : '   ?%') + '   ' +
        (ep.L.toFixed(1) + '/' + ep.S.toFixed(1)).padEnd(12) + '  ' +
        smoke.toFixed(2).padStart(6) + '   ' +
        (pct !== null ? (pct * 100).toFixed(0).padStart(5) + '%' : '    ?') + '    ' +
        (slope !== null ? (slope >= 0 ? '+' : '') + slope.toFixed(5) : '   ?') + '   ' +
        arcPain.toFixed(1).padStart(8) + '  ' + arcHrs.toFixed(1).padStart(5) + '  ' +
        (painRatio !== null ? painRatio.toFixed(2).padStart(8) : '       ?')
    );
}

// ─── graded set ──────────────────────────────────────────────────────────────
const graded = tagged.filter(r => r.trade);
const unmatched = TRADES.filter(t => !graded.find(g => g.trade === t));
out.push('');
out.push('graded fires: ' + graded.length + ' / trades supplied: ' + TRADES.length +
    (unmatched.length ? '   (no fire match for #' + unmatched.map(t => t.n).join(', #') + ')' : ''));

const winners = graded.filter(r => r.trade.ticks > 0), losers = graded.filter(r => r.trade.ticks <= 0);
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
out.push('');
out.push('═══ A2: EPISODE LIQ SIZE — winners vs losers ═══');
out.push('  winners (' + winners.length + '): median smoke$M ' + med(winners.map(r => r.smoke)).toFixed(2) + ', median smokePct ' + (med(winners.map(r => r.pct)) * 100).toFixed(0) + '%');
out.push('  losers  (' + losers.length + '): median smoke$M ' + med(losers.map(r => r.smoke)).toFixed(2) + ', median smokePct ' + (med(losers.map(r => r.pct)) * 100).toFixed(0) + '%');
out.push('  winners smoke$M: ' + winners.map(r => '#' + r.trade.n + '=' + r.smoke.toFixed(2)).join(' '));
out.push('  losers  smoke$M: ' + losers.map(r => '#' + r.trade.n + '=' + r.smoke.toFixed(2)).join(' '));
out.push('  zero-smoke fires (crowd-side < $0.05M): ' + graded.filter(r => r.smoke < 0.05).map(r => '#' + r.trade.n + '(' + r.trade.ticks + ')').join(' '));

// ─── PAIN RATIO: does cumulative crowd-side pain / peak funding sort the SHORT side? ──
out.push('');
out.push('═══ PAIN RATIO (cumulative crowd-side liq $M since arc start / peak funding per 0.001) ═══');
out.push('  PRE-REGISTERED: dies if it does not separate the SHORT winners from the SHORT losers.');
const sW = graded.filter(r => r.side === 'SHORT' && r.trade.ticks > 0), sL = graded.filter(r => r.side === 'SHORT' && r.trade.ticks <= 0);
const fmtR = r => '#' + r.trade.n + '=' + (r.painRatio !== null ? r.painRatio.toFixed(2) : '?') + '(' + r.arcPain.toFixed(1) + '$M/' + r.arcHrs.toFixed(0) + 'h)';
out.push('  SHORT winners (' + sW.length + '): median ratio ' + (med(sW.map(r => r.painRatio)) || 0).toFixed(2) + ' | ' + sW.map(fmtR).join(' '));
out.push('  SHORT losers  (' + sL.length + '): median ratio ' + (med(sL.map(r => r.painRatio)) || 0).toFixed(2) + ' | ' + sL.map(fmtR).join(' '));
const lW = graded.filter(r => r.side === 'LONG' && r.trade.ticks > 0), lL = graded.filter(r => r.side === 'LONG' && r.trade.ticks <= 0);
out.push('  LONG winners  (' + lW.length + '): ' + lW.map(fmtR).join(' '));
out.push('  LONG losers   (' + lL.length + '): ' + lL.map(fmtR).join(' '));

// ─── clause tests ────────────────────────────────────────────────────────────
const total = graded.reduce((s, r) => s + r.trade.ticks, 0);
function test(name, keep) {
    const kept = graded.filter(keep), dropped = graded.filter(r => !keep(r));
    const net = kept.reduce((s, r) => s + r.trade.ticks, 0);
    const w = kept.filter(r => r.trade.ticks > 0).length;
    const wk = dropped.filter(r => r.trade.ticks > 0);
    out.push('');
    out.push('── ' + name);
    out.push('   kept ' + kept.length + '/' + graded.length + ' | net ' + net + 't (delta ' + (net - total >= 0 ? '+' : '') + (net - total) + ') | W/L ' + w + '/' + (kept.length - w));
    out.push('   dropped: ' + (dropped.length ? '#' + dropped.map(r => r.trade.n + '(' + r.trade.ticks + ')').join(' #') : 'none'));
    out.push(wk.length ? '   *** WINNERS KILLED: ' + wk.map(r => '#' + r.trade.n + '(+' + r.trade.ticks + ')').join(' ') : '   no winners killed');
}
out.push('');
out.push('═══ CLAUSE TESTS (graded set, baseline ' + total + 't) ═══');
test('BASELINE', () => true);
test('ZERO-LIQ VETO: drop fires with crowd-side liq < $0.05M in the episode', r => r.smoke >= 0.05);
for (const p of [0.5, 0.6, 0.7, 0.8]) test('SIZE FLOOR: crowd-side liq >= P' + (p * 100) + ' of prior-7d 15-min windows', r => r.pct === null || r.pct >= p);
for (const q of [0.5, 1.0, 2.0]) test('PAIN RATIO >= ' + q.toFixed(1) + ' (arc pain $M per 0.001 of peak funding)', r => r.painRatio === null || r.painRatio >= q);
for (const q of [1.0, 2.0, 5.0]) test('ARC PAIN >= $' + q.toFixed(0) + 'M cumulative crowd-side since arc start', r => r.arcPain >= q);
test('SLOPE CHECK: SHORT needs funding falling (slope60<0); LONG needs rising (slope60>0)',
    r => r.slope === null || (r.side === 'SHORT' ? r.slope < 0 : r.slope > 0));
test('SLOPE + ZERO-LIQ', r => (r.slope === null || (r.side === 'SHORT' ? r.slope < 0 : r.slope > 0)) && r.smoke >= 0.05);
test('SIZE P60 + SLOPE', r => (r.pct === null || r.pct >= 0.6) && (r.slope === null || (r.side === 'SHORT' ? r.slope < 0 : r.slope > 0)));

// ─── the refused set (fires with no outcome) — what did they look like? ──────
out.push('');
out.push('═══ UNGRADED FIRES (no execution) — tags only, for the Wald column ═══');
for (const r of tagged.filter(r => !r.trade)) {
    out.push('  ' + r.qld + ' ' + r.side + ' ' + r.via + ' smoke$M ' + r.smoke.toFixed(2) + ' pct ' + (r.pct !== null ? (r.pct * 100).toFixed(0) + '%' : '?') + ' slope ' + (r.slope !== null ? r.slope.toFixed(5) : '?'));
}

fs.writeFileSync(path.join(DIR, 'board2_phase1.txt'), out.join('\n') + '\n');
console.log(out.join('\n'));
