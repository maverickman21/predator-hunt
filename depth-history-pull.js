/**
 * DEPTH HISTORY RESEARCH PULL (one-off, not a service)
 *
 * Pulls last ~6 days of 1-minute aggregate orderbook depth (bids/asks USD
 * within +/- range% of price) for ETHUSDT from CoinGlass ask-bids-history.
 * Tries FUTURES endpoint first, falls back to SPOT if futures 404s/errors.
 *
 * Output: depth_1m_r{range}.csv  (qld_time,utc_time,ms,bids_usd,asks_usd,imbalance,total)
 *   imbalance = (bids - asks) / (bids + asks)   -> +1 all bids, -1 all asks
 *
 * Run: node depth-history-pull.js
 */

require('dotenv').config();
const https = require('https');

const KEY = process.env.COINGLASS_API_KEY;
if (!KEY) { console.error('No COINGLASS_API_KEY in .env'); process.exit(1); }

const fs = require('fs');
const SYMBOL = 'ETHUSDT';
const EXCHANGE = 'Binance';
const RANGES = ['1', '2'];               // depth window: +/-1% and +/-2%
const DAYS_BACK = 6;
const LIMIT = 1000;                      // max rows per call (1000 minutes)

const BASES = [
    'https://open-api-v4.coinglass.com/api/futures/orderbook/ask-bids-history',
    'https://open-api-v4.coinglass.com/api/spot/orderbook/ask-bids-history'
];

function get(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'CG-API-KEY': KEY }, timeout: 20000 }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('bad json: ' + body.slice(0, 120))); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

function qld(ms) {
    const d = new Date(ms + 10 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' '
         + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

async function pullRange(base, range) {
    const end = Date.now();
    const start = end - DAYS_BACK * 24 * 3600 * 1000;
    let cursor = start;
    const rows = [];

    while (cursor < end) {
        const url = `${base}?exchange=${EXCHANGE}&symbol=${SYMBOL}&interval=1m&range=${range}&limit=${LIMIT}&start_time=${cursor}&end_time=${end}`;
        const json = await get(url);
        if (json.code !== '0' || !Array.isArray(json.data)) {
            throw new Error(`API error (range ${range}): ${json.msg || JSON.stringify(json).slice(0, 120)}`);
        }
        if (json.data.length === 0) break;

        for (const r of json.data) rows.push(r);
        const lastTs = json.data[json.data.length - 1].time;
        if (lastTs <= cursor) break;                 // no forward progress, stop
        cursor = lastTs + 60 * 1000;
        process.stdout.write(`\r  range ${range}%: ${rows.length} rows, up to ${qld(lastTs)} qld  `);
        await new Promise(r => setTimeout(r, 400)); // gentle on rate limits
    }
    console.log('');
    return rows;
}

(async () => {
    let base = null;

    // probe which market serves this endpoint
    for (const b of BASES) {
        try {
            const probe = await get(`${b}?exchange=${EXCHANGE}&symbol=${SYMBOL}&interval=1m&range=1&limit=5`);
            if (probe.code === '0' && Array.isArray(probe.data) && probe.data.length > 0) {
                base = b;
                console.log('Using endpoint: ' + b);
                break;
            }
            console.log('Probe failed on ' + b + ': ' + (probe.msg || 'no data'));
        } catch (e) {
            console.log('Probe error on ' + b + ': ' + e.message);
        }
    }
    if (!base) { console.error('Neither futures nor spot endpoint returned data. Stop.'); process.exit(1); }

    for (const range of RANGES) {
        console.log(`Pulling +/-${range}% depth, 1m, last ${DAYS_BACK} days...`);
        const rows = await pullRange(base, range);
        rows.sort((a, b) => a.time - b.time);

        const file = `depth_1m_r${range}.csv`;
        const out = ['qld_time,utc_time,ms,bids_usd,asks_usd,imbalance,total'];
        for (const r of rows) {
            const b = r.bids_usd, a = r.asks_usd;
            const tot = b + a;
            const imb = tot > 0 ? ((b - a) / tot).toFixed(4) : '';
            out.push(`${qld(r.time)},${new Date(r.time).toISOString()},${r.time},${b},${a},${imb},${tot.toFixed(0)}`);
        }
        fs.writeFileSync(file, out.join('\n') + '\n');
        console.log(`  wrote ${rows.length} rows -> ${file}`);
    }

    console.log('Done. Grep the event windows and see if the depth told the truth.');
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
