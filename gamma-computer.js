/**
 * PREDATOR GAMMA COMPUTER v1
 *
 * Reads the banked Deribit chain snapshots (eth_chain_v1_YYYY-MM.csv) and computes,
 * per snapshot, the dealer gamma-exposure profile:
 *
 *   net_gex_usd_1pct : net dealer gamma in USD per 1% ETH move (sign = regime)
 *   zero_gamma       : spot level where net GEX flips sign (pin/rip boundary)
 *   call_wall        : strike with largest positive gamma contribution (+-25% of spot)
 *   put_wall         : strike with largest negative gamma contribution
 *
 * DEALER CONVENTION (inspectable, changeable): dealers LONG calls, SHORT puts
 * (customers sell calls / buy puts). GEX = sum(call gamma*OI) - sum(put gamma*OI).
 * This is the standard SqueezeMetrics-style assumption - the same one every paid
 * GEX product bakes in. It is an ASSUMPTION, not a fact; judge it by forward results.
 *
 * Black-Scholes gamma from each strike's mark IV (Deribit's own marks), r=0:
 *   d1 = [ln(S/K) + (iv^2/2)T] / (iv*sqrt(T)),  gamma = phi(d1)/(S*iv*sqrt(T))
 * ETH option contract = 1 ETH. USD gamma per 1% move = gamma * OI * S^2 * 0.01.
 *
 * Output: eth_gamma_v1_YYYY-MM.csv
 *   qld_time,timestamp,spot,net_gex_usd_1pct,zero_gamma,call_wall,put_wall,n_strikes
 *
 * Run:  node gamma-computer.js --backfill   (process every banked snapshot once)
 *       pm2 start gamma-computer.js --name predator-gamma   (then every 15 min)
 */

const fs = require('fs');
const path = require('path');

const INTERVAL_MS = 15 * 60 * 1000;
const BACKFILL = process.argv.includes('--backfill');

function qldStr(ms) {
    const d = new Date(ms + 10 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' '
         + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function gammaOf(S, K, iv, T) {
    if (S <= 0 || K <= 0 || iv <= 0 || T <= 0) return 0;
    const v = iv * Math.sqrt(T);
    const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / v;
    return Math.exp(-0.5 * d1 * d1) / (Math.SQRT2 * Math.sqrt(Math.PI) * S * v);
}

// expiry YYMMDD -> ms at 08:00 UTC
function expiryMs(yymmdd) {
    const y = 2000 + parseInt(yymmdd.slice(0, 2), 10);
    const m = parseInt(yymmdd.slice(2, 4), 10) - 1;
    const d = parseInt(yymmdd.slice(4, 6), 10);
    return Date.UTC(y, m, d, 8, 0, 0);
}

function netGexAt(S, rows, tsMs) {
    let g = 0;
    for (const r of rows) {
        const T = (r.expMs - tsMs) / (365 * 24 * 3600 * 1000);
        if (T <= 0) continue;
        const gm = gammaOf(S, r.strike, r.iv, T);
        const usd = gm * r.oi * S * S * 0.01;
        g += (r.type === 'C' ? usd : -usd);
    }
    return g;
}

function computeSnapshot(tsIso, rows) {
    const tsMs = Date.parse(tsIso);
    // spot: underlying of the nearest-expiry rows (index-adjacent)
    let spot = 0, bestT = Infinity;
    for (const r of rows) {
        const T = r.expMs - tsMs;
        if (T > 0 && T < bestT && r.underlying > 0) { bestT = T; spot = r.underlying; }
    }
    if (spot <= 0) return null;

    const live = rows.filter(r => r.expMs > tsMs && r.iv > 0 && r.oi > 0);
    if (live.length < 20) return null;

    const netGex = netGexAt(spot, live, tsMs);

    // zero-gamma: scan +-20% in 0.25% steps for sign flip nearest spot
    let zero = '';
    let prevS = spot * 0.50, prevG = netGexAt(prevS, live, tsMs);
    let bestDist = Infinity;
    for (let f = 0.5025; f <= 1.5001; f += 0.0025) {
        const s = spot * f, g = netGexAt(s, live, tsMs);
        if ((prevG < 0 && g >= 0) || (prevG > 0 && g <= 0)) {
            const cross = prevS + (s - prevS) * (Math.abs(prevG) / (Math.abs(prevG) + Math.abs(g) || 1));
            const dist = Math.abs(cross - spot);
            if (dist < bestDist) { bestDist = dist; zero = cross.toFixed(2); }
        }
        prevS = s; prevG = g;
    }

    // walls: largest +/- per-strike contribution within +-25% of spot
    const byStrike = new Map();
    for (const r of live) {
        if (Math.abs(r.strike - spot) / spot > 0.25) continue;
        const T = (r.expMs - tsMs) / (365 * 24 * 3600 * 1000);
        const usd = gammaOf(spot, r.strike, r.iv, T) * r.oi * spot * spot * 0.01;
        byStrike.set(r.strike, (byStrike.get(r.strike) || 0) + (r.type === 'C' ? usd : -usd));
    }
    let callWall = '', putWall = '', maxPos = 0, maxNeg = 0;
    for (const [k, v] of byStrike) {
        if (v > maxPos) { maxPos = v; callWall = k; }
        if (v < maxNeg) { maxNeg = v; putWall = k; }
    }

    return { spot, netGex, zero, callWall, putWall, n: live.length };
}

// STREAMING loader (rewritten 2026-08-29): the previous version read EVERY chain
// file into memory and built a Map of every snapshot's every strike row - ~3M objects,
// rebuilt from scratch every 15 minutes. That was both the boot failure and the leak.
// This version streams line-by-line, flushes each completed snapshot immediately,
// and holds only one snapshot (~600 rows) at a time. Constant memory, any archive size.
const readline = require('readline');

function chainFiles() {
    return fs.readdirSync(__dirname)
        .filter(f => /^eth_chain_v1_\d{4}-\d{2}\.csv$/.test(f)).sort();
}

async function streamSnapshots(onSnapshot, onlyRecent) {
    let files = chainFiles();
    // steady-state: only the current + previous month can hold unprocessed rows
    if (onlyRecent && files.length > 2) files = files.slice(-2);
    let banked = 0;
    for (const f of files) {
        const rl = readline.createInterface({
            input: fs.createReadStream(path.join(__dirname, f)),
            crlfDelay: Infinity
        });
        let curTs = null, rows = [];
        let first = true;
        for await (const line of rl) {
            if (first) { first = false; continue; }           // header
            if (!line) continue;
            const p = line.split(',');
            if (p.length < 9) continue;
            const ts = p[1];
            if (ts !== curTs) {
                if (curTs && rows.length) { banked++; await onSnapshot(curTs, rows); }
                curTs = ts; rows = [];
            }
            rows.push({
                underlying: parseFloat(p[2]) || 0,
                expMs: expiryMs(p[3]),
                strike: parseFloat(p[4]) || 0,
                type: p[5],
                oi: parseFloat(p[6]) || 0,
                iv: (parseFloat(p[7]) || 0) / 100,
            });
        }
        if (curTs && rows.length) { banked++; await onSnapshot(curTs, rows); }
        rows = null;
    }
    return banked;
}

function outFileFor(tsMs) {
    const d = new Date(tsMs);
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    return path.join(__dirname, 'eth_gamma_v1_' + ym + '.csv');
}
const HEADER = 'qld_time,timestamp,spot,net_gex_usd_1pct,zero_gamma,call_wall,put_wall,n_strikes\n';

function doneTimestamps() {
    const done = new Set();
    const files = fs.readdirSync(__dirname).filter(f => /^eth_gamma_v1_\d{4}-\d{2}\.csv$/.test(f));
    for (const f of files) {
        const lines = fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n');
        for (let i = 1; i < lines.length; i++) {
            const c = lines[i].split(',');
            if (c.length > 1) done.add(c[1]);
        }
    }
    return done;
}

async function run() {
    const done = doneTimestamps();
    let wrote = 0;
    const banked = await streamSnapshots(async (ts, rows) => {
        if (done.has(ts)) return;
        const res = computeSnapshot(ts, rows);
        if (!res) return;
        const tsMs = Date.parse(ts);
        const file = outFileFor(tsMs);
        if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
        fs.appendFileSync(file, qldStr(tsMs) + ',' + ts + ',' + res.spot.toFixed(2) + ','
            + Math.round(res.netGex) + ',' + res.zero + ',' + res.callWall + ',' + res.putWall + ',' + res.n + '\n');
        done.add(ts);
        wrote++;
    }, !BACKFILL);
    console.log('[GAMMA] ' + qldStr(Date.now()) + ' processed ' + wrote + ' new snapshot(s) (' + banked + ' scanned)');
}

(async () => {
    await run();
    if (!BACKFILL) {
        const tick = async () => { try { await run(); } catch (e) { console.error('[GAMMA] cycle error: ' + e.message); } setTimeout(tick, INTERVAL_MS); };
        setTimeout(tick, INTERVAL_MS);
    } else console.log('[GAMMA] backfill complete.');
})().catch(e => { console.error('[GAMMA] fatal: ' + e.message); process.exit(1); });
