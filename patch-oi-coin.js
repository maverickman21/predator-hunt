// patch-oi-coin.js - add coin-denominated OI OHLC (pure positioning, no price revaluation)
// Patches collector (fetch + 4 columns) and server (HEADER). Run in ~/predator-hunt.
const fs = require('fs');
let changes = 0, expected = 5;
function patch(file, anchor, repl, label) {
  let s = fs.readFileSync(file, 'utf8');
  const i = s.indexOf(anchor);
  if (i === -1) { console.log('  [MISS] ' + label); return; }
  if (s.indexOf(anchor, i + anchor.length) !== -1) { console.log('  [DUP] ' + label); return; }
  fs.writeFileSync(file, s.slice(0, i) + repl + s.slice(i + anchor.length));
  changes++; console.log('  [OK] ' + label);
}
const C = 'ETHERIUM-PREDATOR-V2.js', S = 'predator-api-server.js';

// 1. new helper after getOiOHLC (anchor its closing + next function start)
patch(C,
  '} catch (e) { console.log("  [OI OHLC ERR] " + e.message.slice(0,60)); return null; }\n}',
  '} catch (e) { console.log("  [OI OHLC ERR] " + e.message.slice(0,60)); return null; }\n}\n\n' +
  '// coin-denominated OI: contract quantity in ETH, immune to price revaluation.\n' +
  'async function getOiOHLCCoin() {\n' +
  '    try {\n' +
  '        var r = await coinglassV4Get("/api/futures/open-interest/history?exchange=Binance&symbol=ETHUSDT&interval=1m&limit=3&unit=coin");\n' +
  '        if (!r || String(r.code) !== "0" || !Array.isArray(r.data) || r.data.length < 2) return null;\n' +
  '        var c = r.data[r.data.length - 2];\n' +
  '        return { open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close) };\n' +
  '    } catch (e) { console.log("  [OI COIN ERR] " + e.message.slice(0,60)); return null; }\n' +
  '}',
  'insert getOiOHLCCoin helper');

// 2. add to Promise.all
patch(C,
  '        getFundingOHLC(),\r\n        getOiOHLC(),\r\n    ]);',
  '        getFundingOHLC(),\r\n        getOiOHLC(),\r\n        getOiOHLCCoin(),\r\n    ]);',
  'Promise.all + coin fetch');
patch(C,
  'liqOrders, fundOHLC, oiOHLC] = await Promise.all',
  'liqOrders, fundOHLC, oiOHLC, oiCoinOHLC] = await Promise.all',
  'destructure oiCoinOHLC');

// 3. append 4 columns to the pillar row (before newline)
patch(C,
  '+ (cvd ? cvd.delta.toFixed(2) : "") + "\\n";',
  '+ (cvd ? cvd.delta.toFixed(2) : "") + ","\n' +
  '        + (function(o){ return o ? [o.open,o.high,o.low,o.close].join(",") : ",,,"; })(oiCoinOHLC) + "\\n";',
  'pillar row + oi_coin OHLC columns');

// 4. server HEADER
patch(S,
  "+ 'oi_open,oi_high,oi_low,oi_close,'\n                 + 'cvd_agg_buy,cvd_agg_sell,cvd_delta';",
  "+ 'oi_open,oi_high,oi_low,oi_close,'\n                 + 'cvd_agg_buy,cvd_agg_sell,cvd_delta,oi_coin_open,oi_coin_high,oi_coin_low,oi_coin_close';",
  'server v3 HEADER + coin columns');

console.log('\nApplied ' + changes + '/' + expected + ' changes.');
if (changes !== expected) { console.log('!!! NOT ALL APPLIED - DO NOT RESTART.'); process.exit(1); }
console.log('OK. Run: node -c ' + C + ' && node -c ' + S);
