/**
 * SWEEP 3B - HARVEST BELL, PEAK-BAR AUTHORED
 *
 * Ratified spec: bell = AUTHORED DESTRUCTION (informed money dismantling)
 * + a FUNDING DISCONTINUITY (gap) or funding at a relative extreme.
 * Closing is always destruction, so the bell is side-agnostic; the position's
 * side decides whether it is an exit or just a stamp.
 *
 * Bell candidate at minute t (episode = trailing 15m sums):
 *   1. dOI-contracts sum < 0                     (the book is being dismantled)
 *   2. authored: |dOI-USD| / (liq$ + |delta$|) >= F     (voluntary >> forced/aggressive)
 *   3. magnitude: |dOI| ranks >= P90 vs 90m AND >= P60 vs 24h  (same dual windows as trigger)
 *   4. funding: |30-min funding change| ranks >= G of trailing 7d changes  (the GAP)
 *              OR funding rank >= 0.92 / <= 0.08 of trailing 14d           (the EXTREME)
 *
 * Graded against:
 *   MUST RING : Jul 14 05:23 Qld (Tue $600M cleanout exit)   +/-30 min
 *   MUST RING : Jul 17 23:59 Qld (Fri terminal flush exit)   +/-30 min
 *   MUST NOT  : Jul 16 23:52 Qld (Thu shakeout V - hold!)    +/-30 min
 *
 * Auditions: F {1.0, 1.5} x G {90, 95}
 * Output: sweep3b_results.txt
 */
const fs = require('fs');

function loadPillars() {
  const rows = [];
  const f = 'eth_pillars_v3_2026-07.csv';
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const h = lines[0].split(',');
  const ti = h.indexOf('timestamp'), fo = h.indexOf('funding_close');
  const oco = h.indexOf('oi_coin_open'), occ = h.indexOf('oi_coin_close');
  const ouo = h.indexOf('oi_open'), ouc = h.indexOf('oi_close');
  const cd = h.indexOf('cvd_delta');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 16) continue;
    const ms = Date.parse(c[ti]); if (!isFinite(ms)) continue;
    const fr = parseFloat(c[fo]);
    let dOIc = NaN, dOIu = NaN;
    if (oco >= 0 && c.length > occ) {
      const o = parseFloat(c[oco]), cl = parseFloat(c[occ]);
      if (isFinite(o) && isFinite(cl) && (o !== 0 || cl !== 0)) dOIc = cl - o;
    }
    const uo = parseFloat(c[ouo]), uc = parseFloat(c[ouc]);
    if (isFinite(uo) && isFinite(uc)) dOIu = uc - uo;
    if (!isFinite(dOIc)) dOIc = 0;
    if (!isFinite(dOIu)) dOIu = 0;
    const delta = parseFloat(c[cd]);
    rows.push({ ms: ms - ms % 60000, fr, dOIc, dOIu, delta: isFinite(delta) ? delta : 0 });
  }
  rows.sort((a, b) => a.ms - b.ms);
  return rows;
}
function loadLiqs() {
  const m = new Map();
  const f = 'eth_liquidations_v2_2026-07.csv';
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const h = lines[0].split(','); const ti = h.indexOf('log_time'), ui = h.indexOf('usd_value');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 7) continue;
    const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]);
    if (!isFinite(ms) || !isFinite(usd)) continue;
    const k = ms - ms % 60000;
    m.set(k, (m.get(k) || 0) + usd);
  }
  return m;
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }
function isWeekend(ms) {
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}

(function main() {
  const pillars = loadPillars();
  const liqM = loadLiqs();
  const byMin = new Map(pillars.map(p => [p.ms, p]));
  const msArr = pillars.map(p => p.ms), frArr = pillars.map(p => p.fr);
  const frAt = new Map(pillars.map(p => [p.ms, p.fr]));
  console.log('pillars: ' + pillars.length);

  function ep(t) {  // trailing 15m sums + peak-bar authored ratio
    let dOIc = 0, dOIu = 0, delta = 0, liq = 0, peak = 0;
    for (let m = t - 14 * 60000; m <= t; m += 60000) {
      const p = byMin.get(m);
      const l = liqM.get(m) || 0;
      if (p) {
        dOIc += p.dOIc; dOIu += p.dOIu; delta += p.delta;
        if (p.dOIc < 0) {                      // destruction bars only
          const r = Math.abs(p.dOIu) / (l + Math.abs(p.delta) + 1);
          if (r > peak) peak = r;
        }
      }
      liq += l;
    }
    return { dOIc, dOIu, delta, liq, peak };
  }
  function frNear(t) {
    for (let m = t; m >= t - 10 * 60000; m -= 60000) { if (frAt.has(m)) return frAt.get(m); }
    return null;
  }
  function fundGap30(t) {
    const a = frNear(t), b = frNear(t - 30 * 60000);
    return (a !== null && b !== null) ? Math.abs(a - b) : 0;
  }

  // trailing-14d funding rank on 5-min grid (for the extreme clause)
  const win = 14 * 864e5;
  const rankAt = new Map(); let wStart = 0;
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t % (5 * 60000) !== 0) continue;
    while (msArr[wStart] < t - win) wStart++;
    const n = i - wStart; if (n < 500) continue;
    let below = 0; const cur = frArr[i];
    for (let j = wStart; j < i; j++) if (frArr[j] < cur) below++;
    rankAt.set(t, below / n);
  }
  function frRank(t) { const g = t - (t % (5 * 60000)); return rankAt.has(g) ? rankAt.get(g) : null; }

  function magRank(t, mins) {
    const cur = Math.abs(ep(t).dOIc);
    let below = 0, n = 0, m = t;
    const target = Math.floor(mins / 5);
    let guard = 0;
    while (n < target && guard++ < 4000) {
      m -= 5 * 60000;
      if (isWeekend(m)) continue;
      if (Math.abs(ep(m).dOIc) < cur) below++;
      n++;
    }
    return n ? below / n : 0;
  }
  function gapRank(t) {
    const cur = fundGap30(t);
    let below = 0, n = 0;
    for (let m = t - 7 * 864e5; m < t; m += 30 * 60000) { if (fundGap30(m) < cur) below++; n++; }
    return n ? below / n : 0;
  }

  const TARGETS = [
    { label: 'Tue 05:23 exit', ms: Date.parse('2026-07-14T05:23:00+10:00'), want: true },
    { label: 'Fri 23:59 exit', ms: Date.parse('2026-07-17T23:59:00+10:00'), want: true },
    { label: 'Thu 23:52 SHAKEOUT', ms: Date.parse('2026-07-16T23:52:00+10:00'), want: false }
  ];
  const start = Date.parse('2026-07-06T00:00:00Z');

  const out = [];
  out.push('SWEEP 3B - PEAK-BAR BELL  ' + new Date().toISOString());
  out.push('');

  for (const F of [1.0, 1.5]) for (const G of [90, 95]) {
    const rings = [];
    let last = 0;
    for (const t of msArr) {
      if (t < start) continue;
      if (t - last < 30 * 60000) continue;   // 30-min ring refractory
      const e = ep(t);
      if (e.dOIc >= 0) continue;                                   // 1: destruction
      if (e.peak < F) continue;                                    // 2: authored (peak bar)
      if (magRank(t, 90) < 0.90 || magRank(t, 1440) < 0.60) continue;  // 3: magnitude
      const r = frRank(t);
      const gapped = gapRank(t) >= G / 100;
      const extreme = r !== null && (r >= 0.92 || r <= 0.08);
      if (!gapped && !extreme) continue;                           // 4: funding
      rings.push({ ms: t, gapped, extreme });
      last = t;
    }
    out.push('=== authored F>=' + F + ' / gap P' + G + ' ===');
    let pass = 0;
    for (const tg of TARGETS) {
      const near = rings.find(r => Math.abs(r.ms - tg.ms) <= 30 * 60000);
      const rang = !!near;
      const ok = rang === tg.want; if (ok) pass++;
      out.push('  ' + tg.label + '  want:' + (tg.want ? 'RING' : 'SILENT') +
        '  got:' + (rang ? 'RING@' + qld(near.ms) + (near.gapped ? ' [gap]' : '') + (near.extreme ? ' [extreme]' : '') : 'silent') +
        '  ' + (ok ? 'PASS' : 'FAIL'));
    }
    out.push('  SCORE ' + pass + '/3   total rings: ' + rings.length);
    out.push('  all rings: ' + rings.map(r => qld(r.ms)).join(' | '));
    out.push('');
  }
  fs.writeFileSync('sweep3b_results.txt', out.join('\n') + '\n');
  console.log('wrote sweep3b_results.txt');
})();
