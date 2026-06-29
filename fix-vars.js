const fs = require('fs');
const T = 'ETHERIUM-PREDATOR-V2.js';
let s = fs.readFileSync(T, 'utf8');
const anchor = "    // --- v3: funding + OI as v4 OHLC (last closed candle); dead fields dropped ---";
const i = s.indexOf(anchor);
if (i === -1) { console.log('MISS: anchor not found'); process.exit(1); }
if (s.indexOf(anchor, i + anchor.length) !== -1) { console.log('DUP: anchor not unique'); process.exit(1); }
const addvars =
  "    const fr = pillars && pillars.funding ? (pillars.funding.rate || 0) : 0;\n" +
  "    const oiH1 = pillars && pillars.oi ? (pillars.oi.h1Change || 0) : 0;\n" +
  "    const oiH4 = pillars && pillars.oi ? (pillars.oi.h4Change || 0) : 0;\n" +
  "    const lsLong = pillars && pillars.longShort ? (pillars.longShort.longPct || 0) : 0;\n" +
  "    const lsShort = pillars && pillars.longShort ? (pillars.longShort.shortPct || 0) : 0;\n" +
  "    const liqLongPct = pillars && pillars.liquidations ? (pillars.liquidations.longPct || 0) : 0;\n" +
  "    const liqTotal = pillars && pillars.liquidations ? (pillars.liquidations.total || 0) : 0;\n\n";
s = s.slice(0, i) + addvars + s.slice(i);
fs.writeFileSync(T, s);
console.log('OK: re-added regime-feed variables before v3 block');
