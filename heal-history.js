// heal-history.js
// One-shot utility to reconcile regime_state.json with regime_history.json
// If the current regime is active (LONG/SHORT) but no matching history entry
// exists for its regime_since timestamp, append a recovery entry.

const fs = require('fs');

const HISTORY_FILE = '/root/predator-hunt/regime_history.json';
const STATE_FILE = '/root/predator-hunt/regime_state.json';

try {
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    if (!state.regime || state.regime === 'FLAT') {
        console.log('State regime is FLAT or missing — nothing to heal');
        process.exit(0);
    }

    if (!state.regime_since) {
        console.log('State has no regime_since timestamp — nothing to heal');
        process.exit(0);
    }

    // Check if an entry for this exact regime_since already exists
    const exists = history.regime_changes.some(
        r => r.timestamp === state.regime_since && r.to === state.regime
    );

    if (exists) {
        console.log(`Entry for ${state.regime} at ${state.regime_since} already exists — nothing to heal`);
        process.exit(0);
    }

    const lastChange = history.regime_changes[history.regime_changes.length - 1];
    const fromRegime = lastChange ? (lastChange.to || 'FLAT') : 'FLAT';

    const recoveryEntry = {
        timestamp: state.regime_since,
        from: fromRegime,
        to: state.regime,
        h4: state.pair1 ? (state.pair1.h4_current || 0) : 0,
        h1: state.pair1 ? (state.pair1.h1_current || 0) : 0,
        h1_consecutive: state.pair1 ? (state.pair1.h1_consecutive || 0) : 0,
        h4_consecutive: state.pair1 ? (state.pair1.h4_consecutive || 0) : 0,
        liq_pct: state.pair2 ? (state.pair2.liq_pct || 0) : 0,
        liq_vol: state.pair2 ? (state.pair2.liq_vol || 0) : 0,
        liq_vol_magnitude: state.pair2 ? (state.pair2.liq_vol_magnitude || 0) : 0,
        liq_pct_magnitude: state.pair2 ? (state.pair2.liq_pct_magnitude || 0) : 0,
        funding: state.context ? (state.context.funding || 0) : 0,
        correlation: state.correlation ? (state.correlation.ratio || 0) : 0,
        macro_bias: state.macro ? state.macro.bias : 'UNKNOWN',
        eth_price: state.prices ? (state.prices.eth || 0) : 0,
        nq_price: state.prices ? (state.prices.nq || 0) : 0,
        recovery: true,
    };

    // Insert in chronological order (in case there are newer entries)
    const recoveryTime = new Date(state.regime_since).getTime();
    let insertIndex = history.regime_changes.length;
    for (let i = 0; i < history.regime_changes.length; i++) {
        const entryTime = new Date(history.regime_changes[i].timestamp).getTime();
        if (entryTime > recoveryTime) {
            insertIndex = i;
            break;
        }
    }
    history.regime_changes.splice(insertIndex, 0, recoveryEntry);

    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`Healed: appended ${fromRegime} → ${state.regime} entry at ${state.regime_since}`);
    console.log(`Total regime changes now: ${history.regime_changes.length}`);

} catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
}