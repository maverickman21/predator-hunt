/**
 * SWEEP 3E - THE FULL RATIFIED SPEC + WEDNESDAY PROBE
 * Part 1: anatomy dump, Wed Jul 15 04:30-06:00 Qld (find the real cleanout print)
 * Part 2: bell = spike + position-relative funding + SAME-SIDE VICTIM BURST
 *   SHORT exit: dOIc spike + (gap-up >= gapP OR fr-rank <= 0.08) + short-liq 60m >= P85/7d
 *   LONG  exit: dOIc spike + (gap-dn >= gapP OR fr-rank >= 0.92) + long-liq  60m >= P85/7d
 *   fr-rank counts ties as half (saturation pins rank high, as they should)
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
const longM = new Map(), shortM = new Map();
{
  const lines = fs.readFileSync('eth_liquidations_v2_2026-07.csv', 'utf8').split('\n');
  const h = lines[0].split(','); const ti = h.indexOf('log_time'), ui = h.indexOf('usd_value'), si = h.indexOf('side');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 7) continue;
    const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]); const side = parseInt(c[si]);
    if (!isFinite(ms) || !isFinite(usd)) continue;
    const k = ms - ms % 60000;
    if (side === 1) longM.set(k, (longM.get(k) || 0) + usd);
    else if (side === 2) shortM.set(k, (shortM.get(k) || 0) + usd);
  }
}
function isWeekend(ms) {
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }
const byMin = new Map(rows.map(r => [r.ms, r]));
function liqSum(map, t, mins) { let s = 0; for (let m = t - (mins - 1) * 60000; m <= t; m += 60000) s += map.get(m) || 0; return s; }

// ---- PART 1: Wednesday probe ----
const out = [];
out.push('=== WEDNESDAY PROBE: Jul 15 04:30-06:00 Qld (bars with |dOIc|>=400 or notable) ===');
{
  const a = Date.parse('2026-07-15T04:30:00+10:00'), b = Date.parse('2026-07-15T06:00:00+10:00');
  for (const r of rows) {
    if (r.ms < a || r.ms > b) continue;
    if (Math.abs(r.dOIc) < 400) continue;
    out.push('  ' + qld(r.ms) + '  dOIc:' + r.dOIc.toFixed(0) + '  fund:' + r.fr +
      '  Lliq60:' + (liqSum(longM, r.ms, 60) / 1e6).toFixed(1) + 'M  Sliq60:' + (liqSum(shortM, r.ms, 60) / 1e6).toFixed(1) + 'M');
  }
  out.push('');
}

// ---- shared machinery ----
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
const msArr = rows.map(r => r.ms), frArr = rows.map(r => r.fr);
const rankAt = new Map(); { let w = 0;
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t % (5 * 60000) !== 0) continue;
    while (msArr[w] < t - 14 * 864e5) w++;
    const n = i - w; if (n < 500) continue;
    let below = 0, ties = 0; const cur = frArr[i];
    for (let j = w; j < i; j++) { if (frArr[j] < cur) below++; else if (frArr[j] === cur) ties++; }
    rankAt.set(t, (below + ties * 0.5) / n);   // ties count half: pins rank high
  }
}
function frRank(t) { const g = t - (t % (5 * 60000)); return rankAt.has(g) ? rankAt.get(g) : null; }
function victimRank(map, t) {   // same-side 60m liq sum vs trailing 7d of 60m sums
  const cur = liqSum(map, t, 60); let below = 0, n = 0;
  for (let m = t - 7 * 864e5; m < t; m += 60 * 60000) { if (liqSum(map, m, 60) < cur) below++; n++; }
  return n ? below / n : 0;
}

// ---- PART 2: the bell, full spec ----
const WINDOWS = [
  { side: 'LONG',  from: Date.parse('2026-07-14T08:00:00+10:00'), to: Date.parse('2026-07-15T07:00:00+10:00'), target: Date.parse('2026-07-15T05:23:00+10:00'), want: true,  label: 'LONG Tue->Wed (ring @Wed05:23)' },
  { side: 'SHORT', from: Date.parse('2026-07-16T17:45:00+10:00'), to: Date.parse('2026-07-17T07:00:00+10:00'), target: Date.parse('2026-07-16T23:52:00+10:00'), want: false, label: 'SHORT Thu->Fri (SILENT @Thu23:52)' },
  { side: 'SHORT', from: Date.parse('2026-07-17T09:21:00+10:00'), to: Date.parse('2026-07-18T07:00:00+10:00'), target: Date.parse('2026-07-17T23:59:00+10:00'), want: true,  label: 'SHORT Fri->Sat (ring @Fri23:59)' }
];
out.push('=== SWEEP 3E: spike + position funding + victim burst ===');
for (const BP of [95, 98]) for (const VP of [80, 85]) {
  out.push('--- bar P' + BP + ' / gap P90 / victim P' + VP + ' ---');
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
      let fund = false, victims = 0;
      if (W.side === 'SHORT') {
        fund = (g > 0 && gm >= 0.90) || (fr !== null && fr <= 0.08);
        victims = victimRank(shortM, r.ms);
      } else {
        fund = (g < 0 && gm >= 0.90) || (fr !== null && fr >= 0.92);
        victims = victimRank(longM, r.ms);
      }
      if (!fund) continue;
      if (victims < VP / 100) continue;
      rings.push(r.ms); last = r.ms;
    }
    const near = rings.find(m => Math.abs(m - W.target) <= 45 * 60000);
    const ok = (!!near) === W.want; if (ok) pass++;
    out.push('  ' + W.label + '  got:' + (near ? 'RING@' + qld(near) : 'no-target-ring') +
      '  rings: ' + rings.length + (rings.length ? '  [' + rings.map(qld).join(' | ') + ']' : '') + '  ' + (ok ? 'PASS' : 'FAIL'));
  }
  out.push('  SCORE ' + pass + '/3');
  out.push('');
}
fs.writeFileSync('sweep3e_results.txt', out.join('\n') + '\n');
console.log('wrote sweep3e_results.txt');
