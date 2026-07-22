/**
 * SWEEP 1B - FUNDING GATE WITH BURN-LATCH
 *
 * Base gate (from Sweep 1 winner): current funding percentile rank vs trailing
 * 14d window; rank >= 95th arms SHORT, <= 5th arms LONG.
 *
 * NEW - the latch: if funding visited the tail within trailing H hours and is
 * now DRAINING toward mid, stay armed IF the drain is a BURN (same-side liqs
 * elevated = the crowd is being executed), disarm if VOLUNTARY (liqs quiet).
 *
 * Auditions: H in {12, 24, 36} hours x smoke threshold in {60, 70, 80} pctile
 * of trailing 7d of 60-min same-side liq sums.
 *
 * Runs on July only (liq stream coverage). Pass condition:
 *   Jul13 SHORT (the fix), Jul14 LONG, Jul15 NONE (must not regress),
 *   Jul16 SHORT, Jul17 SHORT.
 *
 * Output: sweep1b_results.txt
 * Run: node sweep1b-burn-latch.js   (from ~/predator-hunt)
 */

const fs = require('fs');

const PCT = 95, LOOKBACK_D = 14;
const LATCH_HOURS = [12, 24, 36];
const SMOKE_PCTS = [60, 70, 80];
const STEP_MS = 5 * 60 * 1000;

const GRADED = {
  '2026-07-13': 'SHORT', '2026-07-14': 'LONG', '2026-07-15': 'NONE',
  '2026-07-16': 'SHORT', '2026-07-17': 'SHORT'
};

function loadFunding() {
  const pts = new Map();
  for (const f of ['eth_pillars_v2_2026-06.csv']) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(','); const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_rate');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 6) continue;
      const ms = Date.parse(c[ti]), fr = parseFloat(c[fi]);
      if (isFinite(ms) && isFinite(fr)) pts.set(ms - ms % 60000, fr); }
  }
  for (const f of ['eth_pillars_v3_2026-06.csv', 'eth_pillars_v3_2026-07.csv']) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(','); const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_close');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 9) continue;
      const ms = Date.parse(c[ti]), fr = parseFloat(c[fi]);
      if (isFinite(ms) && isFinite(fr)) pts.set(ms - ms % 60000, fr); }
  }
  return [...pts.entries()].sort((a, b) => a[0] - b[0]);
}

function loadLiqs() {
  // per-minute same-side liq USD sums: side 1 = LONG liquidated, side 2 = SHORT liquidated
  const longM = new Map(), shortM = new Map();
  for (const f of ['eth_liquidations_v2_2026-06.csv', 'eth_liquidations_v2_2026-07.csv']) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(','); const ti = hdr.indexOf('log_time'), ui = hdr.indexOf('usd_value'), si = hdr.indexOf('side');
    for (let i = 1; i < lines.length; i++) { const c = lines[i].split(','); if (c.length < 7) continue;
      const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]); const side = parseInt(c[si]);
      if (!isFinite(ms) || !isFinite(usd)) continue;
      const key = ms - ms % 60000;
      if (side === 1) longM.set(key, (longM.get(key) || 0) + usd);
      else if (side === 2) shortM.set(key, (shortM.get(key) || 0) + usd);
    }
  }
  return { longM, shortM };
}

function qldDay(ms) { return new Date(ms + 36e6).toISOString().slice(0, 10); }

(function main() {
  const series = loadFunding();
  const { longM, shortM } = loadLiqs();
  const msArr = series.map(p => p[0]), frArr = series.map(p => p[1]);
  const ms0 = msArr[0];
  const win = LOOKBACK_D * 864e5;

  // Precompute per-step: rank, and rolling 60-min liq sums per side
  function liqSum60(map, t) { let s = 0; for (let m = t - 59 * 60000; m <= t; m += 60000) s += map.get(m) || 0; return s; }

  // trailing-7d distribution of 60-min sums, sampled every 30 min, for smoke percentile
  function smokeRank(map, t) {
    const cur = liqSum60(map, t);
    let below = 0, n = 0;
    for (let m = t - 7 * 864e5; m < t; m += 30 * 60000) { const v = liqSum60(map, m); n++; if (v < cur) below++; }
    return n ? below / n : 0;
  }

  const out = [];
  out.push('SWEEP 1B - BURN LATCH  (base P' + PCT + '/' + LOOKBACK_D + 'd)  ' + new Date().toISOString());
  out.push('');

  // Precompute base ranks on the 5-min grid (July + late June warmup)
  const grid = [];
  let wStart = 0;
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t - ms0 < win) continue;
    if (t % STEP_MS !== 0) continue;
    while (msArr[wStart] < t - win) wStart++;
    const n = i - wStart; if (n < 500) continue;
    let below = 0; const cur = frArr[i];
    for (let j = wStart; j < i; j++) if (frArr[j] < cur) below++;
    grid.push({ t, fr: cur, rank: below / n });
  }
  console.log('grid: ' + grid.length + ' steps');

  for (const H of LATCH_HOURS) {
    for (const SP of SMOKE_PCTS) {
      const armedDays = new Map();
      const latchWin = H * 3600e3;
      for (let g = 0; g < grid.length; g++) {
        const { t, fr, rank } = grid[g];
        if (!qldDay(t).startsWith('2026-07')) continue;
        let state = 'NONE';
        if (rank >= PCT / 100) state = 'SHORT';
        else if (rank <= 1 - PCT / 100) state = 'LONG';
        else {
          // latch check: did rank visit a tail within trailing H hours?
          let sawHi = false, sawLo = false, hiFr = 0, loFr = 0;
          for (let k = g - 1; k >= 0 && grid[k].t >= t - latchWin; k--) {
            if (grid[k].rank >= PCT / 100) { sawHi = true; hiFr = Math.max(hiFr, grid[k].fr); }
            if (grid[k].rank <= 1 - PCT / 100) { sawLo = true; loFr = Math.min(loFr, grid[k].fr); }
          }
          // draining = current level between the visited extreme and mid, same sign side
          if (sawHi && fr < hiFr && fr > 0) {
            // burn check: LONGS being executed (side 1) elevated?
            if (smokeRank(longM, t) >= SP / 100) state = 'SHORT';
          } else if (sawLo && fr > loFr && fr < 0) {
            if (smokeRank(shortM, t) >= SP / 100) state = 'LONG';
          }
        }
        if (state !== 'NONE') {
          const d = qldDay(t);
          if (!armedDays.has(d)) armedDays.set(d, { S: 0, L: 0 });
          armedDays.get(d)[state === 'SHORT' ? 'S' : 'L'] += 5;
        }
      }

      out.push('=== latch ' + H + 'h / smoke P' + SP + ' ===');
      let passes = 0;
      for (const [day, want] of Object.entries(GRADED)) {
        const a = armedDays.get(day) || { S: 0, L: 0 };
        const got = a.S >= 60 && a.S > a.L ? 'SHORT' : a.L >= 60 && a.L > a.S ? 'LONG' : 'NONE';
        const ok = got === want; if (ok) passes++;
        out.push('  ' + day + ' want:' + want + ' got:' + got + ' (S:' + a.S + 'm L:' + a.L + 'm) ' + (ok ? 'PASS' : 'FAIL'));
      }
      out.push('  SCORE ' + passes + '/5');
      const julDays = [...armedDays.entries()].filter(([d, v]) => v.S >= 60 || v.L >= 60)
        .map(([d, v]) => d.slice(8) + (v.S > v.L ? 'S' : 'L'));
      out.push('  July armed days: ' + julDays.join(' '));
      out.push('');
    }
  }

  fs.writeFileSync('sweep1b_results.txt', out.join('\n') + '\n');
  console.log('wrote sweep1b_results.txt');
})();
