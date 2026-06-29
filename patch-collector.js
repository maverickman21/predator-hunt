// patch-collector.js — migrate pillar feed to v4 OHLC (funding + OI), new v3 schema
// Run: node patch-collector.js   (operates in-place on ETHERIUM-PREDATOR-V2.js in cwd)
const fs = require('fs');
const TARGET = process.argv[2] || 'ETHERIUM-PREDATOR-V2.js';
let src = fs.readFileSync(TARGET, 'utf8');
let changes = 0;
function replace(anchor, repl, label) {
  const i = src.indexOf(anchor);
  if (i === -1) { console.log('  [MISS] anchor not found: ' + label); return; }
  if (src.indexOf(anchor, i + anchor.length) !== -1) { console.log('  [DUP] anchor not unique: ' + label); return; }
  src = src.slice(0, i) + repl + src.slice(i + anchor.length);
  changes++;
  console.log('  [OK] ' + label);
}

// ---- 1. Insert two new v4 OHLC fetch helpers after coinglassV4Get's closing brace ----
// Anchor: the v4 helper's end immediately followed by the CVD function.
var H_ANCHOR = "}\n\nasync function getFuturesCVD() {";
var H_NEW =
  "}\n\n" +
  "// --- v4 OHLC: last CLOSED 1m candle only (drop the still-forming last element) ---\n" +
  "async function getFundingOHLC() {\n" +
  "    try {\n" +
  "        var r = await coinglassV4Get(\"/api/futures/funding-rate/history?exchange=Binance&symbol=ETHUSDT&interval=1m&limit=3\");\n" +
  "        if (!r || String(r.code) !== \"0\" || !Array.isArray(r.data) || r.data.length < 2) return null;\n" +
  "        var c = r.data[r.data.length - 2];\n" +
  "        return { open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) };\n" +
  "    } catch (e) { console.log(\"  [FUND OHLC ERR] \" + e.message.slice(0,60)); return null; }\n" +
  "}\n\n" +
  "async function getOiOHLC() {\n" +
  "    try {\n" +
  "        var r = await coinglassV4Get(\"/api/futures/open-interest/history?exchange=Binance&symbol=ETHUSDT&interval=1m&limit=3&unit=usd\");\n" +
  "        if (!r || String(r.code) !== \"0\" || !Array.isArray(r.data) || r.data.length < 2) return null;\n" +
  "        var c = r.data[r.data.length - 2];\n" +
  "        return { open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) };\n" +
  "    } catch (e) { console.log(\"  [OI OHLC ERR] \" + e.message.slice(0,60)); return null; }\n" +
  "}\n\n" +
  "async function getFuturesCVD() {";
replace(H_ANCHOR, H_NEW, "insert getFundingOHLC + getOiOHLC helpers");

// ---- 2. New v3 pillar log filename variable + ensureCSV header ----
// Anchor the old PILLAR_LOG ensureCSV line, replace its header with the v3 schema
// and repoint PILLAR_LOG to the _v3 lineage.
var CSV_ANCHOR = "    ensureCSV(PILLAR_LOG, 'timestamp,eth_price,nq_price,yellow_count,funding_rate,oi_total,oi_h1_change,oi_h4_change,vol_h1_change,ls_long_pct,ls_short_pct,liq_total_1h,liq_long_pct,liq_total_4h,max_pain,max_pain_dist,pc_ratio,bias_score,cvd_agg_buy,cvd_agg_sell,cvd_delta\\n');";
var CSV_NEW =
  "    ensureCSV(PILLAR_LOG, 'qld_time,timestamp,eth_price,nq_price,yellow_count,funding_open,funding_high,funding_low,funding_close,oi_open,oi_high,oi_low,oi_close,cvd_agg_buy,cvd_agg_sell,cvd_delta\\n');";
replace(CSV_ANCHOR, CSV_NEW, "pillar CSV header -> v3 schema");

// Repoint the monthly filename to v3 lineage
var FN_ANCHOR = "PILLAR_LOG = getMonthlyFilename('eth_pillars_v2');";
var FN_NEW = "PILLAR_LOG = getMonthlyFilename('eth_pillars_v3');";
replace(FN_ANCHOR, FN_NEW, "PILLAR_LOG filename -> eth_pillars_v3");

// ---- 3. Add the two OHLC fetches to the Promise.all ----
var PALL_ANCHOR =
  "    const [pillars, deribit, cvd, optMaxPain, liqOrders] = await Promise.all([\r\n" +
  "        getFourPillars(),\r\n" +
  "        getDeribitMaxPain(wethPrice),\r\n" +
  "        getFuturesCVD(),\r\n" +
  "        getOptionMaxPain(),\r\n" +
  "        getLiquidationOrders(),\r\n" +
  "    ]);";
var PALL_NEW =
  "    const [pillars, deribit, cvd, optMaxPain, liqOrders, fundOHLC, oiOHLC] = await Promise.all([\r\n" +
  "        getFourPillars(),\r\n" +
  "        getDeribitMaxPain(wethPrice),\r\n" +
  "        getFuturesCVD(),\r\n" +
  "        getOptionMaxPain(),\r\n" +
  "        getLiquidationOrders(),\r\n" +
  "        getFundingOHLC(),\r\n" +
  "        getOiOHLC(),\r\n" +
  "    ]);";
replace(PALL_ANCHOR, PALL_NEW, "Promise.all + funding/oi OHLC fetches");

// ---- 4. Replace the variable-extraction + row build with the v3 row ----
var ROW_ANCHOR =
  "    const fr = pillars?.funding?.rate || 0;\r\n" +
  "    const oiTotal = pillars?.oi?.total || 0;\r\n" +
  "    const oiH1 = pillars?.oi?.h1Change || 0;\r\n" +
  "    const oiH4 = pillars?.oi?.h4Change || 0;\r\n" +
  "    const volH1 = pillars?.oi?.h1VolChange || 0;\r\n" +
  "    const lsLong = pillars?.longShort?.longPct || 0;\r\n" +
  "    const lsShort = pillars?.longShort?.shortPct || 0;\r\n" +
  "    const liqTotal = pillars?.liquidations?.total || 0;\r\n" +
  "    const liqLongPct = pillars?.liquidations?.longPct || 0;\r\n" +
  "    const liqTotal4h = pillars?.liquidations?.total4h || 0;\r\n" +
  "    const mp = deribit?.maxPain || 0;\r\n" +
  "    const mpDist = deribit?.distFromPrice || 0;\r\n" +
  "    const pcr = deribit?.pcRatio || 0;\r\n" +
  "\r\n" +
  "    rotateLogs();\r\n";
var ROW_NEW =
  "    // --- v3: funding + OI as v4 OHLC (last closed candle); dead fields dropped ---\n" +
  "    var fO = fundOHLC || {};\n" +
  "    var oO = oiOHLC || {};\n" +
  "    var blank7 = function(v){ return (v === undefined || v === null || isNaN(v)) ? \"\" : v; };\n" +
  "    var nowIso = new Date().toISOString();\n" +
  "    var QLD_OFFSET_MS = 10 * 60 * 60 * 1000;\n" +
  "    var pad2 = function(n){ return String(n).padStart(2, \"0\"); };\n" +
  "    var qd = new Date(Date.now() + QLD_OFFSET_MS);\n" +
  "    var qldStr = qd.getUTCFullYear() + \"-\" + pad2(qd.getUTCMonth()+1) + \"-\" + pad2(qd.getUTCDate()) + \" \"\n" +
  "             + pad2(qd.getUTCHours()) + \":\" + pad2(qd.getUTCMinutes()) + \":\" + pad2(qd.getUTCSeconds());\n" +
  "\r\n" +
  "    rotateLogs();\r\n";
replace(ROW_ANCHOR, ROW_NEW, "drop dead var extractions, add OHLC+qld vars");

// The actual row template literal (still uses backticks in the SOURCE file, which is fine
// — we are only replacing it as a plain string here in the patch).
var TMPL_ANCHOR =
  "    const row = `${new Date().toISOString()},${wethPrice.toFixed(2)},${nqP.toFixed(2)},${activeYellowCount},${fr},${(oiTotal / 1e9).toFixed(2)},${oiH1},${oiH4},${volH1},${lsLong.toFixed(1)},${lsShort.toFixed(1)},${(liqTotal / 1e6).toFixed(3)},${liqLongPct.toFixed(1)},${(liqTotal4h / 1e6).toFixed(3)},${mp},${mpDist.toFixed(0)},${pcr.toFixed(3)},${bias.score},${cvd ? cvd.buy.toFixed(2) : \"\"},${cvd ? cvd.sell.toFixed(2) : \"\"},${cvd ? cvd.delta.toFixed(2) : \"\"}\\n`;";
var TMPL_NEW =
  "    const row = qldStr + \",\" + nowIso + \",\" + wethPrice.toFixed(2) + \",\" + nqP.toFixed(2) + \",\" + activeYellowCount + \",\"\n" +
  "        + blank7(fO.open) + \",\" + blank7(fO.high) + \",\" + blank7(fO.low) + \",\" + blank7(fO.close) + \",\"\n" +
  "        + blank7(oO.open) + \",\" + blank7(oO.high) + \",\" + blank7(oO.low) + \",\" + blank7(oO.close) + \",\"\n" +
  "        + (cvd ? cvd.buy.toFixed(2) : \"\") + \",\" + (cvd ? cvd.sell.toFixed(2) : \"\") + \",\" + (cvd ? cvd.delta.toFixed(2) : \"\") + \"\\n\";";
replace(TMPL_ANCHOR, TMPL_NEW, "row build -> v3 schema (qld_time first, OHLC, no dead fields)");

fs.writeFileSync(TARGET, src);
console.log('\nApplied ' + changes + '/6 changes.');
if (changes !== 6) { console.log('!!! NOT ALL CHANGES APPLIED — DO NOT RESTART. Investigate misses above.'); process.exit(1); }
console.log('All anchors hit. Run: node -c ' + TARGET);
