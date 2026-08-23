/**
 * PREDATOR DIGEST v1 - the constitution as a number.
 *
 * Computes the ratified stack every REFRESH_MS and caches it:
 *   GATE   : P95/14d instant arm (tie-corrected rank, sign guard)
 *            + burn latch (P92 visit within 24 NQ-clock hours, 3h smoke >= P80)
 *            + saturation flag, slope state
 *   TRIGGER: 15-min episode sums, three-sign vote (dOI-coin veto / delta / liq$),
 *            sore-thumb rank (90m) + floor rank (24 NQ-clock hours), blackout flag
 *   BELLS  : per-bar coin spike rank, signed 30m funding gap rank, own-side
 *            extreme, same-side victim ranks - both species, clause by clause.
 *            SHADOW: reported, never acted on here.
 *   STAMPS : authored fraction, full-house alignment. (walls: pending v1.1)
 *
 * Usage:
 *   const digest = require('./predator-digest'); digest.start(); digest.get();
 *   Replay (acceptance test):  node predator-digest.js --replay 2026-07-13 2026-07-18
 *     -> prints 5-min grid rows where gate armed + trigger passed; must match
 *        sweep2f (10:32 Mon / 08:00 Tue / 17:45 Thu / 08:35 Fri class results).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const REFRESH_MS = 60 * 1000;

// ---- ratified numbers (constitution, 19 Jul 2026) ----
const GATE_PCT = 0.95, GATE_LOOKBACK_D = 14;
const LATCH_MEM = 0.92, LATCH_NQ_HOURS = 24, SMOKE_PCT = 0.80;
const EP_MIN = 15, THUMB_PCT = 0.90, THUMB_WIN_MIN = 90;
const FLOOR_PCT = 0.60, FLOOR_NQ_HOURS = 24;
const BELL_BAR_PCT = 0.95, BELL_GAP_PCT = 0.90, BELL_VICTIM_PCT = 0.80;
const BLACKOUT_QLD = [5, 8];           // no entries 05:00-08:00 Qld
const SAT_LEVEL = 0.0099;              // funding cap neighbourhood => saturated

// ---------------- data stores (memory) ----------------
// funding: [[ms, fr], ...] ~15d | rows: Map(ms -> {dOIc, dOIu, delta}) ~5d
// liqLong/liqShort: Map(minuteMs -> usd) ~8d | gridRank: [[ms, rank], ...]
let funding = [], rows = new Map(), liqLong = new Map(), liqShort = new Map();
let gridRank = [];
let lastPillarMs = 0, lastLiqMs = 0;
let current = { status: 'starting' };
let lastLiveFireMs = 0;   // live fire ledger edge-guard (30-min refractory)

function isWeekend(ms) {
  const d = new Date(ms), dow = d.getUTCDay(), h = d.getUTCHours();
  return dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 22);
}
const qld = ms => new Date(ms + 36e6).toISOString().slice(0, 16).replace('T', ' ');
const qldHour = ms => new Date(ms + 36e6).getUTCHours();

// ---------------- loading ----------------
function pillarFiles() {
  return fs.readdirSync(DIR).filter(f => /^eth_pillars_v3_\d{4}-\d{2}\.csv$/.test(f)).sort();
}
function liqFiles() {
  return fs.readdirSync(DIR).filter(f => /^eth_liquidations_v2_\d{4}-\d{2}\.csv$/.test(f)).sort();
}

function ingestPillarLine(line, hdr) {
  const c = line.split(',');
  if (c.length < 16) return;
  const ms = Date.parse(c[hdr.timestamp]); if (!isFinite(ms)) return;
  const key = ms - ms % 60000;
  if (key <= lastPillarMs && rows.has(key)) return;
  const fr = parseFloat(c[hdr.funding_close]);
  let dOIc = 0;
  if (hdr.oi_coin_open >= 0 && c.length > hdr.oi_coin_close) {
    const o = parseFloat(c[hdr.oi_coin_open]), cl = parseFloat(c[hdr.oi_coin_close]);
    if (isFinite(o) && isFinite(cl)) dOIc = cl - o;
  }
  const uo = parseFloat(c[hdr.oi_open]), uc = parseFloat(c[hdr.oi_close]);
  const dOIu = (isFinite(uo) && isFinite(uc)) ? uc - uo : 0;
  const delta = parseFloat(c[hdr.cvd_delta]) || 0;
  rows.set(key, { dOIc, dOIu, delta });
  if (isFinite(fr)) funding.push([key, fr]);
  if (key > lastPillarMs) lastPillarMs = key;
}

function pillarHeader(file) {
  const first = fs.readFileSync(path.join(DIR, file), 'utf8').slice(0, 400).split('\n')[0].split(',');
  const idx = n => first.indexOf(n);
  return {
    timestamp: idx('timestamp'), funding_close: idx('funding_close'),
    oi_open: idx('oi_open'), oi_close: idx('oi_close'),
    oi_coin_open: idx('oi_coin_open'), oi_coin_close: idx('oi_coin_close'),
    cvd_delta: idx('cvd_delta')
  };
}

function loadPillars(fullDays) {
  const cutoff = Date.now() - fullDays * 864e5;
  for (const f of pillarFiles()) {
    const hdr = pillarHeader(f);
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line) continue;
      const tms = Date.parse(line.split(',', 3)[hdr.timestamp === 1 ? 1 : hdr.timestamp]);
      if (!isFinite(tms) || tms < cutoff) continue;
      ingestPillarLine(line, hdr);
    }
  }
  funding.sort((a, b) => a[0] - b[0]);
}

function ingestLiqLine(line, hdr) {
  const c = line.split(',');
  if (c.length < 7) return;
  const ms = Date.parse(c[hdr.log_time]); if (!isFinite(ms)) return;
  const usd = parseFloat(c[hdr.usd_value]); if (!isFinite(usd)) return;
  const side = parseInt(c[hdr.side]);
  const key = ms - ms % 60000;
  const map = side === 1 ? liqLong : side === 2 ? liqShort : null;
  if (!map) return;
  map.set(key, (map.get(key) || 0) + usd);
  if (ms > lastLiqMs) lastLiqMs = ms;
}

function liqHeader(file) {
  const first = fs.readFileSync(path.join(DIR, file), 'utf8').slice(0, 300).split('\n')[0].split(',');
  return { log_time: first.indexOf('log_time'), usd_value: first.indexOf('usd_value'), side: first.indexOf('side') };
}

function loadLiqs(fullDays, cutoffMs) {
  // cutoffMs lets replay anchor the window to the REPLAY RANGE instead of the
  // wall clock. Without it, a replay of dates older than `fullDays` silently
  // loads zero liquidations -> smoke test always fails -> every latch fire
  // vanishes. (Diagnosed at board #1, 2026-08-21.)
  const cutoff = (cutoffMs !== undefined && cutoffMs !== null)
    ? cutoffMs : Date.now() - fullDays * 864e5;
  for (const f of liqFiles()) {
    const hdr = liqHeader(f);
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim(); if (!line) continue;
      const p = line.split(',', 3);
      const tms = Date.parse(p[hdr.log_time]);
      if (!isFinite(tms) || tms < cutoff) continue;
      ingestLiqLine(line, hdr);
    }
  }
}

// incremental: re-read the tail of the CURRENT month files each cycle
function refreshTails() {
  const pf = pillarFiles(); const lf = liqFiles();
  if (pf.length) {
    const f = pf[pf.length - 1], hdr = pillarHeader(f);
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    for (let i = Math.max(1, lines.length - 240); i < lines.length; i++) {
      const line = lines[i].trim(); if (line) ingestPillarLine(line, hdr);
    }
    funding.sort((a, b) => a[0] - b[0]);
  }
  if (lf.length) {
    const f = lf[lf.length - 1], hdr = liqHeader(f);
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    // liq minute-sums are rebuilt for the tail window to stay idempotent:
    const tailStart = Date.now() - 6 * 3600e3;
    for (const k of [...liqLong.keys()]) if (k >= tailStart) liqLong.delete(k);
    for (const k of [...liqShort.keys()]) if (k >= tailStart) liqShort.delete(k);
    for (let i = Math.max(1, lines.length - 8000); i < lines.length; i++) {
      const line = lines[i].trim(); if (!line) continue;
      const hdr2 = hdr;
      const c = line.split(',');
      if (c.length < 7) continue;
      const ms = Date.parse(c[hdr2.log_time]);
      if (!isFinite(ms) || ms < tailStart) continue;
      const usd = parseFloat(c[hdr2.usd_value]); if (!isFinite(usd)) continue;
      const side = parseInt(c[hdr2.side]);
      const key = ms - ms % 60000;
      const map = side === 1 ? liqLong : side === 2 ? liqShort : null;
      if (map) map.set(key, (map.get(key) || 0) + usd);
      if (ms > lastLiqMs) lastLiqMs = ms;
    }
  }
  prune();
}

function prune() {
  const fCut = Date.now() - 16 * 864e5;
  while (funding.length && funding[0][0] < fCut) funding.shift();
  const rCut = Date.now() - 6 * 864e5;
  for (const k of rows.keys()) if (k < rCut) rows.delete(k);
  const lCut = Date.now() - 9 * 864e5;
  for (const k of liqLong.keys()) if (k < lCut) liqLong.delete(k);
  for (const k of liqShort.keys()) if (k < lCut) liqShort.delete(k);
  const gCut = Date.now() - 3 * 864e5;
  while (gridRank.length && gridRank[0][0] < gCut) gridRank.shift();
}

// ---------------- ratified math ----------------
function fundingRankAt(t) {
  // tie-corrected percentile of funding at time t vs trailing GATE_LOOKBACK_D
  const lo = t - GATE_LOOKBACK_D * 864e5;
  let cur = null;
  // funding value at t = last point <= t
  for (let i = funding.length - 1; i >= 0; i--) { if (funding[i][0] <= t) { cur = funding[i][1]; break; } }
  if (cur === null) return null;
  let below = 0, ties = 0, n = 0;
  for (let i = 0; i < funding.length; i++) {
    const [ms, v] = funding[i];
    if (ms < lo || ms >= t) continue;
    n++;
    if (v < cur) below++; else if (v === cur) ties++;
  }
  return n < 500 ? null : { rank: (below + ties * 0.5) / n, level: cur, n };
}

function liqSum(map, t, mins) {
  let s = 0;
  for (let m = t - (mins - 1) * 60000; m <= t; m += 60000) s += map.get(m) || 0;
  return s;
}
function pctRankOfSum(map, t, sumMins, sampleStepMin, lookbackDays) {
  const cur = liqSum(map, t, sumMins);
  let below = 0, n = 0;
  for (let m = t - lookbackDays * 864e5; m < t; m += sampleStepMin * 60000) {
    if (liqSum(map, m, sumMins) < cur) below++; n++;
  }
  return n ? { rank: below / n, value: cur } : { rank: 0, value: cur };
}

function epSums(t) {
  let dOIc = 0, dOIu = 0, delta = 0, ll = 0, sl = 0;
  for (let m = t - (EP_MIN - 1) * 60000; m <= t; m += 60000) {
    const p = rows.get(m);
    if (p) { dOIc += p.dOIc; dOIu += p.dOIu; delta += p.delta; }
    ll += liqLong.get(m) || 0; sl += liqShort.get(m) || 0;
  }
  return { dOIc, dOIu, delta, ll, sl };
}

function magRankNQ(t, minutes) {
  const cur = Math.abs(epSums(t).dOIc);
  const target = Math.floor(minutes / 5);
  let below = 0, n = 0, m = t, guard = 0;
  while (n < target && guard++ < 5000) {
    m -= 5 * 60000;
    if (isWeekend(m)) continue;
    if (Math.abs(epSums(m).dOIc) < cur) below++;
    n++;
  }
  return n ? below / n : 0;
}

function gateAt(t) {
  const fr = fundingRankAt(t);
  if (!fr) return { armed: 'NONE', reason: 'insufficient funding history' };
  const { rank, level } = fr;
  const saturated = Math.abs(level) >= SAT_LEVEL;
  // slope state: fraction of positive slope over trailing 60m
  let pos = 0, tot = 0, prev = null;
  for (let i = 0; i < funding.length; i++) {
    const [ms, v] = funding[i];
    if (ms < t - 60 * 60000 || ms > t) continue;
    if (prev !== null) { tot++; if (v > prev) pos++; }
    prev = v;
  }
  const slopeGreenFrac = tot ? pos / tot : 0;

  if (rank >= GATE_PCT && level > 0)
    return { armed: 'SHORT', via: 'instant', rank, level, saturated, slopeGreenFrac };
  if (rank <= 1 - GATE_PCT && level < 0)
    return { armed: 'LONG', via: 'instant', rank, level, saturated, slopeGreenFrac };

  // latch: P92 visit within 24 NQ-clock hours on gridRank history
  let sawHi = false, sawLo = false, hiFr = 0, loFr = 0;
  let budget = LATCH_NQ_HOURS * 3600e3;
  for (let i = gridRank.length - 1; i > 0 && budget > 0; i--) {
    const [ms, r, lv] = gridRank[i];
    if (ms >= t) continue;
    const dt = gridRank[i][0] - (gridRank[i - 1] ? gridRank[i - 1][0] : ms - 5 * 60000);
    if (!isWeekend(ms)) budget -= dt;
    if (r >= LATCH_MEM && lv > 0) { sawHi = true; hiFr = Math.max(hiFr, lv); }
    if (r <= 1 - LATCH_MEM && lv < 0) { sawLo = true; loFr = Math.min(loFr, lv); }
  }
  if (sawHi && level > 0 && level < hiFr) {
    const smoke = pctRankOfSum(liqLong, t, 180, 60, 7);
    if (smoke.rank >= SMOKE_PCT)
      return { armed: 'SHORT', via: 'latch', rank, level, saturated, slopeGreenFrac, smoke: smoke.rank };
    return { armed: 'NONE', rank, level, saturated, slopeGreenFrac, note: 'latch memory hi, smoke ' + smoke.rank.toFixed(2) + ' < ' + SMOKE_PCT };
  }
  if (sawLo && level < 0 && level > loFr) {
    const smoke = pctRankOfSum(liqShort, t, 180, 60, 7);
    if (smoke.rank >= SMOKE_PCT)
      return { armed: 'LONG', via: 'latch', rank, level, saturated, slopeGreenFrac, smoke: smoke.rank };
    return { armed: 'NONE', rank, level, saturated, slopeGreenFrac, note: 'latch memory lo, smoke ' + smoke.rank.toFixed(2) + ' < ' + SMOKE_PCT };
  }
  return { armed: 'NONE', rank, level, saturated, slopeGreenFrac };
}

function triggerAt(t, armed) {
  const e = epSums(t);
  const blackout = qldHour(t) >= BLACKOUT_QLD[0] && qldHour(t) < BLACKOUT_QLD[1];
  const weekend = isWeekend(t);
  let vote = false;
  if (armed === 'SHORT') vote = e.dOIc < 0 && e.delta < 0 && e.ll > e.sl;
  else if (armed === 'LONG') vote = e.dOIc > 0 && e.delta > 0 && e.sl > e.ll;
  const thumb = magRankNQ(t, THUMB_WIN_MIN);
  const floor = magRankNQ(t, FLOOR_NQ_HOURS * 60);
  const sized = thumb >= THUMB_PCT && floor >= FLOOR_PCT;
  const authored = Math.abs(e.dOIu) / (e.ll + e.sl + Math.abs(e.delta) + 1);
  return {
    episode: { dOIc: Math.round(e.dOIc), dOIu_M: +(e.dOIu / 1e6).toFixed(2), delta_M: +(e.delta / 1e6).toFixed(2), liqL_M: +(e.ll / 1e6).toFixed(2), liqS_M: +(e.sl / 1e6).toFixed(2) },
    vote, thumbRank: +thumb.toFixed(3), floorRank: +floor.toFixed(3), sized,
    blackout, weekend,
    fire: !!armed && armed !== 'NONE' && vote && sized && !blackout && !weekend,
    stamps: { authored: +authored.toFixed(2), full_house: vote && ((armed === 'SHORT' && e.dOIu < 0) || (armed === 'LONG' && e.dOIu > 0)) }
  };
}

function bellsAt(t) {
  // per-bar coin spike rank vs trailing 1440 non-weekend bars
  const barKeys = [...rows.keys()].sort((a, b) => a - b);
  let curBar = null;
  for (let i = barKeys.length - 1; i >= 0; i--) { if (barKeys[i] <= t) { curBar = barKeys[i]; break; } }
  if (curBar === null) return { status: 'no data' };
  const cur = Math.abs(rows.get(curBar).dOIc);
  let below = 0, n = 0;
  for (let i = barKeys.length - 1; i >= 0 && n < 1440; i--) {
    const k = barKeys[i];
    if (k >= curBar) continue;
    if (isWeekend(k)) continue;
    if (Math.abs(rows.get(k).dOIc) < cur) below++;
    n++;
  }
  const barRank = n ? below / n : 0;
  const destruction = rows.get(curBar).dOIc < 0;

  // signed 30m gap + magnitude rank vs trailing 7d
  const frNear = tt => { for (let i = funding.length - 1; i >= 0; i--) if (funding[i][0] <= tt) return funding[i][1]; return null; };
  const g = (frNear(t) !== null && frNear(t - 30 * 60000) !== null) ? frNear(t) - frNear(t - 30 * 60000) : 0;
  let gBelow = 0, gN = 0;
  for (let m = t - 7 * 864e5; m < t; m += 30 * 60000) {
    const a = frNear(m), b = frNear(m - 30 * 60000);
    const gm = (a !== null && b !== null) ? Math.abs(a - b) : 0;
    if (gm < Math.abs(g)) gBelow++; gN++;
  }
  const gapRank = gN ? gBelow / gN : 0;
  const fr = fundingRankAt(t);
  const vicL = pctRankOfSum(liqLong, t, 60, 60, 7);
  const vicS = pctRankOfSum(liqShort, t, 60, 60, 7);

  const spike = destruction && barRank >= BELL_BAR_PCT;
  return {
    barRank: +barRank.toFixed(3), destruction, gapSigned: +g.toFixed(6), gapRank: +gapRank.toFixed(3),
    frRank: fr ? +fr.rank.toFixed(3) : null,
    victimLongRank: +vicL.rank.toFixed(3), victimShortRank: +vicS.rank.toFixed(3),
    // for a SHORT position:
    bellB_short: spike && g > 0 && gapRank >= BELL_GAP_PCT && vicS.rank >= BELL_VICTIM_PCT,
    bellA_short: spike && fr && fr.rank <= 0.08 && vicS.rank < 0.5,
    // for a LONG position:
    bellB_long: spike && g < 0 && gapRank >= BELL_GAP_PCT && vicL.rank >= BELL_VICTIM_PCT,
    bellA_long: spike && fr && fr.rank >= 0.92 && vicL.rank < 0.5,
    shadow: true
  };
}

function computeAt(t) {
  t = t - (t % 60000);   // minute-align: row keys are floored minutes (live-path fix)
  const gate = gateAt(t);
  const trigger = triggerAt(t, gate.armed);
  const bells = bellsAt(t);
  return {
    ts: new Date(t).toISOString(), qld: qld(t),
    gate, trigger, bells,
    walls: 'pending v1.1',
    dataAge: { pillars_s: Math.round((Date.now() - lastPillarMs) / 1000), liqs_s: Math.round((Date.now() - lastLiqMs) / 1000) },
    version: 'digest-v1 / constitution 2026-07-19'
  };
}

function appendGridRank(t) {
  const g = t - (t % (5 * 60000));
  if (gridRank.length && gridRank[gridRank.length - 1][0] >= g) return;
  const fr = fundingRankAt(g);
  if (fr) gridRank.push([g, fr.rank, fr.level]);
}

// ---------------- lifecycle ----------------
let timer = null;
function start() {
  console.log('[digest] loading history...');
  loadPillars(6); loadLiqs(9);
  // backfill grid ranks over trailing ~36 NQ-hours
  const now = Date.now();
  for (let m = now - 4 * 864e5; m <= now; m += 5 * 60000) appendGridRank(m);
  console.log('[digest] funding pts: ' + funding.length + ', rows: ' + rows.size + ', gridRank: ' + gridRank.length);
  const tick = () => {
    try {
      refreshTails();
      appendGridRank(Date.now());
      current = computeAt(Date.now());
      // LIVE FIRE LEDGER: every fire appends to digest_fires.csv permanently
      if (current && current.trigger && current.trigger.fire &&
          Date.now() - lastLiveFireMs > 30 * 60000) {
        lastLiveFireMs = Date.now();
        const f = path.join(DIR, 'digest_fires.csv');
        const t = current.trigger.episode;
        const line = current.ts + ',' + current.qld + ',' + current.gate.armed + ',' +
          (current.gate.via || 'live') + ',' + t.dOIc + ',' + t.delta_M + ',' +
          current.trigger.thumbRank + ',' + current.trigger.floorRank + '\n';
        if (!fs.existsSync(f))
          fs.writeFileSync(f, 'ts_utc,qld,side,via,dOIc,delta_M,thumbRank,floorRank\n');
        fs.appendFileSync(f, line);
        console.log('[digest] LIVE FIRE appended: ' + current.qld + ' ' + current.gate.armed);
      }
    } catch (e) { current = { status: 'error', error: e.message, ts: new Date().toISOString() }; }
  };
  tick();
  timer = setInterval(tick, REFRESH_MS);
  console.log('[digest] live, refreshing every ' + REFRESH_MS / 1000 + 's');
}
function get() { return current; }

module.exports = { start, get };

// ---------------- replay (acceptance test) ----------------
if (require.main === module && process.argv[2] === '--replay') {
  const from = Date.parse(process.argv[3] + 'T00:00:00+10:00');
  const to = Date.parse(process.argv[4] + 'T23:59:00+10:00');
  console.log('[replay] loading full history for range...');
  const days = Math.ceil((Date.now() - from) / 864e5) + GATE_LOOKBACK_D + 2;
  // liqs must cover the replay range itself plus the 7-day smoke lookback
  loadPillars(days); loadLiqs(0, from - 10 * 864e5);
  for (let m = from - 3 * 864e5; m < from; m += 5 * 60000) appendGridRank(m);
  console.log('[replay] scanning ' + process.argv[3] + ' -> ' + process.argv[4]);
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const fireRows = ['ts_utc,qld,side,via,dOIc,delta_M,thumbRank,floorRank'];
  let lastFire = 0;
  for (let m = from; m <= to; m += 5 * 60000) {
    appendGridRank(m);
    const gate = gateAt(m);
    if (gate.armed === 'NONE') continue;
    const trig = triggerAt(m, gate.armed);
    if (trig.fire && m - lastFire > 30 * 60000) {
      console.log(qld(m) + '  ' + gate.armed + ' (' + gate.via + ')  dOIc:' + trig.episode.dOIc +
        ' delta:' + trig.episode.delta_M + 'M  thumb:' + trig.thumbRank + ' floor:' + trig.floorRank);
      fireRows.push(new Date(m).toISOString() + ',' + qld(m) + ',' + gate.armed + ',' + gate.via + ',' +
        trig.episode.dOIc + ',' + trig.episode.delta_M + ',' + trig.thumbRank + ',' + trig.floorRank);
      lastFire = m;
    }
  }
  if (outFile) { fs.writeFileSync(path.join(DIR, outFile), fireRows.join('\n') + '\n'); console.log('[replay] wrote ' + outFile + ' (' + (fireRows.length - 1) + ' fires)'); }
  console.log('[replay] done');
  process.exit(0);
}
