/**
 * SWEEP 2 - THE TRIGGER (three-sign vote + dual-window percentile)
 *
 * Runs ONLY inside gate-armed periods (ratified gate: P95/14d + sign guard +
 * latch mem92/24 NQ-hours/smoke3h P80), July 6 onward (full pillar data).
 *
 * Trigger candidate fires when, over a rolling EPISODE window:
 *   1. VOTE: sum(dOI contracts) sign + sum(CVD delta) sign + sum(liq net) sign
 *      all agree with the armed direction:
 *        SHORT armed: dOI < 0, delta < 0, long-liqs dominate
 *        LONG armed:  dOI > 0, delta > 0, short-liqs dominate
 *   2. SORE THUMB: episode |dOI| magnitude >= Pshort of trailing SHORTWIN sums
 *   3. FLOOR: episode |dOI| >= Pfloor of trailing LONGWIN sums
 *
 * Auditions: episode {10,15}min x sorethumb {85,90} x shortwin {60,90}min
 *            x floor {50,60} x longwin {240,360}min  -> pruned to 16 combos
 *
 * Targets (first fire within +/-20min counts as HIT):
 *   Jul13 10:41 S, Jul14 09:50 L, Jul16 09:44 S, Jul17 09:21 S  (Qld)
 * Controls: fires during Jul06 11:00-16:00 Qld (midday long grind inside
 *   armed-short day) = BAD; total fire count per armed day reported.
 *
 * Output: sweep2_results.txt
 */
const fs = require('fs');

// ---- load pillars v3 (minute OI contracts + CVD delta) ----
function loadPillars() {
  const rows = [];
  for (const f of ['eth_pillars_v3_2026-07.csv']) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const h = lines[0].split(',');
    const ti = h.indexOf('timestamp'), fo = h.indexOf('funding_close');
    const oc = h.indexOf('oi_coin_open'), occ = h.indexOf('oi_coin_close');
    const cd = h.indexOf('cvd_delta');
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(','); if (c.length < 16) continue;
      const ms = Date.parse(c[ti]); if (!isFinite(ms)) continue;
      const fr = parseFloat(c[fo]);
      // coin-denominated OI preferred (contracts truth); fall back to usd oi if absent
      let dOI = NaN;
      if (oc >= 0 && occ >= 0 && c.length > occ) {
        const o = parseFloat(c[oc]), cl = parseFloat(c[occ]);
        if (isFinite(o) && isFinite(cl)) dOI = cl - o;
      }
      if (!isFinite(dOI)) {
        const o = parseFloat(c[h.indexOf('oi_open')]), cl = parseFloat(c[h.indexOf('oi_close')]);
        if (isFinite(o) && isFinite(cl)) dOI = cl - o;
      }
      const delta = parseFloat(c[cd]);
      rows.push({ ms: ms - ms % 60000, fr, dOI: isFinite(dOI) ? dOI : 0, delta: isFinite(delta) ? delta : 0 });
    }
  }
  rows.sort((a, b) => a.ms - b.ms);
  return rows;
}
function loadLiqs() {
  const longM = new Map(), shortM = new Map();
  for (const f of ['eth_liquidations_v2_2026-07.csv']) {
    if (!fs.existsSync(f)) continue;
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
  }
  return { longM, shortM };
}

// ---- ratified gate, replayed (simplified from sweep1d winner) ----
function buildGate(pillars, longM, shortM) {
  // funding series from pillars rows themselves
  const frArr = pillars.map(p => p.fr), msArr = pillars.map(p => p.ms);
  const win = 14 * 864e5;
  function isWeekend(ms) {
    const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
    return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
  }
  function liqSum(map, t, mins) { let s = 0; for (let m = t - (mins - 1) * 60000; m <= t; m += 60000) s += map.get(m) || 0; return s; }
  function smokeRank3h(map, t) {
    const cur = liqSum(map, t, 180); let below = 0, n = 0;
    for (let m = t - 7 * 864e5; m < t; m += 3600e3) { if (liqSum(map, m, 180) < cur) below++; n++; }
    return n ? below / n : 0;
  }
  const state = new Map(); // minute -> 'SHORT'|'LONG'
  let wStart = 0;
  const grid = [];
  for (let i = 0; i < msArr.length; i++) {
    const t = msArr[i];
    if (t % (5 * 60000) !== 0) continue;
    while (msArr[wStart] < t - win) wStart++;
    const n = i - wStart; if (n < 500) continue;
    let below = 0; const cur = frArr[i];
    for (let j = wStart; j < i; j++) if (frArr[j] < cur) below++;
    grid.push({ t, fr: cur, rank: below / n, gi: grid.length });
  }
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
      // slope via grid 2h back
      let fr2h = null;
      for (let k = g - 1; k >= 0; k--) { if (t - grid[k].t >= 2 * 3600e3) { fr2h = grid[k].fr; break; } }
      const falling = fr2h !== null && fr < fr2h, rising = fr2h !== null && fr > fr2h;
      if (sawHi && fr > 0 && fr < hiFr && falling && smokeRank3h(longM, t) >= 0.80) s = 'SHORT';
      else if (sawLo && fr < 0 && fr > loFr && rising && smokeRank3h(shortM, t) >= 0.80) s = 'LONG';
    }
    if (s) for (let m = t; m < t + 5 * 60000; m += 60000) state.set(m, s);
  }
  return state;
}

function qld(ms) { const d = new Date(ms + 36e6); return d.toISOString().slice(0, 16).replace('T', ' '); }
function qldDay(ms) { return new Date(ms + 36e6).toISOString().slice(0, 10); }

(function main() {
  const pillars = loadPillars();
  const { longM, shortM } = loadLiqs();
  console.log('pillars: ' + pillars.length + ' rows');
  const gate = buildGate(pillars, longM, shortM);
  console.log('gate armed minutes: ' + gate.size);

  // index pillar rows by minute
  const byMin = new Map(pillars.map(p => [p.ms, p]));
  const minutes = pillars.map(p => p.ms).filter(m => m >= Date.parse('2026-07-06T00:00:00Z'));

  const TARGETS = [
    { day: '2026-07-13', qldHM: '10:41', dir: 'SHORT' },
    { day: '2026-07-14', qldHM: '09:50', dir: 'LONG' },
    { day: '2026-07-16', qldHM: '09:44', dir: 'SHORT' },
    { day: '2026-07-17', qldHM: '09:21', dir: 'SHORT' }
  ];

  function epSums(t, epMin) {
    let dOI = 0, delta = 0, lliq = 0, sliq = 0;
    for (let m = t - (epMin - 1) * 60000; m <= t; m += 60000) {
      const p = byMin.get(m);
      if (p) { dOI += p.dOI; delta += p.delta; }
      lliq += longM.get(m) || 0; sliq += shortM.get(m) || 0;
    }
    return { dOI, delta, lliq, sliq };
  }

  const COMBOS = [];
  for (const ep of [10, 15]) for (const st of [85, 90]) for (const sw of [60, 90])
    for (const fl of [50, 60]) for (const lw of [240, 360])
      COMBOS.push({ ep, st, sw, fl, lw });
  // prune to 16: keep sw=60 w/ lw=240 and sw=90 w/ lw=360 pairings
  const combos = COMBOS.filter(c => (c.sw === 60 && c.lw === 240) || (c.sw === 90 && c.lw === 360));

  const out = [];
  out.push('SWEEP 2 - TRIGGER  ' + new Date().toISOString());
  out.push('gate: ratified sweep1d winner (mem92/24h NQ/smoke3h P80)');
  out.push('');

  for (const C of combos) {
    // trailing distributions of |dOI| episode sums for percentile ranking
    function magRank(t, mins) {
      const cur = Math.abs(epSums(t, C.ep).dOI);
      let below = 0, n = 0;
      for (let m = t - mins * 60000; m < t; m += 5 * 60000) {
        if (Math.abs(epSums(m, C.ep).dOI) < cur) below++; n++;
      }
      return n ? below / n : 0;
    }

    const fires = []; // {ms, dir}
    let lastFire = 0;
    for (const t of minutes) {
      const dir = gate.get(t); if (!dir) continue;
      if (t - lastFire < 30 * 60000) continue;   // 30-min refractory
      const e = epSums(t, C.ep);
      let vote = false;
      if (dir === 'SHORT') vote = e.dOI < 0 && e.delta < 0 && e.lliq > e.sliq;
      else vote = e.dOI > 0 && e.delta > 0 && e.sliq > e.lliq;
      if (!vote) continue;
      const rShort = magRank(t, C.sw), rLong = magRank(t, C.lw);
      if (rShort >= C.st / 100 && rLong >= C.fl / 100) {
        fires.push({ ms: t, dir });
        lastFire = t;
      }
    }

    // grade
    let hits = 0; const hitNotes = [];
    for (const tg of TARGETS) {
      const tgMs = Date.parse(tg.day + 'T' + tg.qldHM + ':00+10:00');
      const near = fires.find(f => f.dir === tg.dir && Math.abs(f.ms - tgMs) <= 20 * 60000);
      if (near) { hits++; hitNotes.push(tg.day.slice(8) + ' HIT@' + qld(near.ms).slice(11)); }
      else {
        const sameDay = fires.filter(f => qldDay(f.ms) === tg.day && f.dir === tg.dir);
        hitNotes.push(tg.day.slice(8) + ' MISS' + (sameDay.length ? ' (fired ' + sameDay.map(f => qld(f.ms).slice(11)).join(',') + ')' : ' (silent)'));
      }
    }
    // control: fires during Jul06 11:00-16:00 Qld
    const c0 = Date.parse('2026-07-06T11:00:00+10:00'), c1 = Date.parse('2026-07-06T16:00:00+10:00');
    const ctrlFires = fires.filter(f => f.ms >= c0 && f.ms <= c1).length;
    // per-day fire counts
    const perDay = {};
    for (const f of fires) { const d = qldDay(f.ms).slice(8); perDay[d] = (perDay[d] || 0) + 1; }

    out.push('=== ep' + C.ep + 'm / thumb P' + C.st + '/' + C.sw + 'm / floor P' + C.fl + '/' + C.lw + 'm ===');
    out.push('  targets: ' + hits + '/4   ' + hitNotes.join(' | '));
    out.push('  Jul06 midday control fires: ' + ctrlFires + (ctrlFires === 0 ? ' CLEAN' : ' <-- check'));
    out.push('  total fires: ' + fires.length + '  per-day: ' + Object.entries(perDay).map(([d, n]) => d + ':' + n).join(' '));
    out.push('');
  }

  fs.writeFileSync('sweep2_results.txt', out.join('\n') + '\n');
  console.log('wrote sweep2_results.txt');
})();
