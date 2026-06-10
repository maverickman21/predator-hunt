/**
 * PREDATOR REGIME ENGINE v1.1
 * 
 * Processes pillar scans and determines regime state (LONG / SHORT / FLAT)
 * using the paired filter framework:
 * 
 * PAIR 1 — OI Combo:
 *   H1 consecutive direction (3 scans same direction = "get ready")
 *   H4 gate (crosses zero threshold = "go")
 * 
 * PAIR 2 — Liquidation Combo:
 *   Liq % extreme (>85 or <15 = "get ready")
 *   Liq volume magnitude of change ("go")
 * 
 * KILL SWITCH — ETH/NQ correlation
 * 
 * v1.1 CHANGES:
 *   - State now persists across process restarts via regime_state.json
 *   - loadState() restores regime and regime_mode on module init
 *   - 2-hour staleness threshold prevents restoring outdated state
 *   - Buffers (scan_buffer, h1_values, h4_values, liq_vol_values, liq_pct_values,
 *     correlation deltas) also persist to avoid losing pillar context across restarts
 * 
 * Usage:
 *   const engine = require('./predator-regime-engine');
 *   
 *   // Call after each pillar scan:
 *   const result = engine.processScan({
 *     timestamp, eth_price, nq_price, 
 *     oi_h1_change, oi_h4_change,
 *     liq_long_pct, liq_total_1h,
 *     funding_rate, ls_long_pct, yellow_count
 *   });
 */

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Pair 1: OI thresholds
  h4_gate_long: -0.2,        // H4 must be >= this for LONG
  h4_gate_short: 0.5,        // H4 must be <= this for SHORT
  consecutive_scans: 3,       // scans in same direction to confirm

  // Pair 2: Liquidation thresholds
  liq_extreme_high: 85,       // liq_long_pct above this = longs exhausted
  liq_extreme_low: 15,        // liq_long_pct below this = shorts exhausted
  vol_magnitude_threshold: 0.5, // absolute change in liq_vol over 3 scans

  // Kill switch: correlation
  corr_window: 10,            // rolling window for ETH/NQ correlation
  corr_threshold: 0.5,        // must be above this to trade

  // State persistence
  state_stale_threshold_ms: 2 * 60 * 60 * 1000, // 2 hours — beyond this, don't restore

  // History
  history_file: path.join(__dirname, 'regime_history.json'),
  state_file: path.join(__dirname, 'regime_state.json'),
  buffers_file: path.join(__dirname, 'regime_buffers.json'),
};

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

const state = {
  regime: 'FLAT',
  regime_since: null,
  regime_mode: 'seeking',   // 'seeking' = looking for entry, 'holding' = in active regime

  // Raw scan history (rolling buffer)
  scan_buffer: [],          // last N scans for ROC calculations
  max_buffer: 20,

  // Pair 1: OI tracking
  pair1: {
    h1_values: [],          // last N h1 values
    h1_deltas: [],          // delta between consecutive h1 values
    h1_consecutive: 0,      // +N = improving N scans, -N = deteriorating
    h1_direction: 'neutral',// improving, deteriorating, neutral
    h4_current: 0,
    h4_gate: 'closed',      // open_long, open_short, closed
    h4_deltas: [],          // delta between consecutive h4 values
    h4_consecutive: 0,
    h4_direction: 'neutral',
    ready: false,
    go: false,
  },

  // Pair 2: Liquidation tracking  
  pair2: {
    liq_pct: 0,
    liq_extreme: false,
    liq_extreme_side: null,  // 'long_exhausted' (>85) or 'short_exhausted' (<15)
    liq_vol: 0,
    liq_vol_values: [],
    liq_vol_magnitude: 0,   // absolute change over 3 scans
    liq_pct_values: [],
    liq_pct_magnitude: 0,   // absolute change over 3 scans
    ready: false,
    go: false,
  },

  // Kill switch: correlation
  correlation: {
    eth_deltas: [],
    nq_deltas: [],
    synced: 0,
    total: 0,
    ratio: 0,
    ok: false,
  },

  // Latest prices
  eth_price: 0,
  nq_price: 0,
  funding_rate: 0,
  ls_long_pct: 0,
  yellow_count: 0,
  timestamp: null,
};

// History log
let history = {
  regime_changes: [],
  base_events: [],
  eth_events: [],
};

// ═══════════════════════════════════════════════════════════════
// LOAD PERSISTED STATE ON STARTUP
// ═══════════════════════════════════════════════════════════════

function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.history_file)) {
      history = JSON.parse(fs.readFileSync(CONFIG.history_file, 'utf8'));
      console.log(`[REGIME] Loaded ${history.regime_changes.length} regime changes from history`);
    }
  } catch (err) {
    console.error('[REGIME] Error loading history:', err.message);
    history = { regime_changes: [], base_events: [], eth_events: [] };
  }
}

/**
 * Restore regime state from disk on module init.
 * If the saved state is older than the staleness threshold, starts fresh instead
 * (avoids restoring an outdated regime after an extended outage).
 */
function loadState() {
  try {
    if (!fs.existsSync(CONFIG.state_file)) {
      console.log('[REGIME] No saved state file — starting fresh FLAT');
      return;
    }

    const saved = JSON.parse(fs.readFileSync(CONFIG.state_file, 'utf8'));
    if (!saved.regime) {
      console.log('[REGIME] State file missing regime field — starting fresh FLAT');
      return;
    }

    // Staleness check: don't restore state that's older than the threshold
    const referenceTime = saved.timestamp || saved.regime_since;
    if (referenceTime) {
      const age = Date.now() - new Date(referenceTime).getTime();
      if (age > CONFIG.state_stale_threshold_ms) {
        const ageMin = Math.round(age / 60000);
        console.log(`[REGIME] State on disk is ${ageMin} minutes old (threshold ${CONFIG.state_stale_threshold_ms / 60000}min) — starting fresh FLAT`);
        return;
      }
    }

    // Restore regime and mode
    state.regime = saved.regime;
    state.regime_since = saved.regime_since;
    state.regime_mode = (saved.regime === 'LONG' || saved.regime === 'SHORT')
      ? 'holding'
      : 'seeking';

    // Restore latest context values if available
    if (saved.prices) {
      state.eth_price = saved.prices.eth || 0;
      state.nq_price = saved.prices.nq || 0;
    }
    if (saved.context) {
      state.funding_rate = saved.context.funding || 0;
      state.ls_long_pct = saved.context.ls_long || 0;
      state.yellow_count = saved.context.yellows || 0;
    }
    if (saved.timestamp) state.timestamp = saved.timestamp;

    console.log(`[REGIME] Restored state from disk: ${state.regime} (${state.regime_mode}) since ${state.regime_since}`);
  } catch (err) {
    console.error('[REGIME] Error loading state:', err.message);
  }
}

/**
 * Load pillar buffers (scan history, OI tracking, liquidation values, correlation deltas).
 * Without this, restart clears all rolling-window data and the engine needs to re-warm up.
 */
function loadBuffers() {
  try {
    if (!fs.existsSync(CONFIG.buffers_file)) {
      console.log('[REGIME] No saved buffers file — buffers will rebuild from live scans');
      return;
    }

    const saved = JSON.parse(fs.readFileSync(CONFIG.buffers_file, 'utf8'));

    // Staleness check mirrors loadState
    if (saved.saved_at) {
      const age = Date.now() - new Date(saved.saved_at).getTime();
      if (age > CONFIG.state_stale_threshold_ms) {
        console.log('[REGIME] Saved buffers too old — buffers will rebuild from live scans');
        return;
      }
    }

    if (Array.isArray(saved.scan_buffer)) state.scan_buffer = saved.scan_buffer;
    if (saved.pair1) {
      state.pair1.h1_values = saved.pair1.h1_values || [];
      state.pair1.h1_deltas = saved.pair1.h1_deltas || [];
      state.pair1.h1_consecutive = saved.pair1.h1_consecutive || 0;
      state.pair1.h1_direction = saved.pair1.h1_direction || 'neutral';
      state.pair1.h4_current = saved.pair1.h4_current || 0;
      state.pair1.h4_gate = saved.pair1.h4_gate || 'closed';
      state.pair1.h4_deltas = saved.pair1.h4_deltas || [];
      state.pair1.h4_consecutive = saved.pair1.h4_consecutive || 0;
      state.pair1.h4_direction = saved.pair1.h4_direction || 'neutral';
    }
    if (saved.pair2) {
      state.pair2.liq_vol_values = saved.pair2.liq_vol_values || [];
      state.pair2.liq_pct_values = saved.pair2.liq_pct_values || [];
    }
    if (saved.correlation) {
      state.correlation.eth_deltas = saved.correlation.eth_deltas || [];
      state.correlation.nq_deltas = saved.correlation.nq_deltas || [];
    }

    console.log(`[REGIME] Restored buffers: scan_buffer=${state.scan_buffer.length}, h1=${state.pair1.h1_values.length}, h4_deltas=${state.pair1.h4_deltas.length}, liq_vol=${state.pair2.liq_vol_values.length}, corr=${state.correlation.eth_deltas.length}`);
  } catch (err) {
    console.error('[REGIME] Error loading buffers:', err.message);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(CONFIG.history_file, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[REGIME] Error saving history:', err.message);
  }
}

function saveCurrentState() {
  try {
    const output = buildCurrentState();
    fs.writeFileSync(CONFIG.state_file, JSON.stringify(output, null, 2));
  } catch (err) {
    console.error('[REGIME] Error saving state:', err.message);
  }
}

/**
 * Save buffers to disk so they survive a restart.
 * Called alongside saveCurrentState on each processScan.
 */
function saveBuffers() {
  try {
    const snapshot = {
      saved_at: new Date().toISOString(),
      scan_buffer: state.scan_buffer,
      pair1: {
        h1_values: state.pair1.h1_values,
        h1_deltas: state.pair1.h1_deltas,
        h1_consecutive: state.pair1.h1_consecutive,
        h1_direction: state.pair1.h1_direction,
        h4_current: state.pair1.h4_current,
        h4_gate: state.pair1.h4_gate,
        h4_deltas: state.pair1.h4_deltas,
        h4_consecutive: state.pair1.h4_consecutive,
        h4_direction: state.pair1.h4_direction,
      },
      pair2: {
        liq_vol_values: state.pair2.liq_vol_values,
        liq_pct_values: state.pair2.liq_pct_values,
      },
      correlation: {
        eth_deltas: state.correlation.eth_deltas,
        nq_deltas: state.correlation.nq_deltas,
      },
    };
    fs.writeFileSync(CONFIG.buffers_file, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error('[REGIME] Error saving buffers:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CORE: PROCESS A PILLAR SCAN
// ═══════════════════════════════════════════════════════════════

function processScan(scan) {
  const {
    timestamp, eth_price, nq_price,
    oi_h1_change, oi_h4_change,
    liq_long_pct, liq_total_1h,
    funding_rate, ls_long_pct, yellow_count
  } = scan;

  // Update latest values
  state.timestamp = timestamp;
  state.eth_price = eth_price;
  state.nq_price = nq_price;
  state.funding_rate = funding_rate;
  state.ls_long_pct = ls_long_pct;
  state.yellow_count = yellow_count;

  // Add to buffer
  state.scan_buffer.push(scan);
  if (state.scan_buffer.length > state.max_buffer) {
    state.scan_buffer.shift();
  }

  // ─── PAIR 1: OI Combo ─────────────────────────────────────
  updateOI(oi_h1_change, oi_h4_change);

  // ─── PAIR 2: Liquidation Combo ─────────────────────────────
  updateLiquidation(liq_long_pct, liq_total_1h);

  // ─── KILL SWITCH: Correlation ──────────────────────────────
  updateCorrelation(eth_price, nq_price);

  // ─── REGIME DECISION ───────────────────────────────────────
  const previousRegime = state.regime;
  evaluateRegime();

  // Log regime change
  if (state.regime !== previousRegime) {
    const change = {
      timestamp,
      from: previousRegime,
      to: state.regime,
      h4: oi_h4_change,
      h1: oi_h1_change,
      h1_consecutive: state.pair1.h1_consecutive,
      h4_consecutive: state.pair1.h4_consecutive,
      liq_pct: liq_long_pct,
      liq_vol: liq_total_1h,
      liq_vol_magnitude: state.pair2.liq_vol_magnitude,
      liq_pct_magnitude: state.pair2.liq_pct_magnitude,
      funding: funding_rate,
      correlation: state.correlation.ratio,
      macro_bias: state.macroBias ? state.macroBias.bias : 'UNKNOWN',
      eth_price,
      nq_price,
    };
    history.regime_changes.push(change);
    state.regime_since = timestamp;
    saveHistory();

    console.log(`\n[REGIME] ═══ REGIME CHANGE: ${previousRegime} → ${state.regime} (${state.regime_mode}) ═══`);
    console.log(`[REGIME]   H4=${oi_h4_change.toFixed(2)} H1=${oi_h1_change.toFixed(2)} LiqL=${liq_long_pct.toFixed(1)}% Vol=$${liq_total_1h.toFixed(3)}M Corr=${(state.correlation.ratio * 100).toFixed(0)}%`);
    console.log(`[REGIME]   Macro=${state.macroBias ? state.macroBias.bias : 'UNKNOWN'} | ETH=${eth_price.toFixed(2)} NQ=${nq_price}\n`);
  }

  // Save current state + buffers to file for API + restart persistence
  saveCurrentState();
  saveBuffers();

  return buildCurrentState();
}

// ═══════════════════════════════════════════════════════════════
// PAIR 1: OI TRACKING
// ═══════════════════════════════════════════════════════════════

function updateOI(h1, h4) {
  // ─── H1: Track consecutive direction ───
  state.pair1.h1_values.push(h1);
  if (state.pair1.h1_values.length > 10) state.pair1.h1_values.shift();

  if (state.pair1.h1_values.length >= 2) {
    const prev = state.pair1.h1_values[state.pair1.h1_values.length - 2];
    const delta = h1 - prev;
    state.pair1.h1_deltas.push(delta);
    if (state.pair1.h1_deltas.length > 10) state.pair1.h1_deltas.shift();

    // Count consecutive same-direction deltas
    const deltas = state.pair1.h1_deltas;
    let consecutive = 0;
    if (deltas.length >= 1) {
      const lastSign = deltas[deltas.length - 1] >= 0 ? 1 : -1;
      for (let i = deltas.length - 1; i >= 0; i--) {
        const sign = deltas[i] >= 0 ? 1 : -1;
        if (sign === lastSign) {
          consecutive += lastSign;
        } else {
          break;
        }
      }
    }
    state.pair1.h1_consecutive = consecutive;
    state.pair1.h1_direction = consecutive >= CONFIG.consecutive_scans ? 'improving'
      : consecutive <= -CONFIG.consecutive_scans ? 'deteriorating'
        : 'neutral';
  }

  // ─── H4: Track gate and consecutive direction ───
  const prevH4 = state.pair1.h4_current;
  state.pair1.h4_current = h4;

  // Gate check
  if (h4 >= CONFIG.h4_gate_long) {
    state.pair1.h4_gate = 'open_long';
  } else if (h4 <= CONFIG.h4_gate_short) {
    state.pair1.h4_gate = 'open_short';
  } else {
    state.pair1.h4_gate = 'closed';
  }

  // H4 consecutive direction tracking
  state.pair1.h4_deltas = state.pair1.h4_deltas || [];
  if (prevH4 !== 0 || state.pair1.h4_deltas.length > 0) {
    const delta = h4 - prevH4;
    state.pair1.h4_deltas.push(delta);
    if (state.pair1.h4_deltas.length > 10) state.pair1.h4_deltas.shift();

    const deltas = state.pair1.h4_deltas;
    let consecutive = 0;
    if (deltas.length >= 1) {
      const lastSign = deltas[deltas.length - 1] >= 0 ? 1 : -1;
      for (let i = deltas.length - 1; i >= 0; i--) {
        const sign = deltas[i] >= 0 ? 1 : -1;
        if (sign === lastSign) {
          consecutive += lastSign;
        } else {
          break;
        }
      }
    }
    state.pair1.h4_consecutive = consecutive;
    state.pair1.h4_direction = consecutive >= CONFIG.consecutive_scans ? 'improving'
      : consecutive <= -CONFIG.consecutive_scans ? 'deteriorating'
        : 'neutral';
  }

  // ─── Pair 1 status ───
  // "Get ready" = H1 consecutive direction confirmed (3+ scans)
  // "Go" = H4 gate open
  state.pair1.ready = Math.abs(state.pair1.h1_consecutive) >= CONFIG.consecutive_scans;
  state.pair1.go = state.pair1.h4_gate !== 'closed';
}

// ═══════════════════════════════════════════════════════════════
// PAIR 2: LIQUIDATION TRACKING
// ═══════════════════════════════════════════════════════════════

function updateLiquidation(liq_pct, liq_vol) {
  state.pair2.liq_pct = liq_pct;
  state.pair2.liq_vol = liq_vol;

  // Track liq % values
  state.pair2.liq_pct_values.push(liq_pct);
  if (state.pair2.liq_pct_values.length > 10) state.pair2.liq_pct_values.shift();

  // Track liq vol values
  state.pair2.liq_vol_values.push(liq_vol);
  if (state.pair2.liq_vol_values.length > 10) state.pair2.liq_vol_values.shift();

  // Extreme check
  state.pair2.liq_extreme = liq_pct >= CONFIG.liq_extreme_high || liq_pct <= CONFIG.liq_extreme_low;
  state.pair2.liq_extreme_side = liq_pct >= CONFIG.liq_extreme_high ? 'long_exhausted'
    : liq_pct <= CONFIG.liq_extreme_low ? 'short_exhausted'
      : null;

  // Magnitude of change over 3 scans (absolute value)
  const pctVals = state.pair2.liq_pct_values;
  if (pctVals.length >= 4) {
    state.pair2.liq_pct_magnitude = Math.abs(pctVals[pctVals.length - 1] - pctVals[pctVals.length - 4]);
  }

  const volVals = state.pair2.liq_vol_values;
  if (volVals.length >= 4) {
    state.pair2.liq_vol_magnitude = Math.abs(volVals[volVals.length - 1] - volVals[volVals.length - 4]);
  }

  // "Get ready" = liq % at extreme OR was at extreme within last 10 scans
  const wasExtreme = pctVals.some(v => v >= CONFIG.liq_extreme_high || v <= CONFIG.liq_extreme_low);
  state.pair2.ready = wasExtreme;

  // "Go" = volume magnitude significant
  state.pair2.go = state.pair2.liq_vol_magnitude >= CONFIG.vol_magnitude_threshold;
}

// ═══════════════════════════════════════════════════════════════
// KILL SWITCH: ETH/NQ CORRELATION
// ═══════════════════════════════════════════════════════════════

function updateCorrelation(eth_price, nq_price) {
  // Track price deltas
  const buffer = state.scan_buffer;
  if (buffer.length < 6) {
    state.correlation.ok = false;
    return;
  }

  // Calculate 5-scan deltas
  const current = buffer[buffer.length - 1];
  const prev5 = buffer[buffer.length - 6];
  const eth_delta = current.eth_price - prev5.eth_price;
  const nq_delta = current.nq_price - prev5.nq_price;

  state.correlation.eth_deltas.push(eth_delta);
  state.correlation.nq_deltas.push(nq_delta);
  if (state.correlation.eth_deltas.length > CONFIG.corr_window) {
    state.correlation.eth_deltas.shift();
    state.correlation.nq_deltas.shift();
  }

  // Count synced vs total
  let synced = 0;
  let total = 0;
  for (let i = 0; i < state.correlation.eth_deltas.length; i++) {
    const e = state.correlation.eth_deltas[i];
    const n = state.correlation.nq_deltas[i];
    if (e !== 0 && n !== 0) {
      total++;
      if ((e > 0 && n > 0) || (e < 0 && n < 0)) {
        synced++;
      }
    }
  }

  state.correlation.synced = synced;
  state.correlation.total = total;
  state.correlation.ratio = total > 0 ? synced / total : 0;
  state.correlation.ok = state.correlation.ratio >= CONFIG.corr_threshold;
}

// ═══════════════════════════════════════════════════════════════
// MACRO BIAS — reads macro_bias.json from Claude Macro Bot
// ═══════════════════════════════════════════════════════════════

const MACRO_BIAS_FILE = path.join(__dirname, 'macro_bias.json');

function getMacroBias() {
  try {
    if (fs.existsSync(MACRO_BIAS_FILE)) {
      const data = JSON.parse(fs.readFileSync(MACRO_BIAS_FILE, 'utf8'));
      // Check if bias is stale (older than 4 hours = fail safe to allow all)
      const age = Date.now() - new Date(data.timestamp).getTime();
      if (age > 4 * 60 * 60 * 1000) {
        return { bias: 'UNKNOWN', reason: 'Macro bias stale (>4hrs)', confidence: 'LOW' };
      }
      return {
        bias: data.bias || 'UNKNOWN',
        reason: data.summary || '',
        confidence: data.confidence || 'UNKNOWN',
      };
    }
  } catch (e) { }
  return { bias: 'UNKNOWN', reason: 'No macro bias file', confidence: 'LOW' };
}

// ═══════════════════════════════════════════════════════════════
// REGIME DECISION — MACRO FILTER + SIMPLIFIED HOLD
//
// ENTRY MODE ('seeking'): All 5 conditions + macro alignment
//   - H4 gate open + H1 consecutive + Liq extreme + Liq vol spike + Correlation
//   - Macro bias must align: LONG regime only fires if macro is LONG or UNKNOWN
//   - SHORT regime only fires if macro is SHORT or UNKNOWN
//   - SIDELINES macro = nothing fires
//
// HOLD MODE ('holding'): NO hold conditions checked
//   - Regime holds until OPPOSITE regime fires with full 5 conditions
//   - No H4 check, no correlation check, no liq vol check
//   - The entry was the conviction. Only opposite conviction exits.
//
// EXIT: ONLY opposite regime fires (full entry conditions + macro aligned)
// Stop loss is handled externally by NinjaTrader/Markers Plus
// ═══════════════════════════════════════════════════════════════

function evaluateRegime() {
  const { pair1, pair2, correlation } = state;

  // ─── READ MACRO BIAS ───
  const macro = getMacroBias();
  state.macroBias = macro;

  // ─── ENTRY CONDITIONS (all 5 required to fire) ───
  const longEntry = {
    pair1_ready: pair1.h1_consecutive >= CONFIG.consecutive_scans || pair1.h4_consecutive >= CONFIG.consecutive_scans,
    pair1_go: pair1.h4_gate === 'open_long',
    pair2_ready: pair2.ready && (pair2.liq_extreme_side === 'long_exhausted' ||
      state.pair2.liq_pct_values.some(v => v >= CONFIG.liq_extreme_high)),
    pair2_go: pair2.liq_vol_magnitude >= CONFIG.vol_magnitude_threshold || pair2.liq_pct_magnitude >= 20,
    corr_ok: correlation.ok,
  };

  const shortEntry = {
    pair1_ready: pair1.h1_consecutive <= -CONFIG.consecutive_scans || pair1.h4_consecutive <= -CONFIG.consecutive_scans,
    pair1_go: pair1.h4_gate === 'open_short',
    pair2_ready: pair2.ready && (pair2.liq_extreme_side === 'short_exhausted' ||
      state.pair2.liq_pct_values.some(v => v <= CONFIG.liq_extreme_low)),
    pair2_go: pair2.liq_vol_magnitude >= CONFIG.vol_magnitude_threshold || pair2.liq_pct_magnitude >= 20,
    corr_ok: correlation.ok,
  };

  const allLongEntry = Object.values(longEntry).every(v => v);
  const allShortEntry = Object.values(shortEntry).every(v => v);

  // ─── MACRO FILTER: check if direction aligns with macro bias ───
  // LONG regime only allowed if macro is LONG or UNKNOWN (fail safe)
  // SHORT regime only allowed if macro is SHORT or UNKNOWN (fail safe)
  // SIDELINES macro = nothing fires
  const longAllowedByMacro = macro.bias === 'LONG' || macro.bias === 'UNKNOWN' || macro.bias === 'SIDELINES';
  const shortAllowedByMacro = macro.bias === 'SHORT' || macro.bias === 'UNKNOWN';

  if (state.regime_mode === 'seeking') {
    // ─── SEEKING: need full entry conditions + macro alignment ───
    if (allLongEntry && !allShortEntry && longAllowedByMacro) {
      state.regime = 'LONG';
      state.regime_mode = 'holding';
    } else if (allShortEntry && !allLongEntry && shortAllowedByMacro) {
      state.regime = 'SHORT';
      state.regime_mode = 'holding';
    } else if (allLongEntry && !longAllowedByMacro) {
      // Log blocked regime
      console.log(`[REGIME] ⛔ LONG blocked by macro (macro=${macro.bias})`);
    } else if (allShortEntry && !shortAllowedByMacro) {
      console.log(`[REGIME] ⛔ SHORT blocked by macro (macro=${macro.bias})`);
    }
    // Stay FLAT if no entry conditions met
  } else {
    // ─── HOLDING: only exit on opposite regime ───
    // NO hold conditions checked. Regime holds until opposite fires.
    if (state.regime === 'LONG') {
      if (allShortEntry && shortAllowedByMacro) {
        state.regime = 'SHORT';
        // Stay in holding mode — switched direction
      }
      // Otherwise hold LONG — no FLAT exit
    } else if (state.regime === 'SHORT') {
      if (allLongEntry && longAllowedByMacro) {
        state.regime = 'LONG';
        // Stay in holding mode — switched direction
      }
      // Otherwise hold SHORT — no FLAT exit
    }
  }

  // Store condition details for API
  state.longConditions = longEntry;
  state.shortConditions = shortEntry;
  state.longConditions.macro_allowed = longAllowedByMacro;
  state.shortConditions.macro_allowed = shortAllowedByMacro;
}

// ═══════════════════════════════════════════════════════════════
// BASE/ETH SCANNER EVENTS
// ═══════════════════════════════════════════════════════════════

function processBaseCluster(event) {
  // event: { timestamp, pairs, signals, eth_price, eth_delta, direction, nq_price }
  const entry = {
    ...event,
    scanner: 'base',
    regime: state.regime,
  };
  history.base_events.push(entry);

  // Keep last 500 events
  if (history.base_events.length > 500) {
    history.base_events = history.base_events.slice(-500);
  }
  saveHistory();
  saveCurrentState();
  return entry;
}

function processEthCluster(event) {
  const entry = {
    ...event,
    scanner: 'eth',
    regime: state.regime,
  };
  history.eth_events.push(entry);
  if (history.eth_events.length > 500) {
    history.eth_events = history.eth_events.slice(-500);
  }
  saveHistory();
  saveCurrentState();
  return entry;
}

// Black-to-yellow tracking for simple entry mode
let baseBlackBlocks = 0;
let ethBlackBlocks = 0;

function processBaseScanBlock(hasYellow) {
  if (!hasYellow) {
    baseBlackBlocks++;
    return null;
  }
  // Yellow after 5+ black blocks = entry signal
  if (baseBlackBlocks >= 5) {
    const event = {
      timestamp: new Date().toISOString(),
      type: 'black_to_yellow',
      scanner: 'base',
      black_blocks: baseBlackBlocks,
      regime: state.regime,
      eth_price: state.eth_price,
      nq_price: state.nq_price,
    };
    history.base_events.push(event);
    saveHistory();
    saveCurrentState();
    baseBlackBlocks = 0;
    return event;
  }
  baseBlackBlocks = 0;
  return null;
}

function processEthScanBlock(hasYellow) {
  if (!hasYellow) {
    ethBlackBlocks++;
    return null;
  }
  if (ethBlackBlocks >= 5) {
    const event = {
      timestamp: new Date().toISOString(),
      type: 'black_to_yellow',
      scanner: 'eth',
      black_blocks: ethBlackBlocks,
      regime: state.regime,
      eth_price: state.eth_price,
      nq_price: state.nq_price,
    };
    history.eth_events.push(event);
    saveHistory();
    saveCurrentState();
    ethBlackBlocks = 0;
    return event;
  }
  ethBlackBlocks = 0;
  return null;
}

// ═══════════════════════════════════════════════════════════════
// BUILD CURRENT STATE FOR API
// ═══════════════════════════════════════════════════════════════

function buildCurrentState() {
  return {
    timestamp: state.timestamp,
    regime: state.regime,
    regime_since: state.regime_since,

    pair1: {
      h1_current: state.pair1.h1_values.length > 0 ? state.pair1.h1_values[state.pair1.h1_values.length - 1] : 0,
      h1_consecutive: state.pair1.h1_consecutive,
      h1_direction: state.pair1.h1_direction,
      h4_current: state.pair1.h4_current,
      h4_gate: state.pair1.h4_gate,
      h4_consecutive: state.pair1.h4_consecutive,
      h4_direction: state.pair1.h4_direction,
      ready: state.pair1.ready,
      go: state.pair1.go,
    },

    pair2: {
      liq_pct: state.pair2.liq_pct,
      liq_extreme: state.pair2.liq_extreme,
      liq_extreme_side: state.pair2.liq_extreme_side,
      liq_vol: state.pair2.liq_vol,
      liq_vol_magnitude: state.pair2.liq_vol_magnitude,
      liq_pct_magnitude: state.pair2.liq_pct_magnitude,
      ready: state.pair2.ready,
      go: state.pair2.go,
    },

    correlation: {
      synced: state.correlation.synced,
      total: state.correlation.total,
      ratio: state.correlation.ratio,
      ok: state.correlation.ok,
    },

    conditions: {
      long: state.longConditions || {},
      short: state.shortConditions || {},
      mode: state.regime_mode,
    },

    macro: state.macroBias || { bias: 'UNKNOWN', reason: '', confidence: 'LOW' },

    prices: {
      eth: state.eth_price,
      nq: state.nq_price,
    },

    context: {
      funding: state.funding_rate,
      ls_long: state.ls_long_pct,
      yellows: state.yellow_count,
    },

    base_scanner: {
      black_blocks: baseBlackBlocks,
    },
    eth_scanner: {
      black_blocks: ethBlackBlocks,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// MANUAL CONTROLS
// ═══════════════════════════════════════════════════════════════

function resetRegime() {
  state.regime = 'FLAT';
  state.regime_mode = 'seeking';
  state.regime_since = new Date().toISOString();
  saveCurrentState();
  console.log('[REGIME] Manual reset to FLAT (seeking mode)');
}

function getHistory(fromTimestamp) {
  if (!fromTimestamp) return history;

  const from = new Date(fromTimestamp).getTime();
  return {
    regime_changes: history.regime_changes.filter(r => new Date(r.timestamp).getTime() >= from),
    base_events: history.base_events.filter(r => new Date(r.timestamp).getTime() >= from),
    eth_events: history.eth_events.filter(r => new Date(r.timestamp).getTime() >= from),
  };
}

// ═══════════════════════════════════════════════════════════════
// INITIALISE
// ═══════════════════════════════════════════════════════════════

loadHistory();
loadState();
loadBuffers();

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  processScan,
  processBaseCluster,
  processEthCluster,
  processBaseScanBlock,
  processEthScanBlock,
  buildCurrentState,
  getHistory,
  resetRegime,
  CONFIG,
};