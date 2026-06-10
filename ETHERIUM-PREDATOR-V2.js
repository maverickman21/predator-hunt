// ─── PREDATOR SIGNAL SCANNER v2.2 — ETHEREUM MAINNET + FOUR PILLARS ──────────
// DeFi divergence detection + CoinGlass derivatives data = directional signals.
//
// v2.2 CHANGES:
//  - Pillar snapshot every 5 minutes: continuous CoinGlass + Deribit data
//  - Separate pillar CSV: funding, OI, L/S, liquidations, max pain, P/C ratio
//  - Yellow count tracked per block alongside pillar state
//  - Cross-reference divergence timing against pillar conditions
// v2.1: NQ futures price logged alongside every scan and cluster event
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');
const regime = require('./predator-regime-engine');
const macro = require('./macro-calendar');

// Track regime for Telegram alerts
let lastKnownRegime = 'FLAT';

// ─── Config ──────────────────────────────────────────────────────────────────
const ALCHEMY_ETH_URL = process.env.ALCHEMY_ETH_URL
    || (process.env.ALCHEMY_API_URL || '').replace('base-mainnet', 'eth-mainnet');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || '';

const SCAN_INTERVAL = 5000;       // 5s — Ethereum L1 blocks ~12s
const INPUT_USD = 100;        // Small size for signal detection
const CLUSTER_WINDOW_MS = 300_000;    // 5 minutes
const CLUSTER_MIN_PAIRS = 3;          // 3+ UNIQUE pairs required
const CLUSTER_MIN_ETH_MOVE = 5;      // ETH must move $5+ within cluster window
const MIN_SPIKE = 0.03;       // 0.03% deviation from baseline
const BASELINE_ALPHA = 0.05;       // EMA smoothing
const CLUSTER_COOLDOWN = 600_000;    // 10 min cooldown between cluster alerts

// ─── Tokens (Ethereum Mainnet) ───────────────────────────────────────────────
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const DECIMALS = { [USDC]: 6, [WETH]: 18, [USDT]: 6, [WBTC]: 8, [cbBTC]: 8 };
const USD_PRICES = { [USDC]: 1, [WETH]: 2100, [USDT]: 1, [WBTC]: 70000, [cbBTC]: 70000 };

// ─── QuoterV2 ────────────────────────────────────────────────────────────────
const UNI_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const PANCAKE_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// ─── Pool Universe ───────────────────────────────────────────────────────────
const POOLS = {
    WETH_USDC_UNI_005: {
        address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        fee: 500, quoter: 'uni', tvl: 100_000_000,
        token0: USDC, token1: WETH, label: 'WETH/USDC Uni 0.05% $100M',
    },
    WETH_USDC_PANCAKE_005: {
        address: '0x1ac1a8feaaea1900c4166deeed0c11cc10669d36',
        fee: 500, quoter: 'pancake', tvl: 386_000,
        token0: USDC, token1: WETH, label: 'WETH/USDC Pancake 0.05%',
    },
    WETH_USDC_PANCAKE_001: {
        address: '0x1445f32d1a74872ba41f3d8cf4022e9996120b31',
        fee: 100, quoter: 'pancake', tvl: 207_000,
        token0: USDC, token1: WETH, label: 'WETH/USDC Pancake 0.01%',
    },
    WETH_USDT_UNI_030: {
        address: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
        fee: 3000, quoter: 'uni', tvl: 70_000_000,
        token0: USDT, token1: WETH, label: 'WETH/USDT Uni 0.30% $70M',
    },
    WETH_USDT_PANCAKE_005: {
        address: '0x6ca298d2983ab03aa1da7679389d955a4efee15c',
        fee: 500, quoter: 'pancake', tvl: 1_000_000,
        token0: WETH, token1: USDT, label: 'WETH/USDT Pancake 0.05%',
    },
    WBTC_WETH_UNI_005: {
        address: '0x4585fe77225b41b697c938b018e2ac67ac5a20c0',
        fee: 500, quoter: 'uni', tvl: 47_000_000,
        token0: WBTC, token1: WETH, label: 'WBTC/WETH Uni 0.05% $47M',
    },
    WBTC_WETH_UNI_030: {
        address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed',
        fee: 3000, quoter: 'uni', tvl: 44_000_000,
        token0: WBTC, token1: WETH, label: 'WBTC/WETH Uni 0.30% $44M',
    },
    WBTC_USDC_UNI_030: {
        address: '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35',
        fee: 3000, quoter: 'uni', tvl: 28_000_000,
        token0: WBTC, token1: USDC, label: 'WBTC/USDC Uni 0.30% $28M',
    },
    USDC_USDT_UNI_001: {
        address: '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
        fee: 100, quoter: 'uni', tvl: 24_000_000,
        token0: USDC, token1: USDT, label: 'USDC/USDT Uni 0.01% $24M',
    },
    USDC_USDT_PANCAKE_001: {
        address: '0x04c8577958ccc170eb3d2cca76f9d51bc6e42d8f',
        fee: 100, quoter: 'pancake', tvl: 17_000_000,
        token0: USDC, token1: USDT, label: 'USDC/USDT Pancake 0.01% $17M',
    },
    WBTC_cbBTC_UNI_001: {
        address: '0xe8f7c89c5efa061e340f2d2f206ec78fd8f7e124',
        fee: 100, quoter: 'uni', tvl: 29_000_000,
        token0: cbBTC, token1: WBTC, label: 'WBTC/cbBTC Uni 0.01% $29M',
    },
};

// ─── Divergence Pairs ────────────────────────────────────────────────────────
const DIVERGENCE_PAIRS = [
    { name: 'WETH/USDC: Uni vs Pancake 0.05%', poolA: 'WETH_USDC_UNI_005', poolB: 'WETH_USDC_PANCAKE_005', tokenIn: USDC, tokenOut: WETH, category: 'cross-dex' },
    { name: 'WETH/USDC: Uni vs Pancake 0.01%', poolA: 'WETH_USDC_UNI_005', poolB: 'WETH_USDC_PANCAKE_001', tokenIn: USDC, tokenOut: WETH, category: 'cross-dex' },
    { name: 'USDC/USDT: Uni vs Pancake', poolA: 'USDC_USDT_UNI_001', poolB: 'USDC_USDT_PANCAKE_001', tokenIn: USDC, tokenOut: USDT, category: 'cross-dex' },
    { name: 'WBTC/WETH: 0.05% vs 0.30%', poolA: 'WBTC_WETH_UNI_005', poolB: 'WBTC_WETH_UNI_030', tokenIn: WETH, tokenOut: WBTC, category: 'cross-fee' },
    { name: 'ETH: USDC vs USDT pricing', poolA: 'WETH_USDC_UNI_005', poolB: 'WETH_USDT_UNI_030', tokenIn: WETH, tokenOut: null, category: 'cross-stable' },
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider, uniQuoter, pancakeQuoter;
let lastBlock = 0;
let signalHistory = [];       // { time, name, divergence, deviation }
let lastClusterAlert = 0;     // timestamp of last Telegram alert
const divergenceBaseline = {}; // pair.name → { avg, count }

// ETH price history for direction detection
const ethPriceHistory = [];   // { time, price }

// Pre-load ETH prices from file on startup (survives restart)
try {
    const ethFile = require('path').join(__dirname, 'eth_prices.json');
    if (fs.existsSync(ethFile)) {
        const saved = JSON.parse(fs.readFileSync(ethFile, 'utf8'));
        for (const p of saved) {
            ethPriceHistory.push({ time: new Date(p.t).getTime(), price: p.p });
        }
        console.log(`  [ETH PRICES] Loaded ${ethPriceHistory.length} prices from file`);
    }
} catch (e) { console.log('  [ETH PRICES] No saved prices to load'); }
const ETH_PRICE_WINDOW = 2_592_000_000; // 30 days of price history
const ETH_PRICE_MIN_INTERVAL = 60_000; // 1 minute min between stored samples (downsample)

// NQ futures price — read from nq_price.json (written by NinjaTrader via API)
let nqPrice = 0;
const NQ_PRICE_FILE = require('path').join(__dirname, 'nq_price.json');

function fetchNQPrice() {
    return new Promise((resolve) => {
        try {
            if (fs.existsSync(NQ_PRICE_FILE)) {
                const data = JSON.parse(fs.readFileSync(NQ_PRICE_FILE, 'utf8'));
                if (data.price && data.price > 0) {
                    nqPrice = data.price;
                }
            }
        } catch (e) { /* ignore read errors */ }
        resolve(nqPrice);
    });
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
    provider = new ethers.JsonRpcProvider(ALCHEMY_ETH_URL);
    uniQuoter = new ethers.Contract(UNI_QUOTER, QUOTER_ABI, provider);
    pancakeQuoter = new ethers.Contract(PANCAKE_QUOTER, QUOTER_ABI, provider);
    const network = await provider.getNetwork();
    console.log(`  Connected: chainId ${network.chainId} | Block ${await provider.getBlockNumber()}`);
}

// ─── QuoterV2 ────────────────────────────────────────────────────────────────
async function quotePool(poolKey, tokenIn, tokenOut) {
    const pool = POOLS[poolKey];
    if (!pool) return null;
    const decIn = DECIMALS[tokenIn] || 18;
    const priceIn = USD_PRICES[tokenIn] || 1;
    const amountIn = BigInt(Math.floor((INPUT_USD / priceIn) * (10 ** decIn)));
    const quoter = pool.quoter === 'pancake' ? pancakeQuoter : uniQuoter;
    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n,
        });
        const decOut = DECIMALS[tokenOut] || 18;
        const humanOut = Number(result[0]) / (10 ** decOut);
        const usdOut = humanOut * (USD_PRICES[tokenOut] || 1);
        return { rawOut: result[0], humanOut, usdOut, amountIn };
    } catch (e) { return null; }
}

// ─── Divergence Measurement ──────────────────────────────────────────────────
async function measureDivergence(pair) {
    if (pair.category === 'cross-stable') {
        const [quoteA, quoteB] = await Promise.all([
            quotePool(pair.poolA, WETH, USDC),
            quotePool(pair.poolB, WETH, USDT),
        ]);
        if (!quoteA || !quoteB) return null;
        return {
            name: pair.name, category: pair.category,
            divergence: ((quoteA.usdOut - quoteB.usdOut) / quoteA.usdOut) * 100,
            priceA: quoteA.usdOut, priceB: quoteB.usdOut
        };
    }
    const [quoteA, quoteB] = await Promise.all([
        quotePool(pair.poolA, pair.tokenIn, pair.tokenOut),
        quotePool(pair.poolB, pair.tokenIn, pair.tokenOut),
    ]);
    if (!quoteA || !quoteB) return null;
    return {
        name: pair.name, category: pair.category,
        divergence: ((Number(quoteA.rawOut) - Number(quoteB.rawOut)) / Number(quoteA.rawOut)) * 100,
        priceA: quoteA.humanOut, priceB: quoteB.humanOut
    };
}

// ─── ETH Price Tracking ─────────────────────────────────────────────────────
function trackEthPrice(price) {
    const now = Date.now();
    const last = ethPriceHistory[ethPriceHistory.length - 1];
    // Downsample: only store if >= 1 minute since last entry
    if (!last || (now - last.time) >= ETH_PRICE_MIN_INTERVAL) {
        ethPriceHistory.push({ time: now, price });
    }
    // Prune old entries beyond retention window
    while (ethPriceHistory.length > 0 && now - ethPriceHistory[0].time > ETH_PRICE_WINDOW) {
        ethPriceHistory.shift();
    }
}

function getEthPriceMove(windowMs) {
    if (ethPriceHistory.length < 2) return { delta: 0, direction: 'flat', pctMove: 0 };
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = ethPriceHistory.filter(p => p.time >= cutoff);
    if (recent.length < 2) return { delta: 0, direction: 'flat', pctMove: 0 };
    const first = recent[0].price;
    const last = recent[recent.length - 1].price;
    const delta = last - first;
    const pctMove = (delta / first) * 100;
    return {
        delta,
        direction: delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT',
        pctMove,
        high: Math.max(...recent.map(p => p.price)),
        low: Math.min(...recent.map(p => p.price)),
    };
}

// ─── Cluster Detection (v2 — quality-filtered) ──────────────────────────────
function detectCluster(newSignal) {
    const now = Date.now();
    signalHistory.push({ ...newSignal, time: now });
    signalHistory = signalHistory.filter(s => now - s.time < CLUSTER_WINDOW_MS);

    const uniquePairs = new Set(signalHistory.map(s => s.name));
    const ethMove = getEthPriceMove(CLUSTER_WINDOW_MS);

    const isQuality = uniquePairs.size >= CLUSTER_MIN_PAIRS
        && Math.abs(ethMove.delta) >= CLUSTER_MIN_ETH_MOVE;

    return {
        isCluster: isQuality,
        signalCount: signalHistory.length,
        uniquePairs: uniquePairs.size,
        pairNames: [...uniquePairs],
        ethMove,
        signals: signalHistory.map(s => ({
            name: s.name, divergence: s.divergence, deviation: s.deviation || 0,
            age: ((now - s.time) / 1000).toFixed(0),
        })),
    };
}

// ─── CoinGlass Four Pillars ──────────────────────────────────────────────────
function coinglassGet(endpoint) {
    return new Promise((resolve) => {
        const url = new URL(`https://open-api.coinglass.com/public/v2${endpoint}`);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: { 'accept': 'application/json', 'coinglassSecret': COINGLASS_API_KEY },
            timeout: 8000,
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.success === false) {
                        console.log(`  [CG WARN] ${endpoint}: ${parsed.msg || 'failed'}`);
                    }
                    resolve(parsed);
                }
                catch (e) {
                    console.log(`  [CG ERR] ${endpoint}: unparseable — ${data.slice(0, 100)}`);
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => { console.log(`  [CG ERR] ${endpoint}: ${e.message}`); resolve(null); });
        req.on('timeout', () => { req.destroy(); console.log(`  [CG TIMEOUT] ${endpoint}`); resolve(null); });
        req.end();
    });
}

// ─── Deribit Options — Max Pain + Put/Call Ratio ─────────────────────────────
function deribitGet(endpoint) {
    return new Promise((resolve) => {
        const url = new URL(`https://www.deribit.com/api/v2${endpoint}`);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: { 'accept': 'application/json' },
            timeout: 8000,
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function getDeribitMaxPain(ethPrice) {
    try {
        const res = await deribitGet('/public/get_book_summary_by_currency?currency=ETH&kind=option');
        if (!res || !res.result || res.result.length === 0) return null;

        // Parse instruments: ETH-2APR26-2100-C → { expiry: '2APR26', strike: 2100, type: 'C' }
        const options = [];
        for (const inst of res.result) {
            const parts = inst.instrument_name.split('-');
            if (parts.length < 4) continue;
            const expiry = parts[1];
            const strike = parseFloat(parts[2]);
            const type = parts[3]; // C or P
            const oi = inst.open_interest || 0;
            if (oi > 0 && strike > 0) {
                options.push({ expiry, strike, type, oi, instrument: inst.instrument_name });
            }
        }

        if (options.length === 0) return null;

        // Find nearest expiry with meaningful OI — prefer within 14 days
        const expiries = [...new Set(options.map(o => o.expiry))];
        const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
        function parseExpiry(exp) {
            const match = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
            if (!match) return new Date(9999, 0, 1);
            return new Date(2000 + parseInt(match[3]), months[match[2]] || 0, parseInt(match[1]));
        }
        const sortedExpiries = expiries
            .map(exp => ({ exp, date: parseExpiry(exp) }))
            .sort((a, b) => a.date - b.date);
        const now = new Date();
        const fourteenDays = 14 * 24 * 60 * 60 * 1000;
        let bestExpiry = null;
        for (const { exp, date } of sortedExpiries) {
            if (date.getTime() < now.getTime()) continue;
            if (date.getTime() - now.getTime() > fourteenDays) break;
            const count = options.filter(o => o.expiry === exp).length;
            if (count >= 10) { bestExpiry = exp; break; }
        }
        if (!bestExpiry) {
            for (const { exp, date } of sortedExpiries) {
                if (date.getTime() < now.getTime()) continue;
                const count = options.filter(o => o.expiry === exp).length;
                if (count >= 10) { bestExpiry = exp; break; }
            }
        }
        if (!bestExpiry) bestExpiry = expiries[0];

        // Helper: calculate max pain for a given expiry
        function calcMaxPain(expOpts, ethP) {
            const c = expOpts.filter(o => o.type === 'C');
            const p = expOpts.filter(o => o.type === 'P');
            const callOI = c.reduce((s, o) => s + o.oi, 0);
            const putOI = p.reduce((s, o) => s + o.oi, 0);
            const pcR = callOI > 0 ? putOI / callOI : 0;
            const stks = [...new Set(expOpts.map(o => o.strike))].sort((a, b) => a - b);
            let minP = Infinity, mpStrike = 0;
            for (const ts of stks) {
                let pain = 0;
                for (const call of c) { if (ts > call.strike) pain += (ts - call.strike) * call.oi; }
                for (const put of p) { if (ts < put.strike) pain += (put.strike - ts) * put.oi; }
                if (pain < minP) { minP = pain; mpStrike = ts; }
            }
            return { maxPain: mpStrike, callOI, putOI, pcRatio: pcR, totalOI: callOI + putOI };
        }

        // Primary: weekly/nearest expiry
        const primaryOpts = options.filter(o => o.expiry === bestExpiry);
        const primary = calcMaxPain(primaryOpts, ethPrice);

        // Secondary: find largest expiry that ISN'T the primary (quarterly)
        let secondaryExpiry = null;
        let secondaryData = null;
        let maxOI = 0;
        for (const { exp } of sortedExpiries) {
            if (exp === bestExpiry) continue;
            const expOpts = options.filter(o => o.expiry === exp);
            const totalOI = expOpts.reduce((s, o) => s + o.oi, 0);
            if (totalOI > maxOI) {
                maxOI = totalOI;
                secondaryExpiry = exp;
            }
        }
        if (secondaryExpiry) {
            const secOpts = options.filter(o => o.expiry === secondaryExpiry);
            secondaryData = calcMaxPain(secOpts, ethPrice);
        }

        // Find largest OI concentrations near current price
        const nearStrikes = primaryOpts
            .filter(o => Math.abs(o.strike - ethPrice) < ethPrice * 0.1)
            .sort((a, b) => b.oi - a.oi)
            .slice(0, 3);

        // Log both
        console.log(`  [DERIBIT] Near: ${bestExpiry} | MP: $${primary.maxPain} | P/C: ${primary.pcRatio.toFixed(2)} | OI: ${primary.totalOI.toFixed(0)}`
            + (secondaryData ? ` | Far: ${secondaryExpiry} | MP: $${secondaryData.maxPain} | OI: ${secondaryData.totalOI.toFixed(0)}` : ''));

        return {
            maxPain: primary.maxPain,
            expiry: bestExpiry,
            pcRatio: primary.pcRatio,
            totalCallOI: primary.callOI,
            totalPutOI: primary.putOI,
            topStrikes: nearStrikes.map(o => `${o.type}${o.strike}:${o.oi.toFixed(0)}`),
            distFromPrice: ethPrice - primary.maxPain,
            distPct: ((ethPrice - primary.maxPain) / ethPrice * 100),
            // Secondary (quarterly)
            secondaryMaxPain: secondaryData ? secondaryData.maxPain : null,
            secondaryExpiry: secondaryExpiry,
            secondaryOI: secondaryData ? secondaryData.totalOI : 0,
            secondaryDist: secondaryData ? ethPrice - secondaryData.maxPain : 0,
        };
    } catch (e) {
        console.log(`  [DERIBIT ERR] ${e.message.slice(0, 60)}`);
        return null;
    }
}

async function getFourPillars() {
    if (!COINGLASS_API_KEY) return null;

    const [fundingRes, oiRes, lsRes, liqRes] = await Promise.all([
        coinglassGet('/funding?symbol=ETH&time_type=all'),
        coinglassGet('/open_interest?symbol=ETH&time_type=all'),
        coinglassGet('/long_short?symbol=ETH&time_type=h1'),
        coinglassGet('/liquidation_info?symbol=ETH&time_type=h1'),
    ]);

    const pillars = { funding: null, oi: null, longShort: null, liquidations: null };

    // Pillar 1: Funding Rate
    try {
        if (fundingRes && fundingRes.success && fundingRes.data) {
            // data is array of symbols — find ETH
            const eth = Array.isArray(fundingRes.data)
                ? fundingRes.data.find(d => d.symbol === 'ETH')
                : fundingRes.data;
            if (eth && eth.uMarginList) {
                // Find exchanges with active rates (status=1 means has current rate)
                const active = eth.uMarginList.filter(e => e.status === 1 && e.rate !== undefined);
                if (active.length > 0) {
                    // Average the active rates
                    const avgRate = active.reduce((s, e) => s + e.rate, 0) / active.length;
                    const binance = active.find(e => e.exchangeName === 'Binance');
                    pillars.funding = {
                        rate: binance ? binance.rate : avgRate,
                        exchange: binance ? 'Binance' : `avg(${active.length})`,
                        allRates: active.map(e => `${e.exchangeName}:${e.rate}`).join(', '),
                    };
                }
            }
            console.log(`  [CG] Funding: ${pillars.funding ? `${pillars.funding.exchange} rate=${pillars.funding.rate}` : 'no active rates'}`);
        }
    } catch (e) { console.log(`  [CG] Funding parse error: ${e.message.slice(0, 60)}`); }

    // Pillar 2: Open Interest
    try {
        if (oiRes && oiRes.success && oiRes.data) {
            // data is array of exchanges — first entry "All" is aggregate
            const all = Array.isArray(oiRes.data)
                ? oiRes.data.find(d => d.exchangeName === 'All') || oiRes.data[0]
                : oiRes.data;
            if (all) {
                pillars.oi = {
                    total: all.openInterest || 0,
                    totalFormatted: all.openInterest ? `$${(all.openInterest / 1e9).toFixed(2)}B` : '?',
                    h1Change: all.h1OIChangePercent || 0,
                    h4Change: all.h4OIChangePercent || 0,
                    h1VolChange: all.h1VolChangePercent || 0,
                    avgFundingRate: all.avgFundingRate || 0,
                };
                console.log(`  [CG] OI: ${pillars.oi.totalFormatted} | h1: ${pillars.oi.h1Change}% | h4: ${pillars.oi.h4Change}% | vol h1: +${pillars.oi.h1VolChange}%`);
            }
        }
    } catch (e) { console.log(`  [CG] OI parse error: ${e.message.slice(0, 60)}`); }

    // Pillar 3: Long/Short Ratio
    try {
        if (lsRes && lsRes.success && lsRes.data) {
            const d = Array.isArray(lsRes.data) ? lsRes.data[0] : lsRes.data;
            if (d) {
                pillars.longShort = {
                    ratio: d.longRate / (d.shortRate || 1),
                    longPct: d.longRate || 0,
                    shortPct: d.shortRate || 0,
                    longVol: d.longVolUsd || 0,
                    shortVol: d.shortVolUsd || 0,
                };
                console.log(`  [CG] L/S: ${pillars.longShort.longPct.toFixed(1)}% long / ${pillars.longShort.shortPct.toFixed(1)}% short (ratio ${pillars.longShort.ratio.toFixed(2)})`);
            }
        }
    } catch (e) { console.log(`  [CG] L/S parse error: ${e.message.slice(0, 60)}`); }

    // Pillar 4: Liquidations
    try {
        if (liqRes && liqRes.success && liqRes.data) {
            const d = liqRes.data;
            const longLiq = d.longVolUsd1h || 0;
            const shortLiq = d.shortVolUsd1h || 0;
            const total = d.h1TotalVolUsd || (longLiq + shortLiq);
            const longLiq4h = d.longVolUsd4h || 0;
            const shortLiq4h = d.shortVolUsd4h || 0;
            pillars.liquidations = {
                longLiq,
                shortLiq,
                total,
                longPct: total > 0 ? (longLiq / total * 100) : 50,
                longLiq4h,
                shortLiq4h,
                total4h: d.h4TotalVolUsd || 0,
            };
            console.log(`  [CG] Liq 1h: $${(total / 1e6).toFixed(2)}M | ${pillars.liquidations.longPct.toFixed(0)}% longs | 4h: $${(pillars.liquidations.total4h / 1e6).toFixed(1)}M`);
        }
    } catch (e) { console.log(`  [CG] Liq parse error: ${e.message.slice(0, 60)}`); }

    return pillars;
}

// ─── Directional Bias Scoring ────────────────────────────────────────────────
// Returns score from -5 (strong short) to +5 (strong long)
function computeBias(ethMove, pillars, deribit) {
    let score = 0;
    const reasons = [];

    // Factor 1: ETH price direction from DeFi cluster (+/-1)
    if (ethMove.delta > 5) { score += 1; reasons.push(`ETH +$${ethMove.delta.toFixed(0)} ↑`); }
    else if (ethMove.delta < -5) { score -= 1; reasons.push(`ETH -$${Math.abs(ethMove.delta).toFixed(0)} ↓`); }
    else { reasons.push(`ETH flat ($${ethMove.delta.toFixed(0)})`); }

    if (!pillars) {
        reasons.push('(no CoinGlass data)');
        return { score, reasons, label: score > 0 ? '⬆️ LEAN LONG' : score < 0 ? '⬇️ LEAN SHORT' : '↔️ NEUTRAL' };
    }

    // Factor 2: Funding Rate — TWO REGIMES
    // All levels: positive funding = bearish (longs paying), negative = bullish (shorts paying)
    // Normal (<0.5%): mild directional lean ±1
    // Extreme (>0.5%): strong contrarian signal — magnitude overrides ETH direction
    if (pillars.funding) {
        const rate = pillars.funding.rate;
        const absRate = Math.abs(rate);

        if (absRate < 0.001) {
            // < 0.1% — neutral
            reasons.push(`Funding ${rate > 0 ? '+' : ''}${(rate * 100).toFixed(3)}% (neutral)`);
        } else if (absRate < 0.005) {
            // 0.1% - 0.5% — normal, confirms direction
            if (rate > 0) { score -= 1; reasons.push(`Funding +${(rate * 100).toFixed(3)}% (longs paying → lean short)`); }
            else { score += 1; reasons.push(`Funding ${(rate * 100).toFixed(3)}% (shorts paying → lean long)`); }
        } else if (absRate < 0.01) {
            // 0.5% - 1.0% — CAUTION, crowd building heavily
            if (rate > 0) { score -= 1; reasons.push(`⚠️ Funding +${(rate * 100).toFixed(3)}% (longs crowding → vulnerable to flush)`); }
            else { score += 1; reasons.push(`⚠️ Funding ${(rate * 100).toFixed(3)}% (shorts crowding → vulnerable to squeeze)`); }
        } else {
            // > 1.0% — EXTREME, squeeze imminent, score ±2 to override ETH direction
            if (rate > 0) { score -= 2; reasons.push(`🚨 Funding +${(rate * 100).toFixed(3)}% EXTREME (longs trapped → flush DOWN imminent)`); }
            else { score += 2; reasons.push(`🚨 Funding ${(rate * 100).toFixed(3)}% EXTREME (shorts trapped → squeeze UP imminent)`); }
        }
    }

    // Factor 3: OI Change — dropping OI + rising volume = liquidation cascade
    if (pillars.oi) {
        const h1 = pillars.oi.h1Change;
        const vol = pillars.oi.h1VolChange;
        if (h1 < -2 && vol > 5) {
            // OI dropping + volume surging = liquidation cascade in progress
            if (ethMove.delta < 0) { score -= 1; reasons.push(`OI ${h1.toFixed(1)}% + vol +${vol.toFixed(0)}% (long liquidation cascade)`); }
            else { score += 1; reasons.push(`OI ${h1.toFixed(1)}% + vol +${vol.toFixed(0)}% (short squeeze cascade)`); }
        } else if (h1 > 2 && ethMove.delta > 0) {
            score += 1; reasons.push(`OI +${h1.toFixed(1)}% + price up (fresh longs entering)`);
        } else if (h1 > 2 && ethMove.delta < 0) {
            score -= 1; reasons.push(`OI +${h1.toFixed(1)}% + price down (fresh shorts entering)`);
        } else {
            reasons.push(`OI ${h1 > 0 ? '+' : ''}${h1.toFixed(1)}% | vol ${vol > 0 ? '+' : ''}${vol.toFixed(0)}% (${pillars.oi.totalFormatted})`);
        }
    }

    // Factor 4: Long/Short Ratio — skewed = reversal risk
    if (pillars.longShort) {
        const longPct = pillars.longShort.longPct;
        const shortPct = pillars.longShort.shortPct;
        if (longPct > 55) { score -= 1; reasons.push(`L/S ${longPct.toFixed(1)}%/${shortPct.toFixed(1)}% (longs overweight → reversal risk)`); }
        else if (shortPct > 55) { score += 1; reasons.push(`L/S ${longPct.toFixed(1)}%/${shortPct.toFixed(1)}% (shorts overweight → squeeze risk)`); }
        else { reasons.push(`L/S ${longPct.toFixed(1)}%/${shortPct.toFixed(1)}% (balanced)`); }
    }

    // Factor 5: Liquidations — which side is getting flushed
    // If 90%+ one-sided, the flush is COMPLETE — that side's selling/buying pressure is exhausted
    if (pillars.liquidations && pillars.liquidations.total > 100000) { // minimum $100K to be meaningful
        const longPct = pillars.liquidations.longPct;
        if (longPct > 90) {
            // Extreme long flush — selling pressure exhausted, bounce likely
            score += 1; reasons.push(`Liqs 1h: $${(pillars.liquidations.total / 1e6).toFixed(1)}M — ${longPct.toFixed(0)}% longs FLUSHED (sellers exhausted → bounce)`);
        } else if (longPct > 70) {
            score -= 1; reasons.push(`Liqs 1h: $${(pillars.liquidations.total / 1e6).toFixed(1)}M — ${longPct.toFixed(0)}% longs (downward pressure)`);
        } else if (longPct < 10) {
            // Extreme short flush — buying pressure exhausted, drop likely
            score -= 1; reasons.push(`Liqs 1h: $${(pillars.liquidations.total / 1e6).toFixed(1)}M — ${(100 - longPct).toFixed(0)}% shorts FLUSHED (buyers exhausted → drop)`);
        } else if (longPct < 30) {
            score += 1; reasons.push(`Liqs 1h: $${(pillars.liquidations.total / 1e6).toFixed(1)}M — ${(100 - longPct).toFixed(0)}% shorts (upward pressure)`);
        } else {
            reasons.push(`Liqs 1h: $${(pillars.liquidations.total / 1e6).toFixed(1)}M — ${longPct.toFixed(0)}% longs (mixed)`);
        }
    }

    // Factor 6: Deribit Max Pain — options gravity pull
    if (deribit) {
        const dist = deribit.distFromPrice; // positive = price above max pain, negative = below
        const pct = Math.abs(deribit.distPct);
        if (pct > 2) {
            // Price is far from max pain — expect pull toward it
            if (dist > 0) { score -= 0.5; reasons.push(`Max Pain $${deribit.maxPain} (${deribit.expiry}, ${(deribit.totalCallOI + deribit.totalPutOI).toFixed(0)} OI) — price $${Math.abs(dist).toFixed(0)} ABOVE → gravity pulls DOWN`); }
            else { score += 0.5; reasons.push(`Max Pain $${deribit.maxPain} (${deribit.expiry}, ${(deribit.totalCallOI + deribit.totalPutOI).toFixed(0)} OI) — price $${Math.abs(dist).toFixed(0)} BELOW → gravity pulls UP`); }
        } else {
            reasons.push(`Max Pain $${deribit.maxPain} (${deribit.expiry}, ${(deribit.totalCallOI + deribit.totalPutOI).toFixed(0)} OI) — price near max pain`);
        }
        // Secondary (quarterly) max pain — reference only, no score impact
        if (deribit.secondaryMaxPain) {
            const secDist = deribit.secondaryDist;
            if (secDist > 0) { reasons.push(`Quarterly MP $${deribit.secondaryMaxPain} (${deribit.secondaryExpiry}, ${deribit.secondaryOI.toFixed(0)} OI) — $${Math.abs(secDist).toFixed(0)} ABOVE`); }
            else { reasons.push(`Quarterly MP $${deribit.secondaryMaxPain} (${deribit.secondaryExpiry}, ${deribit.secondaryOI.toFixed(0)} OI) — $${Math.abs(secDist).toFixed(0)} BELOW`); }
        }
        // Put/Call ratio context
        if (deribit.pcRatio > 1.3) { score -= 0.5; reasons.push(`P/C ratio ${deribit.pcRatio.toFixed(2)} (heavy puts — bearish hedging)`); }
        else if (deribit.pcRatio < 0.7) { score += 0.5; reasons.push(`P/C ratio ${deribit.pcRatio.toFixed(2)} (heavy calls — bullish positioning)`); }
        else { reasons.push(`P/C ratio ${deribit.pcRatio.toFixed(2)} (balanced options flow)`); }
    }

    // Clamp to -5..+5
    score = Math.max(-5, Math.min(5, score));

    let label;
    if (score >= 3) label = '⬆️⬆️ STRONG LONG';
    else if (score >= 1.5) label = '⬆️ LONG';
    else if (score >= 0.5) label = '↗️ LEAN LONG';
    else if (score <= -3) label = '⬇️⬇️ STRONG SHORT';
    else if (score <= -1.5) label = '⬇️ SHORT';
    else if (score <= -0.5) label = '↘️ LEAN SHORT';
    else label = '↔️ NEUTRAL';

    return { score, reasons, label };
}

// ─── CSV Logging (monthly rotation — one file per month, append mode) ────────
function getMonthlyFilename(prefix) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `${prefix}_${ym}.csv`;
}

function ensureCSV(filepath, header) {
    if (!fs.existsSync(filepath)) {
        fs.writeFileSync(filepath, header);
        console.log(`  Created: ${filepath}`);
    } else {
        console.log(`  Appending: ${filepath}`);
    }
}

let SCAN_LOG = '';
let CLUSTER_LOG = '';
let PILLAR_LOG = '';
let currentMonth = '';

function rotateLogs() {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (ym === currentMonth) return; // same month, no rotation needed
    currentMonth = ym;

    SCAN_LOG = getMonthlyFilename('eth_signals_v2');
    CLUSTER_LOG = getMonthlyFilename('eth_clusters_v2');
    PILLAR_LOG = getMonthlyFilename('eth_pillars_v2');

    ensureCSV(SCAN_LOG, 'timestamp,block,pair,category,divergence_pct,spike_pct,is_signal,cluster_pairs,eth_price,eth_delta_5m,nq_price\n');
    ensureCSV(CLUSTER_LOG, 'timestamp,block,unique_pairs,signal_count,eth_price,eth_delta,eth_direction,bias_score,bias_label,funding_rate,oi_h1_change,vol_h1_change,ls_long_pct,liq_long_pct,liq_total_usd,max_pain,max_pain_dist,pc_ratio,nq_price\n');
    ensureCSV(PILLAR_LOG, 'timestamp,eth_price,nq_price,yellow_count,funding_rate,oi_total,oi_h1_change,oi_h4_change,vol_h1_change,ls_long_pct,ls_short_pct,liq_total_1h,liq_long_pct,liq_total_4h,max_pain,max_pain_dist,pc_ratio,bias_score\n');
}

function initLogs() { rotateLogs(); }

function logScan(block, pairName, category, divergence, spike, isSignal, clusterPairs, wethPrice, ethDelta, nqP) {
    rotateLogs(); // check if month rolled over
    const row = `${new Date().toISOString()},${block},${pairName},${category},${divergence.toFixed(6)},${spike.toFixed(6)},${isSignal ? 1 : 0},${clusterPairs},${wethPrice.toFixed(2)},${ethDelta.toFixed(2)},${nqP.toFixed(2)}\n`;
    fs.appendFileSync(SCAN_LOG, row);
}

function initClusterLog() { /* handled by rotateLogs */ }

function logCluster(block, cluster, wethPrice, bias, pillars, deribit, nqP) {
    rotateLogs();
    const fr = pillars?.funding?.rate || 0;
    const oiH1 = pillars?.oi?.h1Change || 0;
    const volH1 = pillars?.oi?.h1VolChange || 0;
    const lsPct = pillars?.longShort?.longPct || 0;
    const liqLongPct = pillars?.liquidations?.longPct || 0;
    const liqTotal = pillars?.liquidations?.total || 0;
    const mp = deribit?.maxPain || 0;
    const mpDist = deribit?.distFromPrice || 0;
    const pcr = deribit?.pcRatio || 0;
    const row = `${new Date().toISOString()},${block},${cluster.uniquePairs},${cluster.signalCount},${wethPrice.toFixed(2)},${cluster.ethMove.delta.toFixed(2)},${cluster.ethMove.direction},${bias.score},${bias.label},${fr},${oiH1},${volH1},${lsPct},${liqLongPct.toFixed(1)},${liqTotal.toFixed(0)},${mp},${mpDist.toFixed(0)},${pcr.toFixed(3)},${nqP.toFixed(2)}\n`;
    fs.appendFileSync(CLUSTER_LOG, row);
}

// ─── Telegram ────────────────────────────────────────────────────────────────

// ─── Pillar Snapshot (every 1 minute) ──────────────────────────────────────
const PILLAR_INTERVAL = 60_000; // 1 minute
let lastPillarFetch = 0;
let activeYellowCount = 0;

function initPillarLog() { /* handled by rotateLogs */ }

async function pillarSnapshot(wethPrice, nqP) {
    const now = Date.now();
    if (now - lastPillarFetch < PILLAR_INTERVAL) return;
    lastPillarFetch = now;

    const [pillars, deribit] = await Promise.all([
        getFourPillars(),
        getDeribitMaxPain(wethPrice),
    ]);

    // Compute bias for context
    const ethMove = getEthPriceMove(CLUSTER_WINDOW_MS);
    const bias = computeBias(ethMove, pillars, deribit);

    const fr = pillars?.funding?.rate || 0;
    const oiTotal = pillars?.oi?.total || 0;
    const oiH1 = pillars?.oi?.h1Change || 0;
    const oiH4 = pillars?.oi?.h4Change || 0;
    const volH1 = pillars?.oi?.h1VolChange || 0;
    const lsLong = pillars?.longShort?.longPct || 0;
    const lsShort = pillars?.longShort?.shortPct || 0;
    const liqTotal = pillars?.liquidations?.total || 0;
    const liqLongPct = pillars?.liquidations?.longPct || 0;
    const liqTotal4h = pillars?.liquidations?.total4h || 0;
    const mp = deribit?.maxPain || 0;
    const mpDist = deribit?.distFromPrice || 0;
    const pcr = deribit?.pcRatio || 0;

    rotateLogs();
    const row = `${new Date().toISOString()},${wethPrice.toFixed(2)},${nqP.toFixed(2)},${activeYellowCount},${fr},${(oiTotal / 1e9).toFixed(2)},${oiH1},${oiH4},${volH1},${lsLong.toFixed(1)},${lsShort.toFixed(1)},${(liqTotal / 1e6).toFixed(3)},${liqLongPct.toFixed(1)},${(liqTotal4h / 1e6).toFixed(3)},${mp},${mpDist.toFixed(0)},${pcr.toFixed(3)},${bias.score}\n`;
    fs.appendFileSync(PILLAR_LOG, row);

    // ─── REGIME ENGINE: feed pillar data ───
    const regimeState = regime.processScan({
        timestamp: new Date().toISOString(),
        eth_price: wethPrice,
        nq_price: nqP,
        oi_h1_change: oiH1,
        oi_h4_change: oiH4,
        liq_long_pct: liqLongPct,
        liq_total_1h: liqTotal / 1e6,   // convert to millions to match CSV
        funding_rate: fr,
        ls_long_pct: lsLong,
        yellow_count: activeYellowCount,
    });

    // Telegram on regime change
    if (regimeState.regime !== lastKnownRegime) {
        const emoji = regimeState.regime === 'LONG' ? '🟢' : regimeState.regime === 'SHORT' ? '🔴' : '⚪';
        const macroBias = regimeState.macro ? regimeState.macro.bias : 'UNKNOWN';
        const macroEmoji = macroBias === 'LONG' ? '🟢' : macroBias === 'SHORT' ? '🔴' : macroBias === 'SIDELINES' ? '🟡' : '⚪';
        sendTelegram([
            `${emoji} *REGIME: ${lastKnownRegime} → ${regimeState.regime}*`,
            `${macroEmoji} *MACRO: ${macroBias}*`,
            `H4: ${regimeState.pair1.h4_current.toFixed(2)} | H1: ${regimeState.pair1.h1_consecutive} scans ${regimeState.pair1.h1_direction}`,
            `Liq: ${regimeState.pair2.liq_pct.toFixed(1)}% | Vol Δ: ${regimeState.pair2.liq_vol_magnitude.toFixed(3)}M`,
            `Corr: ${(regimeState.correlation.ratio * 100).toFixed(0)}%`,
            `ETH: $${wethPrice.toFixed(2)} | NQ: ${nqP.toFixed(2)}`,
        ].join('\n')).catch(() => { });
        lastKnownRegime = regimeState.regime;
    }

    console.log(`  [REGIME] ${regimeState.regime} | Macro: ${regimeState.macro ? regimeState.macro.bias : '?'} | H4: ${regimeState.pair1.h4_current.toFixed(2)} gate:${regimeState.pair1.h4_gate} | H1: ${regimeState.pair1.h1_consecutive} scans | Corr: ${(regimeState.correlation.ratio * 100).toFixed(0)}%`);

    // ─── MACRO CALENDAR CHECK ───
    const macroCtx = macro.getMacroContext();
    macro.checkAndAlert(sendTelegram);
    if (macroCtx.isMacroDay) {
        console.log(`  [MACRO] ⚠️ ${macroCtx.summary}`);
    }
    if (macroCtx.nextEvent) {
        console.log(`  [MACRO] Next: ${macroCtx.nextEvent.event} in ${macroCtx.nextEvent.hoursAway}h (${macroCtx.nextEvent.brisbaneTime} AEST)`);
    }

    console.log(`  📊 Pillar snapshot: funding ${(fr * 100).toFixed(3)}% | OI ${oiH1}% | L/S ${lsLong.toFixed(0)}/${lsShort.toFixed(0)} | Liqs $${(liqTotal / 1e6).toFixed(2)}M (${liqLongPct.toFixed(0)}% long) | Yellows: ${activeYellowCount}`);

    // Persist ETH price history for correlation indicator reload
    // 30 days @ 1-min sampling = ~43,200 entries max, ~5MB file
    try {
        const recentPrices = ethPriceHistory.map(p => ({ t: new Date(p.time).toISOString(), p: p.price }));
        fs.writeFileSync(require('path').join(__dirname, 'eth_prices.json'), JSON.stringify(recentPrices));
    } catch (e) { console.log(`  [ETH PRICES] Write failed: ${e.message}`); }
}

// ─── Telegram ────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return Promise.resolve();
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
    return new Promise((resolve) => {
        const req = https.request(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 },
            (res) => { res.resume(); resolve(); }
        );
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ─── Main Scan ───────────────────────────────────────────────────────────────
async function scan() {
    const block = await provider.getBlockNumber();
    if (block <= lastBlock) return;
    lastBlock = block;
    const t0 = Date.now();

    // Get WETH price
    let wethPrice = USD_PRICES[WETH];
    try {
        const amtIn = ethers.parseUnits('0.1', 18);
        const result = await uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: WETH, tokenOut: USDC, amountIn: amtIn, fee: 500, sqrtPriceLimitX96: 0n,
        });
        wethPrice = Number(result[0]) / 1e6 * 10;
        USD_PRICES[WETH] = wethPrice;
    } catch (e) {
        console.log(`  WETH price failed: ${e.message.slice(0, 50)}`);
    }

    trackEthPrice(wethPrice);
    const ethMove5m = getEthPriceMove(CLUSTER_WINDOW_MS);

    // Fetch NQ futures price (cached, refreshes every 30s)
    const nqP = await fetchNQPrice();

    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    console.log(`\n[${now}] Block ${block} | WETH $${wethPrice.toFixed(2)} | 5m: ${ethMove5m.direction} $${ethMove5m.delta.toFixed(2)} | NQ ${nqP > 0 ? nqP.toFixed(2) : '?'} | scan ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    // Measure all divergence pairs
    const results = await Promise.all(
        DIVERGENCE_PAIRS.map(pair => measureDivergence(pair).then(r => ({ pair, result: r })))
    );

    let clusterInfo = { isCluster: false, signalCount: signalHistory.length, uniquePairs: 0 };
    let yellowsThisBlock = 0;

    for (const { pair, result } of results) {
        if (!result) continue;

        // Baseline tracking
        const key = pair.name;
        if (!divergenceBaseline[key]) divergenceBaseline[key] = { avg: result.divergence, count: 0 };
        const bl = divergenceBaseline[key];
        bl.count++;
        if (bl.count < 10) {
            bl.avg = bl.avg + (result.divergence - bl.avg) / bl.count;
        } else {
            bl.avg = bl.avg + BASELINE_ALPHA * (result.divergence - bl.avg);
        }

        const deviation = Math.abs(result.divergence - bl.avg);
        const isWarmup = bl.count < 10;
        const isSignal = !isWarmup && deviation >= MIN_SPIKE;
        if (isSignal) yellowsThisBlock++;

        // Log to CSV
        logScan(block, pair.name, pair.category, result.divergence, deviation, isSignal, clusterInfo.uniquePairs, wethPrice, ethMove5m.delta, nqP);

        // Console output
        const icon = isSignal ? '🟡' : (isWarmup ? '⏳' : '⚫');
        console.log(`  ${icon} ${result.name}: ${result.divergence > 0 ? '+' : ''}${result.divergence.toFixed(4)}% ${isWarmup ? `[warmup ${bl.count}/10]` : `[spike: ${deviation.toFixed(4)}%]`}`);

        if (isSignal) {
            clusterInfo = detectCluster({ ...result, deviation });
        }
    }

    // Quality cluster alert with Four Pillars
    if (clusterInfo.isCluster) {
        const now_ts = Date.now();
        if (now_ts - lastClusterAlert < CLUSTER_COOLDOWN) {
            console.log(`  🔥 Quality cluster (${clusterInfo.uniquePairs} pairs, ETH $${clusterInfo.ethMove.delta.toFixed(0)}) — cooldown ${((CLUSTER_COOLDOWN - (now_ts - lastClusterAlert)) / 1000).toFixed(0)}s`);
            return;
        }

        console.log(`\n  🔥🔥🔥 QUALITY CLUSTER: ${clusterInfo.uniquePairs} pairs | ETH ${clusterInfo.ethMove.direction} $${Math.abs(clusterInfo.ethMove.delta).toFixed(2)} 🔥🔥🔥`);

        // Pull Four Pillars from CoinGlass + Deribit
        console.log(`  📡 Fetching pillars: CoinGlass + Deribit...`);
        const [pillars, deribit] = await Promise.all([
            getFourPillars(),
            getDeribitMaxPain(wethPrice),
        ]);

        // Compute directional bias
        const bias = computeBias(clusterInfo.ethMove, pillars, deribit);
        console.log(`  🎯 BIAS: ${bias.label} (score: ${bias.score})`);
        bias.reasons.forEach(r => console.log(`     ${r}`));

        // Log cluster event
        logCluster(block, clusterInfo, wethPrice, bias, pillars, deribit, nqP);

        // Send Telegram
        const pillarLines = bias.reasons.map(r => `  ${r}`).join('\n');
        sendTelegram([
            `*🔥 PREDATOR SIGNAL — ${bias.label}*`,
            `*Score: ${bias.score > 0 ? '+' : ''}${bias.score}*`,
            ``,
            `📊 *DeFi Cluster*`,
            `  ${clusterInfo.uniquePairs} pairs diverging`,
            `  ETH ${clusterInfo.ethMove.direction} $${Math.abs(clusterInfo.ethMove.delta).toFixed(2)} (${clusterInfo.ethMove.pctMove.toFixed(2)}%)`,
            `  Range: $${clusterInfo.ethMove.low?.toFixed(0) || '?'}-$${clusterInfo.ethMove.high?.toFixed(0) || '?'}`,
            ``,
            `📈 *Four Pillars*`,
            pillarLines,
            ``,
            `Block: ${block} | WETH $${wethPrice.toFixed(2)} | NQ ${nqP > 0 ? nqP.toFixed(2) : '?'}`,
            `${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
        ].join('\n')).catch(() => { });

        lastClusterAlert = now_ts;

        // ─── REGIME ENGINE: log cluster event ───
        regime.processEthCluster({
            timestamp: new Date().toISOString(),
            pairs: clusterInfo.uniquePairs,
            signals: clusterInfo.signalCount,
            eth_price: wethPrice,
            eth_delta: clusterInfo.ethMove.delta,
            direction: clusterInfo.ethMove.direction,
            nq_price: nqP,
        });
    }

    // Update yellow count and run pillar snapshot timer
    activeYellowCount = yellowsThisBlock;
    await pillarSnapshot(wethPrice, nqP);
}

// ─── Startup ─────────────────────────────────────────────────────────────────
(async () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  PREDATOR SIGNAL SCANNER v2.3 — FOUR PILLARS + REGIME     ║');
    console.log('║  ETH divergence + CoinGlass + NQ + Regime Engine          ║');
    console.log('║  Monthly CSV rotation + Regime state API                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Pools:          ${Object.keys(POOLS).length}`);
    console.log(`  Pairs:          ${DIVERGENCE_PAIRS.length}`);
    console.log(`  Cluster:        ${CLUSTER_MIN_PAIRS}+ unique pairs + ETH $${CLUSTER_MIN_ETH_MOVE}+ move`);
    console.log(`  Cooldown:       ${CLUSTER_COOLDOWN / 1000}s between alerts`);
    console.log(`  CoinGlass:      ${COINGLASS_API_KEY ? '✅ API key loaded' : '❌ No API key'}`);
    console.log(`  Deribit:        ✅ Free API (max pain + P/C ratio)`);
    console.log(`  NQ Futures:     ✅ Yahoo Finance (cached 30s)`);
    console.log(`  Pillar Log:     ✅ Monthly rotation (append mode)`);
    console.log(`  Regime Engine:  ✅ Paired filters + correlation kill switch`);
    console.log(`  Scan:           ${SCAN_INTERVAL}ms`);
    console.log('');

    await init();
    initLogs();
    initClusterLog();
    initPillarLog();

    sendTelegram([
        `*Predator v2.0 — Four Pillars LIVE*`,
        `${DIVERGENCE_PAIRS.length} pairs | ${CLUSTER_MIN_PAIRS}+ unique pairs + $${CLUSTER_MIN_ETH_MOVE} ETH move`,
        `CoinGlass: ${COINGLASS_API_KEY ? 'active' : 'disabled'}`,
        `Cooldown: ${CLUSTER_COOLDOWN / 1000}s`,
    ].join('\n')).catch(() => { });

    console.log(`  Scanning...\n`);

    while (true) {
        try { await scan(); } catch (err) { console.error(`Scan error: ${err.message}`); }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})().catch(err => {
    console.error(`Fatal: ${err.message}`);
    console.error(err.stack);
});

process.on('unhandledRejection', (err) => console.error(`Unhandled: ${err.message || err}`));
process.on('uncaughtException', (err) => { console.error(`Uncaught: ${err.message}`); console.error(err.stack); });