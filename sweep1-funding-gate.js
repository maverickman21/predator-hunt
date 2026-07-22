/**
 * SWEEP 1 - FUNDING GATE AUDITION (one-off research script)
 *
 * Loads the full banked funding series (eth_pillars_v2 Apr-Jun + v3 Jun-Jul),
 * then for each candidate (percentile P x lookback L days) computes, per 5-min step,
 * whether funding sits in the top tail (long-crowded -> SHORT armed) or bottom
 * tail (short-crowded -> LONG armed) of its own trailing distribution.
 *
 * Output: sweep1_results.txt
 *   - per candidate: % time armed each side, armed calendar days (Qld) in July
 *   - scorecard vs the graded week: Jul13 S, Jul14 L, Jul16 S, Jul17 S armed? Jul15 quiet?
 *
 * Run: node sweep1-funding-gate.js   (from ~/predator-hunt)
 */

const fs = require('fs');
const path = require('path');

const V2_FILES = ['eth_pillars_v2_2026-04.csv', 'eth_pillars_v2_2026-05.csv', 'eth_pillars_v2_2026-06.csv'];
const V3_FILES = ['eth_pillars_v3_2026-06.csv', 'eth_pillars_v3_2026-07.csv'];

const PERCENTILES = [80, 85, 90, 95];
const LOOKBACK_DAYS = [7, 14, 30];
const STEP_MS = 5 * 60 * 1000;              // evaluate on a 5-min grid

// Graded week (Qld dates): expected gate state
const GRADED = {
  '2026-07-13': 'SHORT', // Mon seed planter
  '2026-07-14': 'LONG',  // Tue 9:50 long
  '2026-07-15': 'NONE',  // Wed sit-out (should NOT arm at entry hours)
  '2026-07-16': 'SHORT', // Thu seed planter
  '2026-07-17': 'SHORT'  // Fri 9:21 seed planter
};

function loadSeries() {
  const pts = new Map(); // ms -> funding
  for (const f of V2_FILES) {
    if (!fs.existsSync(f)) { console.log('skip missing ' + f); continue; }
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_rate');
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 6) continue;
      const ms = Date.parse(c[ti]); const fr = parseFloat(c[fi]);
      if (isFinite(ms) && isFinite(fr)) pts.set(ms - (ms % 60000), fr);
    }
    console.log('loaded ' + f);
  }
  for (const f of V3_FILES) {
    if (!fs.existsSync(f)) { console.log('skip missing ' + f); continue; }
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('timestamp'), fi = hdr.indexOf('funding_close');
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      if (c.length < 9) continue;
      const ms = Date.parse(c[ti]); const fr = parseFloat(c[fi]);
      if (isFinite(ms) && isFinite(fr)) pts.set(ms - (ms % 60000), fr); // v3 wins on overlap
    }
    console.log('loaded ' + f);
  }
  const arr = [...pts.entries()].sort((a, b) => a[0] - b[0]);
  console.log('series: ' + arr.length + ' minute-points, ' +
    new Date(arr[0][0]).toISOString().slice(0, 10) + ' -> ' +
    new Date(arr[arr.length - 1][0]).toISOString().slice(0, 10));
  return arr;
}

function qldDay(ms) {
  return new Date(ms + 10 * 3600 * 1000).toISOString().slice(0, 10);
}
function qldHour(ms) {
  return new Date(ms + 10 * 3600 * 1000).getUTCHours();
}

(function main() {
  const series = loadSeries();               // [[ms, funding], ...] minute grid
  const ms0 = series[0][0], msN = series[series.length - 1][0];
  const out = [];
  out.push('SWEEP 1 - FUNDING GATE  (' + new Date().toISOString() + ')');
  out.push('series ' + new Date(ms0).toISOString().slice(0, 10) + ' -> ' + new Date(msN).toISOString().slice(0, 10) + ', ' + series.length + ' pts');
  out.push('');

  // index minute-points for windowed scans
  const msArr = series.map(p => p[0]);
  const frArr = series.map(p => p[1]);

  for (const L of LOOKBACK_DAYS) {
    const win = L * 24 * 3600 * 1000;
    for (const P of PERCENTILES) {
      const lo = (100 - P) / 100, hi = P / 100;
      let armedShortMin = 0, armedLongMin = 0, totalMin = 0;
      const armedDays = new Map(); // qldDay -> {S:mins, L:mins}
      let wStart = 0;

      for (let i = 0; i < msArr.length; i++) {
        const t = msArr[i];
        if (t - ms0 < win) continue;                    // need a full lookback
        if (t % STEP_MS !== 0) continue;                // 5-min grid
        while (msArr[wStart] < t - win) wStart++;
        const n = i - wStart;
        if (n < 500) continue;                          // sparse window guard
        // percentile rank of current value in trailing window
        let below = 0;
        const cur = frArr[i];
        for (let j = wStart; j < i; j++) if (frArr[j] < cur) below++;
        const rank = below / n;
        totalMin += 5;
        const d = qldDay(t);
        if (!armedDays.has(d)) armedDays.set(d, { S: 0, L: 0 });
        if (rank >= hi) { armedShortMin += 5; armedDays.get(d).S += 5; }
        else if (rank <= lo) { armedLongMin += 5; armedDays.get(d).L += 5; }
      }

      out.push('=== P' + P + ' / lookback ' + L + 'd ===');
      out.push('  armed SHORT ' + (100 * armedShortMin / totalMin).toFixed(1) + '% of time, LONG ' + (100 * armedLongMin / totalMin).toFixed(1) + '%');

      // graded-week scorecard: armed (>=60 min that day, entry hours 08-13 Qld weighted by full day here)
      const score = [];
      for (const [day, want] of Object.entries(GRADED)) {
        const a = armedDays.get(day) || { S: 0, L: 0 };
        const got = a.S >= 60 && a.S > a.L ? 'SHORT' : a.L >= 60 && a.L > a.S ? 'LONG' : 'NONE';
        const ok = got === want ? 'PASS' : 'FAIL';
        score.push('  ' + day + ' want:' + want + ' got:' + got + ' (S:' + a.S + 'm L:' + a.L + 'm) ' + ok);
      }
      out.push(...score);

      // July armed-day list (compact)
      const julDays = [...armedDays.entries()].filter(([d, v]) => d.startsWith('2026-07') && (v.S >= 60 || v.L >= 60))
        .map(([d, v]) => d.slice(8) + (v.S > v.L ? 'S' : 'L'));
      out.push('  July armed days: ' + julDays.join(' '));
      out.push('');
    }
  }

  fs.writeFileSync('sweep1_results.txt', out.join('\n') + '\n');
  console.log('wrote sweep1_results.txt (' + out.length + ' lines)');
})();
