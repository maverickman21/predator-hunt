/**
 * SWEEP 3C - THE BELL, AS THE DATA WROTE IT
 * Ring = single bar: dOI-COIN < 0 with |dOIc| in top tail of trailing 24
 * NQ-clock hours of bars, AND 30-min funding gap ranking high vs trailing 7d.
 * No delta. No USD. No episode sums. Coin columns read BY POSITION.
 * Targets: Wed Jul15 05:23 RING | Fri Jul17 23:59 RING | Thu Jul16 23:52 SILENT
 * Auditions: barRank {95, 98} x gapRank {90, 95}
 */
const fs = require('fs');
const rows = [];
{
  const lines = fs.readFileSync('eth_pillars_v3_2026-07.csv', 'utf8').split('\n');
  const h = lines[0].split(',');
  const ti = h.indexOf('timestamp'), fo = h.indexOf('funding_close');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 16) continue;
    const ms = Date.parse(c[ti]); if (!isFinite(ms)) continue;
    const fr = parseFloat(c[fo]);
    let dOIc = 0;
    if (c.length >= 20) {
      const o = parseFloat(c[16]), cl = parseFloat(c[19]);
      if (isFinite(o) && isFinite(cl)) dOIc = cl - o;
    }
    rows.push({ ms: ms - ms % 60000, fr, dOIc });
  }
  rows.sort((a, b) => a.ms - b.ms);
}
const N = rows.length;
function isWeekend(ms) {
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }

// per-bar |dOIc| rank vs trailing 1440 non-weekend bars
function barRank(i) {
  const cur = Math.abs(rows[i].dOIc);
  let below = 0, n = 0;
  for (let j = i - 1; j >= 0 && n < 1440; j--) {
    if (isWeekend(rows[j].ms)) continue;
    if (Math.abs(rows[j].dOIc) < cur) below++;
    n++;
  }
  return n ? below / n : 0;
}
// funding gap: |fr(t) - fr(t-30m)| rank vs trailing 7d of 30-min gaps
const frAt = new Map(rows.map(r => [r.ms, r.fr]));
function frNear(t) { for (let m = t; m >= t - 10 * 60000; m -= 60000) { if (frAt.has(m)) return frAt.get(m); } return null; }
function gap30(t) { const a = frNear(t), b = frNear(t - 30 * 60000); return (a !== null && b !== null) ? Math.abs(a - b) : 0; }
function gapRank(t) {
  const cur = gap30(t); let below = 0, n = 0;
  for (let m = t - 7 * 864e5; m < t; m += 30 * 60000) { if (gap30(m) < cur) below++; n++; }
  return n ? below / n : 0;
}

const TARGETS = [
  ['Wed 05:23 exit', Date.parse('2026-07-15T05:23:00+10:00'), true],
  ['Fri 23:59 exit', Date.parse('2026-07-17T23:59:00+10:00'), true],
  ['Thu 23:52 SHAKEOUT', Date.parse('2026-07-16T23:52:00+10:00'), false]
];
const start = Date.parse('2026-07-06T00:00:00Z');

const out = [];
out.push('SWEEP 3C - COIN-BAR BELL  ' + new Date().toISOString());
out.push('');
for (const BP of [95, 98]) for (const GP of [90, 95]) {
  const rings = []; let last = 0;
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    if (r.ms < start) continue;
    if (r.dOIc >= 0) continue;
    if (Math.abs(r.dOIc) < 300) continue;          // compute prefilter only; rank governs
    if (r.ms - last < 30 * 60000) continue;
    if (barRank(i) < BP / 100) continue;
    if (gapRank(r.ms) < GP / 100) continue;
    rings.push(r.ms); last = r.ms;
  }
  out.push('=== bar P' + BP + ' / gap P' + GP + ' ===');
  let pass = 0;
  for (const [label, T, want] of TARGETS) {
    const near = rings.find(m => Math.abs(m - T) <= 30 * 60000);
    const ok = (!!near) === want; if (ok) pass++;
    out.push('  ' + label + '  want:' + (want ? 'RING' : 'SILENT') + '  got:' + (near ? 'RING@' + qld(near) : 'silent') + '  ' + (ok ? 'PASS' : 'FAIL'));
  }
  out.push('  SCORE ' + pass + '/3   total rings: ' + rings.length);
  out.push('  all rings: ' + rings.map(qld).join(' | '));
  out.push('');
}
fs.writeFileSync('sweep3c_results.txt', out.join('\n') + '\n');
console.log('wrote sweep3c_results.txt');

