/**
 * THE APRIL HEARING - the frozen July gate + funding-character tags,
 * replayed over the April-May v2 archive.
 * Per day: funding stats, zero-crossings, character tag, gate armed minutes
 * (instant clause, tie-corrected 14d rank + sign guard), macro events annotated.
 * Questions on trial:
 *   1. Does OSCILLATING cluster around Tier-A/B macro days? (this week's thesis)
 *   2. Which days would the July gate have armed? (vs the Duke-era journal)
 *   3. April 14: anomaly, sign-guard case, or deadlock?
 * Output: aprmay_results.txt
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

// ---- load v2 pillars (timestamp col0, funding_rate col4) ----
const rows = [];
for (const f of ['eth_pillars_v2_2026-04.csv', 'eth_pillars_v2_2026-05.csv', 'eth_pillars_v2_2026-06.csv']) {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim(); if (!line || line.startsWith('timestamp')) continue;
    const c = line.split(',');
    if (c.length < 6) continue;
    const ms = Date.parse(c[0]); if (!isFinite(ms)) continue;
    const fr = parseFloat(c[4]); if (!isFinite(fr)) continue;
    rows.push([ms, fr]);
  }
}
rows.sort((a, b) => a[0] - b[0]);
console.log('funding points: ' + rows.length);

// ---- macro calendar ----
let events = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'economic-calendar.json'), 'utf8'));
  events = Array.isArray(raw) ? raw : (raw.events || raw.calendar || Object.values(raw).find(v => Array.isArray(v)) || []);
} catch (e) { }
function eventsOn(qldDate) {
  return events.filter(e => (e.date || '').slice(0, 10) === qldDate).map(e => e.event).join(' + ');
}

// ---- tie-corrected 14d rank at index i ----
function rankAt(i) {
  const t = rows[i][0], lo = t - 14 * 864e5, cur = rows[i][1];
  let below = 0, ties = 0, n = 0;
  // walk back (rows dense ~1/min; cap for speed: sample every 5th)
  for (let j = i - 1; j >= 0; j--) {
    const ms = rows[j][0];
    if (ms < lo) break;
    if ((i - j) % 5 !== 0) continue;
    n++;
    const v = rows[j][1];
    if (v < cur) below++; else if (v === cur) ties++;
  }
  return n < 300 ? null : (below + ties * 0.5) / n;
}

// ---- per-day aggregation (Qld days) ----
const days = new Map();
for (let i = 0; i < rows.length; i++) {
  const [ms, fr] = rows[i];
  const qld = new Date(ms + 36e6).toISOString().slice(0, 10);
  if (!days.has(qld)) days.set(qld, { idx: [], frs: [] });
  const d = days.get(qld);
  d.idx.push(i); d.frs.push(fr);
}

const out = [];
out.push('THE APRIL HEARING  ' + new Date().toISOString());
out.push('day | first->last (min..max) | zeroX | character | armed S/L min | macro');
out.push('-'.repeat 
  ? '' : '-'.repeat(110));

for (const [qld, d] of [...days.entries()].sort()) {
  if (qld < '2026-04-11' || qld > '2026-05-31') continue;
  const frs = d.frs;
  const first = frs[0], last = frs[frs.length - 1];
  const mn = Math.min(...frs), mx = Math.max(...frs);
  let zeroX = 0;
  for (let k = 1; k < frs.length; k++) if ((frs[k] >= 0) !== (frs[k - 1] >= 0)) zeroX++;
  // character
  const range = mx - mn, drift = Math.abs(last - first);
  const absPeak = Math.max(Math.abs(mx), Math.abs(mn));
  let ch;
  if (zeroX >= 2) ch = 'OSCILLATING';
  else if (absPeak > 0 && (absPeak - Math.abs(last)) / absPeak < 0.25 && drift / (range + 1e-9) > 0.5) ch = 'LOADING';
  else if (absPeak > 0 && Math.abs(last) / absPeak > 0.8 && Math.abs(first) / absPeak > 0.8) ch = 'PINNED';
  else if (drift / (range + 1e-9) > 0.5 && Math.abs(last) < Math.abs(first)) ch = 'DRAINING';
  else ch = 'MIXED';
  // gate armed minutes (sample every 5th row for speed)
  let armS = 0, armL = 0;
  for (let k = 0; k < d.idx.length; k += 5) {
    const i = d.idx[k];
    const r = rankAt(i);
    if (r === null) continue;
    const fr = rows[i][1];
    if (r >= 0.95 && fr > 0) armS += 5;
    else if (r <= 0.05 && fr < 0) armL += 5;
  }
  const ev = eventsOn(qld);
  out.push(qld + ' | ' + first.toFixed(5) + '->' + last.toFixed(5) +
    ' (' + mn.toFixed(5) + '..' + mx.toFixed(5) + ')' +
    ' | zX:' + zeroX + ' | ' + ch.padEnd(11) +
    ' | S:' + String(armS).padStart(4) + 'm L:' + String(armL).padStart(4) + 'm' +
    (ev ? ' | ** ' + ev : ''));
}
fs.writeFileSync('aprmay_results.txt', out.join('\n') + '\n');
console.log('wrote aprmay_results.txt');

