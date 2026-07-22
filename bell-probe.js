/**
 * BELL PROBE - no auditioning, no thresholds. Prints every bell clause's raw
 * value at the three adjudicated timestamps (+/-10 min), reading oi_coin by
 * POSITION (cols 17-20) since the v3 header is stale. Diagnosis, not repair.
 */
const fs = require('fs');
const rows = [];
{
  const lines = fs.readFileSync('eth_pillars_v3_2026-07.csv', 'utf8').split('\n');
  const h = lines[0].split(',');
  const ti = h.indexOf('timestamp'), fo = h.indexOf('funding_close');
  const ouo = h.indexOf('oi_open'), ouc = h.indexOf('oi_close'), cd = h.indexOf('cvd_delta');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 16) continue;
    const ms = Date.parse(c[ti]); if (!isFinite(ms)) continue;
    const fr = parseFloat(c[fo]);
    const dOIu = (parseFloat(c[ouc]) - parseFloat(c[ouo])) || 0;
    // coin columns BY POSITION: 16=open,17=high,18=low,19=close (0-indexed)
    let dOIc = 0;
    if (c.length >= 20) {
      const o = parseFloat(c[16]), cl = parseFloat(c[19]);
      if (isFinite(o) && isFinite(cl)) dOIc = cl - o;
    }
    const delta = parseFloat(c[cd]) || 0;
    rows.push({ ms: ms - ms % 60000, fr, dOIu, dOIc, delta });
  }
  rows.sort((a, b) => a.ms - b.ms);
}
const byMin = new Map(rows.map(r => [r.ms, r]));
const liqM = new Map();
{
  const lines = fs.readFileSync('eth_liquidations_v2_2026-07.csv', 'utf8').split('\n');
  const h = lines[0].split(','); const ti = h.indexOf('log_time'), ui = h.indexOf('usd_value');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(','); if (c.length < 7) continue;
    const ms = Date.parse(c[ti]); const usd = parseFloat(c[ui]);
    if (!isFinite(ms) || !isFinite(usd)) continue;
    const k = ms - ms % 60000; liqM.set(k, (liqM.get(k) || 0) + usd);
  }
}
function qld(ms) { return new Date(ms + 36e6).toISOString().slice(5, 16).replace('T', ' '); }

const TARGETS = [
  ['Tue 05:23 exit', Date.parse('2026-07-14T05:23:00+10:00')],
  ['Fri 23:59 exit', Date.parse('2026-07-17T23:59:00+10:00')],
  ['Thu 23:52 SHAKEOUT', Date.parse('2026-07-16T23:52:00+10:00')]
];

for (const [label, T] of TARGETS) {
  console.log('\n======== ' + label + ' (' + qld(T) + ') ========');
  console.log('per-bar, T-10m .. T+10m:  [dOI-coin | dOI-USD | delta | liq$ | bar-ratio |dOIu|/(liq+|delta|)]');
  for (let m = T - 10 * 60000; m <= T + 10 * 60000; m += 60000) {
    const p = byMin.get(m); const l = liqM.get(m) || 0;
    if (!p) { console.log('  ' + qld(m) + '  (no row)'); continue; }
    const ratio = Math.abs(p.dOIu) / (l + Math.abs(p.delta) + 1);
    console.log('  ' + qld(m) +
      '  dOIc:' + p.dOIc.toFixed(0).padStart(7) +
      '  dOIu:' + (p.dOIu / 1e6).toFixed(2).padStart(8) + 'M' +
      '  delta:' + (p.delta / 1e6).toFixed(2).padStart(8) + 'M' +
      '  liq:' + (l / 1e6).toFixed(2).padStart(6) + 'M' +
      '  ratio:' + ratio.toFixed(2));
  }
  // 15m episode sums ending at T
  let dOIc = 0, dOIu = 0, delta = 0, liq = 0, peak = 0;
  for (let m = T - 14 * 60000; m <= T; m += 60000) {
    const p = byMin.get(m); const l = liqM.get(m) || 0;
    if (p) {
      dOIc += p.dOIc; dOIu += p.dOIu; delta += p.delta;
      const r = Math.abs(p.dOIu) / (l + Math.abs(p.delta) + 1);
      if ((p.dOIc < 0 || p.dOIu < 0) && r > peak) peak = r;
    }
    liq += l;
  }
  console.log('EPISODE(15m @T): dOIc-sum:' + dOIc.toFixed(0) + '  dOIu-sum:' + (dOIu / 1e6).toFixed(2) + 'M  delta-sum:' + (delta / 1e6).toFixed(2) + 'M  liq-sum:' + (liq / 1e6).toFixed(2) + 'M  peak-bar-ratio:' + peak.toFixed(2));
  // funding around T
  function frNear(t) { for (let m = t; m >= t - 10 * 60000; m -= 60000) { const p = byMin.get(m); if (p) return p.fr; } return null; }
  const f0 = frNear(T), f30 = frNear(T - 30 * 60000), f60 = frNear(T - 60 * 60000);
  console.log('FUNDING: now:' + f0 + '  30m-ago:' + f30 + '  60m-ago:' + f60 + '  gap30:' + (f0 !== null && f30 !== null ? Math.abs(f0 - f30).toFixed(6) : 'n/a'));
}
console.log('\ndone');

