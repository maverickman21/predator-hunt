/**
 * SWEEP 2B - TRIGGER, OUTCOME-GRADED
 *
 * Changes from Sweep 2:
 *  1. ONE-SHOT PER ARMED RUN: first qualified fire in each contiguous armed
 *     run is THE entry; later fires in the same run are logged as 'add'.
 *     A run resets when the gate disarms for >60 min or flips side.
 *  2. OUTCOME GRADING (no human timestamps): for each entry, from fire price:
 *       MFE = max favorable ETH move before exit horizon
 *       MAE = max adverse move BEFORE the MFE extreme
 *       exit horizon = gate disarm+60m, opposite-side fire, or +12h, whichever first
 *     WIN = MFE >= 1.0% with MAE <= 0.75% first. Also reports raw numbers.
 *  3. Full fire list with Qld timestamps + entry price + MFE/MAE per fire.
 *
 * Trigger fixed at the sweep-2 modal spec: ep15m, thumb P90/90m, floor P60/360m
 * (strictest clean variant) AND ep10m thumb P85/60m floor P50/240m (loosest)
 * for comparison - 2 variants only, full detail each.
 *
 * Output: sweep2b_results.txt
 */
const fs = require('fs');

function loadPillars() {
  const rows = [];
  const f = 'eth_pillars_v3_2026-07.csv';
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const h = lines[0].split(',');
  const ti = h.indexOf('timestamp'), fo = h.indexOf('funding_close');
  const pi = h.indexOf('eth_price');
  const oco = h.indexOf('oi_coin_open'), occ = h.indexOf('oi_coin_close');
  const ouo = h.indexOf('oi_open'), ouc = h.indexOf('oi_close');
  const cd = h.indexOf('cvd_delta');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 16) continue;
    const ms = Date.parse(c[ti]); if (!isFinite(ms)) continue;
    const fr = parseFloat(c[fo]); const px = parseFloat(c[pi]);
    let dOI = NaN;
    if (oco >= 0 && c.length > occ) {
      const o = parseFloat(c[oco]), cl = parseFloat(c[occ]);
      if (isFinite(o) && isFinite(cl) && (o !== 0 || cl !== 0)) dOI = cl - o;
    }
    if (!isFinite(dOI)) {
      const o = parseFloat(c[ouo]), cl = parseFloat(c[ouc]);
      if (isFinite(o) && isFinite(cl)) dOI = cl - o;
    }
    const delta = parseFloat(c[cd]);
    rows.push({ ms: ms - ms % 60000, fr, px: isFinite(px) ? px : null, dOI: isFinite(dOI) ? dOI : 0, delta: isFinite(delta) ? delta : 0 });
  }
  rows.sort((a, b) => a.ms - b.ms);
  return rows;
}
function loadLiqs() {
  const longM = new Map(), shortM = new Map();
  const f = 'eth_liquidations_v2_2026-07.csv';
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const h = lines[0].split(','); const ti = h.indexOf('log_time'), ui = h.indexOf('usd_value'), si = h.indexOf('side');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 7) continue;
    const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]); const side = parseInt(c[si]);
    if (!isFinite(ms) || !isFinite(usd)) continue;
    const k = ms - ms % 60000;
    if (side === 1) longM.set(k, (longM.get(k) || 0) + usd);
    else if (side === 2) shortM.set(k, (shortM.get(k) || 0) + usd);
  }
  return { longM, shortM };
}
function isWeekend(ms) {
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }

(function main() {
  const pillars = loadPillars();
  const { longM, shortM } = loadLiqs();
  const byMin = new Map(pillars.map(p => [p.ms, p]));
  const msArr = pillars.map(p => p.ms), frArr = pillars.map(p => p.fr);
  console.log('pillars: ' + pillars.length);

  function liqSum(map, t, mins) { let s = 0; for (let m = t - (mins - 1) * 60000; m <= t; m += 60000) s += map.get(m) || 0; return s; }
  function smokeRank3h(map, t) {
    const cur = liqSum(map, t, 180); let below = 0, n = 0;
    for (let m = t - 7 * 864e5; m < t; m += 3600e3) { if (liqSum(map, m, 180) < cur) below++; n++; }
    return n ? below / n : 0;
  }

  // ---- gate (ratified) on 5-min grid ----
  const win = 14 * 864e5;
  const grid = []; let wStart = 0;
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t % (5 * 60000) !== 0) continue;
    while (msArr[wStart] < t - win) wStart++;
    const n = i - wStart; if (n < 500) continue;
    let below = 0; const cur = frArr[i];
    for (let j = wStart; j < i; j++) if (frArr[j] < cur) below++;
    grid.push({ t, fr: cur, rank: below / n });
  }
  const gate = new Map();
  for (let g = 0; g < grid.length; g++) {
    const { t, fr, rank } = grid[g];
    let s = null;
    if (rank >= 0.95 && fr > 0) s = 'SHORT';
    else if (rank <= 0.05 && fr < 0) s = 'LONG';
    else {
      let sawHi = false, sawLo = false, hiFr = 0, loFr = 0, budget = 24 * 3600e3;
      for (let k = g - 1; k >= 0 && budget > 0; k--) {
        const dt = grid[k + 1].t - grid[k].t;
        if (!isWeekend(grid[k].t)) budget -= dt;
        if (grid[k].rank >= 0.92 && grid[k].fr > 0) { sawHi = true; hiFr = Math.max(hiFr, grid[k].fr); }
        if (grid[k].rank <= 0.08 && grid[k].fr < 0) { sawLo = true; loFr = Math.min(loFr, grid[k].fr); }
      }
      let fr2h = null;
      for (let k = g - 1; k >= 0; k--) { if (t - grid[k].t >= 2 * 3600e3) { fr2h = grid[k].fr; break; } }
      const falling = fr2h !== null && fr < fr2h, rising = fr2h !== null && fr > fr2h;
      if (sawHi && fr > 0 && fr < hiFr && falling && smokeRank3h(longM, t) >= 0.80) s = 'SHORT';
      else if (sawLo && fr < 0 && fr > loFr && rising && smokeRank3h(shortM, t) >= 0.80) s = 'LONG';
    }
    if (s) for (let m = t; m < t + 5 * 60000; m += 60000) gate.set(m, s);
  }
  console.log('gate minutes: ' + gate.size);

  function epSums(t, epMin) {
    let dOI = 0, delta = 0, lliq = 0, sliq = 0;
    for (let m = t - (epMin - 1) * 60000; m <= t; m += 60000) {
      const p = byMin.get(m);
      if (p) { dOI += p.dOI; delta += p.delta; }
      lliq += longM.get(m) || 0; sliq += shortM.get(m) || 0;
    }
    return { dOI, delta, lliq, sliq };
  }
  function priceAt(t) {
    for (let m = t; m <= t + 5 * 60000; m += 60000) { const p = byMin.get(m); if (p && p.px) return p.px; }
    return null;
  }

  const VARIANTS = [
    { name: 'strict ep15/P90-90m/P60-360m', ep: 15, st: 90, sw: 90, fl: 60, lw: 360 },
    { name: 'loose  ep10/P85-60m/P50-240m', ep: 10, st: 85, sw: 60, fl: 50, lw: 240 }
  ];

  const out = [];
  out.push('SWEEP 2B - OUTCOME-GRADED TRIGGER  ' + new Date().toISOString());
  out.push('');

  const start = Date.parse('2026-07-06T00:00:00Z');
  for (const V of VARIANTS) {
    function magRank(t, mins) {
      const cur = Math.abs(epSums(t, V.ep).dOI);
      let below = 0, n = 0;
      for (let m = t - mins * 60000; m < t; m += 5 * 60000) { if (Math.abs(epSums(m, V.ep).dOI) < cur) below++; n++; }
      return n ? below / n : 0;
    }
    // walk minutes, detect armed runs, fire one-shot + adds
    const entries = []; const adds = [];
    let runDir = null, runFired = false, disarmSince = null;
    for (const t of msArr) {
      if (t < start) continue;
      const dir = gate.get(t) || null;
      if (dir === null) {
        if (disarmSince === null) disarmSince = t;
        if (runDir && t - disarmSince > 60 * 60000) { runDir = null; runFired = false; }
        continue;
      }
      disarmSince = null;
      if (dir !== runDir) { runDir = dir; runFired = false; }
      const e = epSums(t, V.ep);
      let vote = false;
      if (dir === 'SHORT') vote = e.dOI < 0 && e.delta < 0 && e.lliq > e.sliq;
      else vote = e.dOI > 0 && e.delta > 0 && e.sliq > e.lliq;
      if (!vote) continue;
      if (magRank(t, V.sw) >= V.st / 100 && magRank(t, V.lw) >= V.fl / 100) {
        if (!runFired) { entries.push({ ms: t, dir }); runFired = true; }
        else if (entries.length && t - entries[entries.length - 1].ms > 30 * 60000) adds.push({ ms: t, dir });
      }
    }

    // outcome grade each entry
    out.push('=== ' + V.name + ' ===');
    let wins = 0;
    for (const en of entries) {
      const p0 = priceAt(en.ms); if (!p0) { out.push('  ' + qld(en.ms) + ' ' + en.dir + '  (no price)'); continue; }
      // exit horizon
      let horizon = en.ms + 12 * 3600e3;
      let lastArmed = en.ms;
      for (let m = en.ms; m <= en.ms + 12 * 3600e3; m += 60000) {
        const g = gate.get(m);
        if (g === en.dir) lastArmed = m;
        if (g && g !== en.dir) { horizon = m; break; }
        if (m - lastArmed > 60 * 60000) { horizon = m; break; }
      }
      let mfe = 0, maeBeforeMfe = 0, worstSoFar = 0, mfeAt = en.ms;
      for (let m = en.ms; m <= horizon; m += 60000) {
        const p = byMin.get(m); if (!p || !p.px) continue;
        const fav = en.dir === 'SHORT' ? (p0 - p.px) / p0 : (p.px - p0) / p0;
        const adv = -fav;
        if (adv > worstSoFar) worstSoFar = adv;
        if (fav > mfe) { mfe = fav; mfeAt = m; maeBeforeMfe = worstSoFar; }
      }
      const win = mfe >= 0.01 && maeBeforeMfe <= 0.0075;
      if (win) wins++;
      out.push('  ' + qld(en.ms) + ' ' + en.dir + ' @' + p0.toFixed(1) +
        '  MFE ' + (100 * mfe).toFixed(2) + '% @' + qld(mfeAt).slice(6) +
        '  MAE-first ' + (100 * maeBeforeMfe).toFixed(2) + '%  ' + (win ? 'WIN' : 'no'));
    }
    out.push('  entries: ' + entries.length + '  wins(>=1% MFE, <=0.75% MAE-first): ' + wins +
      '  adds logged: ' + adds.length);
    out.push('');
  }
  fs.writeFileSync('sweep2b_results.txt', out.join('\n') + '\n');
  console.log('wrote sweep2b_results.txt');
})();
