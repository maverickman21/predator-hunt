/**
 * DERIBIT CHAIN SIDECAR v1
 *
 * Snapshots the full ETH options chain from Deribit every 15 minutes and logs
 * STRIKE-LEVEL open interest + mark IV to a monthly CSV. This is the raw data
 * layer for future GEX / gamma computation (zero-gamma level, call/put walls).
 *
 * DESIGN (Option B, same as everything else):
 *   - Store the RAW chain (strike, expiry, type, OI, IV, underlying). Gamma and
 *     GEX are DERIVED VIEWS computed at read-time later, under an inspectable
 *     dealer assumption. Never bake the derived view into storage.
 *   - Only positioned strikes are stored (open_interest >= 1). Zero-OI rows
 *     contribute nothing to GEX and are ~half the chain.
 *   - qld_time at source, col 0. Monthly rollover via filename. Gap-aware:
 *     fetch failures are logged loudly, never written as fake rows.
 *   - Standalone process. Touches NOTHING else. If it dies, the pillars and
 *     sidecars are unaffected.
 *
 * CSV schema (eth_chain_v1_YYYY-MM.csv):
 *   qld_time,timestamp,underlying_price,expiry,strike,type,open_interest,mark_iv,mark_price
 *     expiry = YYMMDD (matches the options sidecar convention, e.g. 260704)
 *     type   = C or P
 *     open_interest = ETH contracts
 *     mark_iv = annualized implied vol in percent (Deribit's mark)
 *
 * Run: pm2 start deribit-chain-sidecar.js --name predator-chain
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const MIN_OI = 1;                               // skip dust / empty strikes
const URL = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=option';

const MONTHS = { JAN:'01', FEB:'02', MAR:'03', APR:'04', MAY:'05', JUN:'06',
                 JUL:'07', AUG:'08', SEP:'09', OCT:'10', NOV:'11', DEC:'12' };

function monthlyFilename() {
    const d = new Date();
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    return path.join(__dirname, 'eth_chain_v1_' + ym + '.csv');
}

const HEADER = 'qld_time,timestamp,underlying_price,expiry,strike,type,open_interest,mark_iv,mark_price\n';

function ensureCSV(file) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
}

function qldNow() {
    const d = new Date(Date.now() + 10 * 60 * 60 * 1000);   // UTC+10, no DST
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' '
         + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

// "ETH-4JUL26-1725-P" -> { expiry: "260704", strike: "1725", type: "P" }
function parseInstrument(name) {
    const parts = name.split('-');
    if (parts.length !== 4) return null;
    const m = parts[1].match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) return null;
    const mon = MONTHS[m[2]];
    if (!mon) return null;
    const expiry = m[3] + mon + String(m[1]).padStart(2, '0');   // YYMMDD
    const type = parts[3] === 'C' ? 'C' : parts[3] === 'P' ? 'P' : null;
    if (!type) return null;
    return { expiry: expiry, strike: parts[2], type: type };
}

function fetchChain() {
    return new Promise((resolve, reject) => {
        const req = https.get(URL, { timeout: 30000 }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (!json.result || !Array.isArray(json.result)) return reject(new Error('bad payload'));
                    resolve(json.result);
                } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

async function snapshot() {
    const startedQld = qldNow();
    try {
        const chain = await fetchChain();
        const ts = new Date().toISOString();
        const qld = qldNow();
        let rows = '';
        let kept = 0, skipped = 0;
        for (const inst of chain) {
            const oi = parseFloat(inst.open_interest) || 0;
            if (oi < MIN_OI) { skipped++; continue; }
            const p = parseInstrument(inst.instrument_name || '');
            if (!p) { skipped++; continue; }
            const iv = (inst.mark_iv === null || inst.mark_iv === undefined) ? '' : inst.mark_iv;
            const mp = (inst.mark_price === null || inst.mark_price === undefined) ? '' : inst.mark_price;
            const up = (inst.underlying_price === null || inst.underlying_price === undefined) ? '' : inst.underlying_price;
            rows += qld + ',' + ts + ',' + up + ',' + p.expiry + ',' + p.strike + ',' + p.type + ','
                  + oi + ',' + iv + ',' + mp + '\n';
            kept++;
        }
        if (kept === 0) {
            console.log('[CHAIN] ' + startedQld + ' WARNING: 0 positioned strikes parsed (chain size ' + chain.length + ') - nothing written');
            return;
        }
        const file = monthlyFilename();
        ensureCSV(file);
        fs.appendFileSync(file, rows);
        console.log('[CHAIN] ' + startedQld + ' snapshot: ' + kept + ' positioned strikes written (' + skipped + ' skipped) -> ' + path.basename(file));
    } catch (e) {
        // Gap-aware: a failed snapshot is a LOUD log line and an honest absence,
        // never a fake row. (CoinGlass lesson: unknown != quiet.)
        console.log('[CHAIN] ' + startedQld + ' FETCH FAILED: ' + e.message + ' - snapshot skipped (gap)');
    }
}

console.log('[CHAIN] Deribit chain sidecar starting - every ' + (SNAPSHOT_INTERVAL_MS / 60000) + ' min, OI >= ' + MIN_OI + ' only');
snapshot();                                  // one immediately on start
setInterval(snapshot, SNAPSHOT_INTERVAL_MS); // then every 15 min
