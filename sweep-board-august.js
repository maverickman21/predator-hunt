/**
 * BOARD SWEEP — AUGUST 2026
 * Joins live executions to digest fires, tags each trade with:
 *   RANK    : thumb / floor at fire time (from digest_fires.csv)
 *   PHASE   : % drained from the arc's own peak at entry (from the funding series)
 *   TEXTURE : liquidation participation during the 3h before entry (burn vs evacuation)
 * Then tests candidate clauses as filters over the completed trade set.
 *
 * Run:  node sweep-board-august.js
 * Out:  board_sweep_results.txt
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

// ─── load funding series (v3 pillars, all months present) ────────────────────
const fund = [];   // [ms, funding]
for (const f of fs.readdirSync(DIR).filter(x => /^eth_pillars_v3_\d{4}-\d{2}\.csv$/.test(x)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_close');
    if (ti < 0 || fi < 0) { console.log('!! header miss in ' + f); continue; }
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(','); if (c.length < 6) continue;
        const ms = Date.parse(c[ti]); const v = parseFloat(c[fi]);
        if (isFinite(ms) && isFinite(v)) fund.push([ms, v]);
    }
}
fund.sort((a, b) => a[0] - b[0]);
console.log('funding points loaded: ' + fund.length);

// ─── load liquidations ───────────────────────────────────────────────────────
const liqs = [];   // [ms, side, usd]
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
console.log('liq events loaded: ' + liqs.length);

// ─── load fires (rank data) ──────────────────────────────────────────────────
const fires = [];
{
    const p = path.join(DIR, 'digest_fires.csv');
    if (fs.existsSync(p)) {
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
            const c = line.split(',');
            if (c.length < 8 || c[0] === 'ts_utc') continue;
            const ms = Date.parse(c[0]);
            if (!isFinite(ms)) continue;
            fires.push({ ms, side: c[2], via: c[3], dOIc: +c[4], delta: +c[5], thumb: +c[6], floor: +c[7] });
        }
    }
}
console.log('fires loaded: ' + fires.length);

// ─── the 12 live sim trades (from NinjaTrader export) ────────────────────────
// entry/exit are Qld local (UTC+10); ticks are MNQ ticks
const TRADES = [
    { n: 1, side: 'Short', entryQld: '2026-07-27 11:39', exitQld: '2026-07-27 15:20', ticks: -300, mae: 302, mfe: 141, exit: 'stop' },
    { n: 2, side: 'Short', entryQld: '2026-07-27 22:42', exitQld: '2026-07-28 00:25', ticks: 2001, mae: 151, mfe: 2001, exit: 'target' },
    { n: 3, side: 'Short', entryQld: '2026-07-28 00:39', exitQld: '2026-07-28 00:51', ticks: -300, mae: 301, mfe: 403, exit: 'stop' },
    { n: 4, side: 'Short', entryQld: '2026-07-28 08:42', exitQld: '2026-07-29 00:14', ticks: 2000, mae: 238, mfe: 2022, exit: 'target' },
    { n: 5, side: 'Short', entryQld: '2026-08-03 08:42', exitQld: '2026-08-03 13:50', ticks: -300, mae: 345, mfe: 286, exit: 'stop' },
    { n: 6, side: 'Short', entryQld: '2026-08-08 03:05', exitQld: '2026-08-08 05:15', ticks: -300, mae: 305, mfe: 269, exit: 'stop' },
    { n: 7, side: 'Short', entryQld: '2026-08-10 10:35', exitQld: '2026-08-10 15:55', ticks: -300, mae: 301, mfe: 257, exit: 'stop' },
    { n: 8, side: 'Short', entryQld: '2026-08-11 01:05', exitQld: '2026-08-11 06:59', ticks: 139, mae: 231, mfe: 313, exit: 'close' },
    { n: 9, side: 'Long', entryQld: '2026-08-14 23:33', exitQld: '2026-08-15 00:24', ticks: -300, mae: 300, mfe: 209, exit: 'stop' },
    { n: 10, side: 'Short', entryQld: '2026-08-18 12:59', exitQld: '2026-08-19 06:59', ticks: 1388, mae: 78, mfe: 1577, exit: 'close' },
    { n: 11, side: 'Short', entryQld: '2026-08-20 08:10', exitQld: '2026-08-20 09:01', ticks: -301, mae: 302, mfe: 64, exit: 'stop' },
    { n: 12, side: 'Short', entryQld: '2026-08-20 13:15', exitQld: '2026-08-21 06:59', ticks: 1272, mae: 246, mfe: 1691, exit: 'close' }
];

const qldToMs = s => Date.parse(s.replace(' ', 'T') + ':00+10:00');

// ─── helpers ─────────────────────────────────────────────────────────────────
function fundingAt(ms) {
    let lo = 0, hi = fund.length - 1, best = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fund[mid][0] <= ms) { best = fund[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best ? best[1] : null;
}

// arc peak = the extreme of the same-signed run containing the entry,
// looking back until funding crosses zero or 36h elapses
function arcPeak(ms, sign) {
    const cutoff = ms - 36 * 3600e3;
    let peak = 0;
    for (let i = fund.length - 1; i >= 0; i--) {
        const [t, v] = fund[i];
        if (t > ms) continue;
        if (t < cutoff) break;
        if (sign > 0 && v < 0) break;         // zero-crossing ends the arc
        if (sign < 0 && v > 0) break;
        if (Math.abs(v) > Math.abs(peak)) peak = v;
    }
    return peak;
}

// texture: liq participation in the 3h window before entry
function texture(ms) {
    const from = ms - 3 * 3600e3;
    let long = 0, short = 0, n = 0;
    for (const [t, side, usd] of liqs) {
        if (t < from) continue;
        if (t > ms) break;
        n++;
        if (side === 1) long += usd; else if (side === 2) short += usd;
    }
    return { n, longM: long / 1e6, shortM: short / 1e6 };
}

function nearestFire(ms, side) {
    let best = null, bestGap = Infinity;
    for (const f of fires) {
        const gap = Math.abs(f.ms - ms);
        if (gap < bestGap && gap <= 20 * 60000 && f.side.toUpperCase() === side.toUpperCase()) {
            best = f; bestGap = gap;
        }
    }
    return best;
}

// ─── tag every trade ─────────────────────────────────────────────────────────
const out = [];
out.push('BOARD SWEEP — AUGUST 2026 SIM MONTH');
out.push('generated ' + new Date().toISOString());
out.push('');
out.push('# | side  | entry Qld        | ticks | thumb/floor | fr@entry  | arc peak  | drained% | liq3h (L$M/S$M/n) | exit');
out.push('-'.repeat(125));

const rows = [];
for (const t of TRADES) {
    const ms = qldToMs(t.entryQld);
    const fr = fundingAt(ms);
    const sign = t.side === 'Short' ? 1 : -1;      // SHORT hunts a positive (long-crowded) tank
    const peak = arcPeak(ms, sign);
    const drained = (peak !== 0 && fr !== null)
        ? Math.max(0, Math.min(100, (1 - (fr / peak)) * 100)) : null;
    const tx = texture(ms);
    const f = nearestFire(ms, t.side);
    const row = {
        ...t, fr, peak, drained,
        thumb: f ? f.thumb : null, floor: f ? f.floor : null,
        liqL: tx.longM, liqS: tx.shortM, liqN: tx.n,
        // smoke = liquidations on the CROWD's side (the side being burned)
        smokeM: t.side === 'Short' ? tx.longM : tx.shortM
    };
    rows.push(row);
    out.push(
        String(t.n).padStart(2) + ' | ' + t.side.padEnd(5) + ' | ' + t.entryQld + ' | ' +
        String(t.ticks).padStart(5) + ' | ' +
        (row.thumb !== null ? (row.thumb.toFixed(3) + '/' + row.floor.toFixed(3)) : '   ?  /  ?  ') + ' | ' +
        (fr !== null ? fr.toFixed(6) : '    ?    ').padStart(9) + ' | ' +
        (peak !== 0 ? peak.toFixed(6) : '    ?    ').padStart(9) + ' | ' +
        (drained !== null ? drained.toFixed(0).padStart(7) + '%' : '      ?') + ' | ' +
        (row.liqL.toFixed(1) + '/' + row.liqS.toFixed(1) + '/' + row.liqN).padEnd(17) + ' | ' + t.exit);
}

// ─── clause tests ────────────────────────────────────────────────────────────
const total = rows.reduce((s, r) => s + r.ticks, 0);
function testClause(name, keep) {
    const kept = rows.filter(keep);
    const dropped = rows.filter(r => !keep(r));
    const net = kept.reduce((s, r) => s + r.ticks, 0);
    const wins = kept.filter(r => r.ticks > 0).length;
    const winnersKilled = dropped.filter(r => r.ticks > 0);
    out.push('');
    out.push('── ' + name);
    out.push('   trades kept: ' + kept.length + '/' + rows.length +
        '  |  net: ' + net + 't (vs ' + total + 't actual, delta ' + (net - total >= 0 ? '+' : '') + (net - total) + ')' +
        '  |  W/L: ' + wins + '/' + (kept.length - wins) +
        (kept.length ? '  (' + (100 * wins / kept.length).toFixed(0) + '%)' : ''));
    out.push('   dropped: #' + dropped.map(r => r.n).join(', #'));
    if (winnersKilled.length)
        out.push('   *** WINNERS KILLED: ' + winnersKilled.map(r => '#' + r.n + ' (+' + r.ticks + ')').join(', '));
    else out.push('   no winners killed');
}

out.push('');
out.push('═══ CLAUSE TESTS ═══');
testClause('BASELINE (all trades)', () => true);
testClause('A. Burn-phase veto: drop entries >60% drained', r => r.drained === null || r.drained <= 60);
testClause('B. Burn-phase veto: drop entries >50% drained', r => r.drained === null || r.drained <= 50);
testClause('C. Burn-phase veto: drop entries >40% drained', r => r.drained === null || r.drained <= 40);
testClause('D. Max-rank only: thumb >= 0.99', r => r.thumb === null || r.thumb >= 0.99);
testClause('E. Floor >= 0.90', r => r.floor === null || r.floor >= 0.90);
testClause('F. Texture: smoke >= $1M on the crowd side (3h)', r => r.smokeM >= 1);
testClause('G. Texture: smoke >= $5M on the crowd side (3h)', r => r.smokeM >= 5);
testClause('H. Clock: no entries 00:00-04:00 Qld', r => {
    const h = +r.entryQld.slice(11, 13); return !(h >= 0 && h < 4);
});
testClause('I. D + A (max-rank AND <=60% drained)',
    r => (r.thumb === null || r.thumb >= 0.99) && (r.drained === null || r.drained <= 60));
testClause('J. D + F (max-rank AND smoke >= $1M)',
    r => (r.thumb === null || r.thumb >= 0.99) && r.smokeM >= 1);
testClause('K. D + H (max-rank AND no graveyard hours)',
    r => (r.thumb === null || r.thumb >= 0.99) && !((+r.entryQld.slice(11, 13)) >= 0 && (+r.entryQld.slice(11, 13)) < 4));

fs.writeFileSync(path.join(DIR, 'board_sweep_results.txt'), out.join('\n') + '\n');
console.log('\nwrote board_sweep_results.txt');
console.log(out.slice(0, 20).join('\n'));
