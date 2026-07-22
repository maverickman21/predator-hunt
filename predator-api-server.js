/**
 * PREDATOR REGIME API v1.0
 * 
 * REST API server that serves regime state and history.
 * NinjaTrader polls this every minute.
 * 
 * Endpoints:
 *   GET /api/current     — current regime state + filter details
 *   GET /api/history     — all regime changes + scanner events
 *   GET /api/history?from=2026-04-10T00:00  — filtered by time
 *   GET /api/health      — server health check
 *   POST /api/reset      — manual regime reset to FLAT
 * 
 * Run with: pm2 start predator-api-server.js --name predator-api
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const digest = require('./predator-digest');   // DIGEST v1 (constitution 2026-07-19)

const app = express();
const PORT = process.env.API_PORT || 3000;

// State and history files (written by regime engine)
const STATE_FILE = path.join(__dirname, 'regime_state.json');
const HISTORY_FILE = path.join(__dirname, 'regime_history.json');
const NQ_PRICE_FILE = path.join(__dirname, 'nq_price.json');

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/current
 * Returns the current regime state.
 * NinjaTrader polls this every minute.
 */
app.get('/api/current', (req, res) => {
  if (req.query.nq) {
    const nqPrice = parseFloat(req.query.nq);
    if (nqPrice > 0) {
      fs.writeFileSync(NQ_PRICE_FILE, JSON.stringify({ price: nqPrice, time: new Date().toISOString() }));
    }
  }
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return res.json({
                regime: 'FLAT',
                error: 'No state file yet — engine not running',
                timestamp: new Date().toISOString(),
            });
        }
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        res.json(state);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/history
 * Returns regime changes and scanner events.
 * Optional: ?from=ISO_TIMESTAMP to filter
 * Optional: ?type=regime|base|eth to filter by event type
 */
app.get('/api/history', (req, res) => {
    try {
        if (!fs.existsSync(HISTORY_FILE)) {
            return res.json({
                regime_changes: [],
                base_events: [],
                eth_events: [],
            });
        }

        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        const from = req.query.from ? new Date(req.query.from).getTime() : 0;
        const type = req.query.type; // optional filter

        const result = {};

        if (!type || type === 'regime') {
            result.regime_changes = history.regime_changes
                .filter(r => new Date(r.timestamp).getTime() >= from);
        }

        if (!type || type === 'base') {
            result.base_events = (history.base_events || [])
                .filter(r => new Date(r.timestamp).getTime() >= from);
        }

        if (!type || type === 'eth') {
            result.eth_events = (history.eth_events || [])
                .filter(r => new Date(r.timestamp).getTime() >= from);
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/health
 * Quick health check
 */
app.get('/api/health', (req, res) => {
    let stateAge = null;
    try {
        if (fs.existsSync(STATE_FILE)) {
            const stat = fs.statSync(STATE_FILE);
            stateAge = Math.round((Date.now() - stat.mtimeMs) / 1000);
        }
    } catch (e) { /* ignore */ }

    res.json({
        status: 'ok',
        uptime: process.uptime(),
        state_file_age_seconds: stateAge,
        state_file_stale: stateAge !== null && stateAge > 120, // warn if >2 min old
    });
});

/**
 * POST /api/reset
 * Manual regime reset to FLAT
 */
app.post('/api/reset', (req, res) => {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            state.regime = 'FLAT';
            state.regime_since = new Date().toISOString();
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }
        res.json({ success: true, regime: 'FLAT' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[PREDATOR API] Running on port ${PORT}`);
    console.log(`[PREDATOR API] Endpoints:`);
    console.log(`  GET  http://137.184.36.230:${PORT}/api/current`);
    console.log(`  GET  http://137.184.36.230:${PORT}/api/history`);
    console.log(`  GET  http://137.184.36.230:${PORT}/api/health`);
    console.log(`  POST http://137.184.36.230:${PORT}/api/reset`);
    console.log(`  GET  http://137.184.36.230:${PORT}/api/digest`);
});

// ---- DIGEST v1: the ratified gate/trigger/bell stack, computed every 60s ----
app.get('/api/digest', (req, res) => res.json(digest.get()));

// ---- DIGEST FIRES: the replay's fire list, for Strategy Analyzer backtests ----
app.get('/api/fires', (req, res) => {
    const f = path.join(__dirname, 'digest_fires.csv');
    if (!fs.existsSync(f)) return res.status(404).send('no digest_fires.csv - run: node predator-digest.js --replay <from> <to> --out digest_fires.csv');
    res.set('Content-Type', 'text/csv');
    res.send(fs.readFileSync(f, 'utf8'));
});
digest.start();
// Serve ETH price history for correlation indicator
app.get('/api/eth-prices', (req, res) => {
  try {
    const f = require('path').join(__dirname, 'eth_prices.json');
    if (!fs.existsSync(f)) return res.json([]);
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    res.json(data);
  } catch (err) {
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/pillars-v2  (LEGACY — frozen at v3 migration, Jun 28 2026)
// Old-schema pillar history stitched from every monthly
// eth_pillars_v2_YYYY-MM.csv on the box. Prepends a derived
// Queensland-time column (UTC+10, no DST) as col 0, so the output is
// the 19-column layout the NinjaTrader indicator already understands.
//   Optional bounds, matched against the UTC timestamp:
//   ?from=2026-06-04T00:00:00Z  ?to=2026-06-09T00:00:00Z
// ─────────────────────────────────────────────────────────────
app.get('/api/pillars-v2', (req, res) => {
  try {
    const fromMs = req.query.from ? Date.parse(req.query.from) : -Infinity;
    const toMs   = req.query.to   ? Date.parse(req.query.to)   :  Infinity;

    const QLD_OFFSET_MS = 10 * 60 * 60 * 1000;
    const pad = n => String(n).padStart(2, '0');
    const qldStr = ms => {
      const d = new Date(ms + QLD_OFFSET_MS);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
           + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    };

    const files = fs.readdirSync(__dirname)
      .filter(f => /^eth_pillars_v2_\d{4}-\d{2}\.csv$/.test(f))
      .sort();

    const seen = new Set();
    const rows = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const comma = line.indexOf(',');
        if (comma < 1) continue;
        const ms = Date.parse(line.slice(0, comma));
        if (isNaN(ms) || ms < fromMs || ms > toMs || seen.has(ms)) continue;
        seen.add(ms);
        rows.push({ ms, line });
      }
    }
    rows.sort((a, b) => a.ms - b.ms);

    const HEADER = 'qld_time,timestamp,eth_price,nq_price,yellow_count,funding_rate,'
                 + 'oi_total,oi_h1_change,oi_h4_change,vol_h1_change,ls_long_pct,ls_short_pct,'
                 + 'liq_total_1h,liq_long_pct,liq_total_4h,max_pain,max_pain_dist,pc_ratio,bias_score,'
                 + 'cvd_agg_buy,cvd_agg_sell,cvd_delta';

    const out = [HEADER];
    for (const r of rows) out.push(qldStr(r.ms) + ',' + r.line);
    res.type('text/csv').send(out.join('\n') + '\n');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// GET /api/liquidations
// Raw force-close events as ONE continuous CSV, stitched from every
// monthly eth_liquidations_v2_YYYY-MM.csv. Prepends Qld-time as col 0.
//   Optional bounds matched against log_time (UTC, col 0 of sidecar):
//   ?from=2026-06-22T00:00:00Z  ?to=2026-06-23T00:00:00Z
// NOTE: we do NOT dedupe by timestamp - a cascade fires many events in the
// same millisecond and we want them all - so we dedupe by the FULL row.
// side: 1 = LONG liquidated (force-sold) ; 2 = SHORT liquidated (force-bought)  [confirmed empirically]
// -------------------------------------------------------------
// GAMMA: dealer gamma-exposure profile per 15-min snapshot (from gamma-computer.js)
// cols: qld_time,timestamp,spot,net_gex_usd_1pct,zero_gamma,call_wall,put_wall,n_strikes
app.get('/api/gamma', (req, res) => {
    try {
        const files = fs.readdirSync(__dirname).filter(f => /^eth_gamma_v1_\d{4}-\d{2}\.csv$/.test(f)).sort();
        if (files.length === 0) return res.status(404).send('no gamma data');
        let out = '';
        for (let fi = 0; fi < files.length; fi++) {
            const lines = fs.readFileSync(path.join(__dirname, files[fi]), 'utf8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (fi > 0 && i === 0) continue;   // header once
                if (lines[i].trim()) out += lines[i] + '\n';
            }
        }
        res.set('Content-Type', 'text/csv');
        res.send(out);
    } catch (e) { res.status(500).send('error: ' + e.message); }
});

app.get('/api/liquidations', (req, res) => {
  try {
    const fromMs = req.query.from ? Date.parse(req.query.from) : -Infinity;
    const toMs   = req.query.to   ? Date.parse(req.query.to)   :  Infinity;

    const QLD_OFFSET_MS = 10 * 60 * 60 * 1000;
    const pad = n => String(n).padStart(2, '0');
    const qldStr = ms => {
      const d = new Date(ms + QLD_OFFSET_MS);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' '
           + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    };

    const files = fs.readdirSync(__dirname)
      .filter(f => /^eth_liquidations_v2_\d{4}-\d{2}\.csv$/.test(f))
      .sort();

    const seen = new Set();
    const rows = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.indexOf('log_time') === 0) continue;
        const comma = line.indexOf(',');
        if (comma < 1) continue;
        const ms = Date.parse(line.slice(0, comma));
        if (isNaN(ms) || ms < fromMs || ms > toMs) continue;
        if (seen.has(line)) continue;
        seen.add(line);
        rows.push({ ms, line });
      }
    }
    rows.sort((a, b) => a.ms - b.ms);

    const HEADER = 'qld_time,log_time,exchange,symbol,price,usd_value,side,event_time';
    const out = [HEADER];
    for (const r of rows) out.push(qldStr(r.ms) + ',' + r.line);
    res.type('text/csv').send(out.join('\n') + '\n');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// GET /api/pillars   (v3 — the live feed)
// Full v3 pillar history as ONE continuous CSV, stitched from every
// monthly eth_pillars_v3_YYYY-MM.csv. qld_time is already baked in
// at source as col 0, so no derivation here — rows pass through as-is.
// Bounds are matched against the UTC timestamp (col 1):
//   ?from=2026-07-01T00:00:00Z  ?to=2026-07-02T00:00:00Z
// Schema (16 cols):
//   qld_time,timestamp,eth_price,nq_price,yellow_count,
//   funding_open,funding_high,funding_low,funding_close,
//   oi_open,oi_high,oi_low,oi_close,
//   cvd_agg_buy,cvd_agg_sell,cvd_delta
// ─────────────────────────────────────────────────────────────
app.get('/api/pillars', (req, res) => {
  try {
    const fromMs = req.query.from ? Date.parse(req.query.from) : -Infinity;
    const toMs   = req.query.to   ? Date.parse(req.query.to)   :  Infinity;

    const files = fs.readdirSync(__dirname)
      .filter(f => /^eth_pillars_v3_\d{4}-\d{2}\.csv$/.test(f))
      .sort();

    const seen = new Set();
    const rows = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.indexOf('qld_time') === 0) continue; // per-file header
        const c1 = line.indexOf(',');
        if (c1 < 1) continue;
        const c2 = line.indexOf(',', c1 + 1);
        if (c2 < 0) continue;
        const ms = Date.parse(line.slice(c1 + 1, c2)); // UTC timestamp, col 1
        if (isNaN(ms) || ms < fromMs || ms > toMs || seen.has(ms)) continue;
        seen.add(ms);
        rows.push({ ms, line });
      }
    }
    rows.sort((a, b) => a.ms - b.ms);

    const HEADER = 'qld_time,timestamp,eth_price,nq_price,yellow_count,'
                 + 'funding_open,funding_high,funding_low,funding_close,'
                 + 'oi_open,oi_high,oi_low,oi_close,'
                 + 'cvd_agg_buy,cvd_agg_sell,cvd_delta,oi_coin_open,oi_coin_high,oi_coin_low,oi_coin_close';

    const out = [HEADER];
    for (const r of rows) out.push(r.line);
    res.type('text/csv').send(out.join('\n') + '\n');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
