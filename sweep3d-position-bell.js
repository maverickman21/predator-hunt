/**
 * SWEEP 3D - THE BELL IN-FLIGHT (position-relative, per ratified spec)
 * Ring while IN a position requires ALL of:
 *   1. coin-bar destruction spike: dOIc < 0, |dOIc| >= barP of trailing 1440 NQ-clock bars
 *   2. funding condition, position-relative:
 *        SHORT: 30m funding change POSITIVE with |gap| >= gapP of trailing 7d   (adverse gap)
 *               OR funding rank <= 0.08 of trailing 14d                         (own-side pin)
 *        LONG : 30m funding change NEGATIVE with |gap| >= gapP                  (adverse gap)
 *               OR funding rank >= 0.92                                         (own-side pin)
 * Evaluated inside the week's three adjudicated position windows:
 *   LONG  Tue 08:00 -> Wed 07:00   (must ring near Wed 05:23)
 *   SHORT Thu 17:45 -> Fri 07:00   (must NOT ring near Thu 23:52)
 *   SHORT Fri 09:21 -> Sat 07:00   (must ring near Fri 23:59)
 * Also reports ALL rings inside each window (false-ring count is the real exam).
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
function isWeekend(ms) {
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }
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
const frAt = new Map(rows.map(r => [r.ms, r.fr]));
function frNear(t) { for (let m = t; m >= t - 10 * 60000; m -= 60000) { if (frAt.has(m)) return frAt.get(m); } return null; }
function gapSigned(t) { const a = frNear(t), b = frNear(t - 30 * 60000); return (a !== null && b !== null) ? a - b : 0; }
function gapMagRank(t) {
  const cur = Math.abs(gapSigned(t)); let below = 0, n = 0;
  for (let m = t - 7 * 864e5; m < t; m += 30 * 60000) { if (Math.abs(gapSigned(m)) < cur) below++; n++; }
  return n ? below / n : 0;
}
// 14d funding rank on 5-min grid
const msArr = rows.map(r => r.ms), frArr = rows.map(r => r.fr);
const rankAt = new Map(); { let w = 0;
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t % (5 * 60000) !== 0) continue;
    while (msArr[w] < t - 14 * 864e5) w++;
    const n = i - w; if (n < 500) continue;
    let below = 0; const cur = frArr[i];
    for (let j = w; j < i; j++) if (frArr[j] < cur) below++;
    rankAt.set(t, below / n);
  }
}
function frRank(t) { const g = t - (t % (5 * 60000)); return rankAt.has(g) ? rankAt.get(g) : null; }

const WINDOWS = [
  { side: 'LONG',  from: Date.parse('2026-07-14T08:00:00+10:00'), to: Date.parse('2026-07-15T07:00:00+10:00'), target: Date.parse('2026-07-15T05:23:00+10:00'), want: true,  label: 'LONG Tue->Wed (ring @Wed05:23)' },
  { side: 'SHORT', from: Date.parse('2026-07-16T17:45:00+10:00'), to: Date.parse('2026-07-17T07:00:00+10:00'), target: Date.parse('2026-07-16T23:52:00+10:00'), want: false, label: 'SHORT Thu->Fri (SILENT @Thu23:52)' },
  { side: 'SHORT', from: Date.parse('2026-07-17T09:21:00+10:00'), to: Date.parse('2026-07-18T07:00:00+10:00'), target: Date.parse('2026-07-17T23:59:00+10:00'), want: true,  label: 'SHORT Fri->Sat (ring @Fri23:59)' }
];

const out = [];
out.push('SWEEP 3D - POSITION-RELATIVE BELL  ' + new Date().toISOString());
out.push('');
for (const BP of [95, 98]) for (const GP of [90, 95]) {
  out.push('=== bar P' + BP + ' / gap P' + GP + ' ===');
  let pass = 0;
  for (const W of WINDOWS) {
    const rings = []; let last = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.ms < W.from || r.ms > W.to) continue;
      if (r.dOIc >= 0) continue;
      if (Math.abs(r.dOIc) < 300) continue;
      if (r.ms - last < 30 * 60000) continue;
      if (barRank(i) < BP / 100) continue;
      const g = gapSigned(r.ms); const gm = gapMagRank(r.ms); const fr = frRank(r.ms);
      let fund = false;
      if (W.side === 'SHORT') fund = (g > 0 && gm >= GP / 100) || (fr !== null && fr <= 0.08);
      else fund = (g < 0 && gm >= GP / 100) || (fr !== null && fr >= 0.92);
      if (!fund) continue;
      rings.push(r.ms); last = r.ms;
    }
    const near = rings.find(m => Math.abs(m - W.target) <= 45 * 60000);
    const ok = (!!near) === W.want; if (ok) pass++;
    out.push('  ' + W.label + '  got:' + (near ? 'RING@' + qld(near) : 'no-target-ring') +
      '  rings-in-window: ' + rings.length + (rings.length ? '  [' + rings.map(qld).join(' | ') + ']' : '') +
      '  ' + (ok ? 'PASS' : 'FAIL'));
  }
  out.push('  SCORE ' + pass + '/3');
  out.push('');
}
fs.writeFileSync('sweep3d_results.txt', out.join('\n') + '\n');
console.log('wrote sweep3d_results.txt');
