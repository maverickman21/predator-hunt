// patch-housekeeping.js — options sidecar v3 (qld_time + cp_ratio at source),
// NQ staleness guard, pillar gap visibility, server side-comment fix.
// Run in ~/predator-hunt:  node patch-housekeeping.js
const fs = require('fs');
let changes = 0, expected = 7;
function patch(file, anchor, repl, label) {
  let s = fs.readFileSync(file, 'utf8');
  const i = s.indexOf(anchor);
  if (i === -1) { console.log('  [MISS] ' + label); return; }
  if (s.indexOf(anchor, i + anchor.length) !== -1) { console.log('  [DUP] ' + label); return; }
  fs.writeFileSync(file, s.slice(0, i) + repl + s.slice(i + anchor.length));
  changes++;
  console.log('  [OK] ' + label);
}

const C = 'ETHERIUM-PREDATOR-V2.js';
const S = 'predator-api-server.js';

// ---- 1. Options sidecar -> v3 lineage ----
patch(C,
  "PILLAR_OPTIONS_LOG = getMonthlyFilename('eth_options_detail_v2');",
  "PILLAR_OPTIONS_LOG = getMonthlyFilename('eth_options_detail_v3');",
  "options log filename -> eth_options_detail_v3");

// ---- 2. Options header: qld_time first, cp_ratio last ----
patch(C,
  "    ensureCSV(PILLAR_OPTIONS_LOG, 'timestamp,eth_price,expiry_date,max_pain_price,call_oi,put_oi,call_notional,put_notional\\n');",
  "    ensureCSV(PILLAR_OPTIONS_LOG, 'qld_time,timestamp,eth_price,expiry_date,max_pain_price,call_oi,put_oi,call_notional,put_notional,cp_ratio\\n');",
  "options header -> v3 (qld_time + cp_ratio)");

// ---- 3. Options row: prepend qldStr, append cp_ratio (qldStr already in scope from v3 block) ----
patch(C,
  '            optRows += optTs + "," + wethPrice.toFixed(2) + "," + e.date + "," + e.max_pain_price + "," + e.call_open_interest + "," + e.put_open_interest + "," + e.call_open_interest_notional + "," + e.put_open_interest_notional + "\\n";',
  '            var ocn = parseFloat(e.call_open_interest_notional) || 0;\n' +
  '            var opn = parseFloat(e.put_open_interest_notional) || 0;\n' +
  '            var ocp = opn > 0 ? (ocn / opn).toFixed(3) : "";\n' +
  '            optRows += qldStr + "," + optTs + "," + wethPrice.toFixed(2) + "," + e.date + "," + e.max_pain_price + "," + e.call_open_interest + "," + e.put_open_interest + "," + e.call_open_interest_notional + "," + e.put_open_interest_notional + "," + ocp + "\\n";',
  "options row -> qld at source + cp_ratio baked in");

// ---- 4. NQ staleness guard: stale (>2 min) reads as 0, not last value ----
patch(C,
  "                if (data.price && data.price > 0) {",
  "                const nqAgeMs = data.time ? (Date.now() - Date.parse(data.time)) : Infinity;\n" +
  "                if (nqAgeMs >= 120000) { nqPrice = 0; }   // stale: blank is honest, frozen is a lie\n" +
  "                if (data.price && data.price > 0 && nqAgeMs < 120000) {",
  "NQ staleness guard (2 min)");

// ---- 5. v3 pillar row: blank nq when stale/zero instead of 0.00 ----
patch(C,
  '+ nqP.toFixed(2) + "," + activeYellowCount',
  '+ (nqP > 0 ? nqP.toFixed(2) : "") + "," + activeYellowCount',
  "pillar row -> blank NQ when stale");

// ---- 6. Gap visibility: log when pillar snapshots are >90s apart ----
patch(C,
  "    if (now - lastPillarFetch < PILLAR_INTERVAL) return;\r\n    lastPillarFetch = now;",
  "    if (now - lastPillarFetch < PILLAR_INTERVAL) return;\r\n" +
  "    if (lastPillarFetch > 0 && now - lastPillarFetch > 90000) {\r\n" +
  "        console.log('  [GAP] ' + Math.round((now - lastPillarFetch) / 1000) + 's since last pillar snapshot (feed stall?)');\r\n" +
  "    }\r\n    lastPillarFetch = now;",
  "pillar gap visibility log");

// ---- 7. Server: fix the backwards side-code comment ----
patch(S,
  "// side: 1 = short liquidated (force-bought) ; 2 = long liquidated (force-sold)",
  "// side: 1 = LONG liquidated (force-sold) ; 2 = SHORT liquidated (force-bought)  [confirmed empirically]",
  "server side-code comment corrected");

console.log('\nApplied ' + changes + '/' + expected + ' changes.');
if (changes !== expected) { console.log('!!! NOT ALL APPLIED - DO NOT RESTART. Report misses.'); process.exit(1); }
console.log('All anchors hit. Run: node -c ' + C + ' && node -c ' + S);
