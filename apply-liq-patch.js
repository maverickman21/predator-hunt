const fs = require('fs');
const F = 'predator-api-server.js';
let s = fs.readFileSync(F, 'utf8');

if (s.indexOf("/api/liquidations") >= 0) {
  console.log('SKIP: /api/liquidations already present, no change made');
  process.exit(0);
}

// Anchor: the /api/pillars route is the LAST route in the file and ends with
// this exact catch/close sequence. Insert the new route immediately after it.
const anchor = "    res.type('text/csv').send(out.join('\\n') + '\\n');\n  } catch (err) {\n    res.status(500).json({ error: err.message });\n  }\n});";
const i = s.lastIndexOf(anchor);
if (i < 0) { console.log('FAIL: anchor not found'); process.exit(1); }

const insert = "\n\n" +
"// -------------------------------------------------------------\n" +
"// GET /api/liquidations\n" +
"// Raw force-close events as ONE continuous CSV, stitched from every\n" +
"// monthly eth_liquidations_v2_YYYY-MM.csv. Prepends Qld-time as col 0.\n" +
"//   Optional bounds matched against log_time (UTC, col 0 of sidecar):\n" +
"//   ?from=2026-06-22T00:00:00Z  ?to=2026-06-23T00:00:00Z\n" +
"// NOTE: we do NOT dedupe by timestamp - a cascade fires many events in the\n" +
"// same millisecond and we want them all - so we dedupe by the FULL row.\n" +
"// side: 1 = short liquidated (force-bought) ; 2 = long liquidated (force-sold)\n" +
"// -------------------------------------------------------------\n" +
"app.get('/api/liquidations', (req, res) => {\n" +
"  try {\n" +
"    const fromMs = req.query.from ? Date.parse(req.query.from) : -Infinity;\n" +
"    const toMs   = req.query.to   ? Date.parse(req.query.to)   :  Infinity;\n" +
"\n" +
"    const QLD_OFFSET_MS = 10 * 60 * 60 * 1000;\n" +
"    const pad = n => String(n).padStart(2, '0');\n" +
"    const qldStr = ms => {\n" +
"      const d = new Date(ms + QLD_OFFSET_MS);\n" +
"      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' '\n" +
"           + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());\n" +
"    };\n" +
"\n" +
"    const files = fs.readdirSync(__dirname)\n" +
"      .filter(f => /^eth_liquidations_v2_\\d{4}-\\d{2}\\.csv$/.test(f))\n" +
"      .sort();\n" +
"\n" +
"    const seen = new Set();\n" +
"    const rows = [];\n" +
"    for (const file of files) {\n" +
"      const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\\r?\\n/);\n" +
"      for (const raw of lines) {\n" +
"        const line = raw.trim();\n" +
"        if (!line) continue;\n" +
"        if (line.indexOf('log_time') === 0) continue;\n" +
"        const comma = line.indexOf(',');\n" +
"        if (comma < 1) continue;\n" +
"        const ms = Date.parse(line.slice(0, comma));\n" +
"        if (isNaN(ms) || ms < fromMs || ms > toMs) continue;\n" +
"        if (seen.has(line)) continue;\n" +
"        seen.add(line);\n" +
"        rows.push({ ms, line });\n" +
"      }\n" +
"    }\n" +
"    rows.sort((a, b) => a.ms - b.ms);\n" +
"\n" +
"    const HEADER = 'qld_time,log_time,exchange,symbol,price,usd_value,side,event_time';\n" +
"    const out = [HEADER];\n" +
"    for (const r of rows) out.push(qldStr(r.ms) + ',' + r.line);\n" +
"    res.type('text/csv').send(out.join('\\n') + '\\n');\n" +
"  } catch (err) {\n" +
"    res.status(500).json({ error: err.message });\n" +
"  }\n" +
"});\n";

s = s.slice(0, i + anchor.length) + insert + s.slice(i + anchor.length);
fs.writeFileSync(F, s);
console.log('OK: inserted /api/liquidations');
