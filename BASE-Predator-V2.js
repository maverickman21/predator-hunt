// ─── PREDATOR SIGNAL SCANNER v2.1 — BASE CHAIN ─────────────────────────────
// Same EMA baseline + spike detection as ETH Mainnet scanner.
// Black/Yellow framework: pools agree (⚫) or diverge (🟡).
// Cross-DEX divergence across Uniswap, PancakeSwap, Aerodrome on Base.
// NQ futures price from nq_price.json (written by NinjaTrader via API).
// Regime engine integration for cluster event logging.
// ────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');
const regime = require('./predator-regime-engine');

// ─── Config ─────────────────────────────────────────────────────────────────
const ALCHEMY_API_URL = process.env.ALCHEMY_API_URL; // Base mainnet
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SCAN_INTERVAL = 2000;       // 2s — Base blocks ~2s
const INPUT_USD = 100;        // Small size for signal detection
const CLUSTER_WINDOW_MS = 300_000;    // 5 minutes
const CLUSTER_MIN_PAIRS = 3;          // 3+ UNIQUE pairs required
const CLUSTER_MIN_ETH_MOVE = 5;      // ETH must move $5+ within cluster window
const MIN_SPIKE = 0.03;       // 0.03% deviation from baseline
const BASELINE_ALPHA = 0.05;       // EMA smoothing
const CLUSTER_COOLDOWN = 600_000;    // 10 min cooldown between alerts

// ─── Tokens (Base) ──────────────────────────────────────────────────────────
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const DECIMALS = { [USDC]: 6, [WETH]: 18, [cbBTC]: 8 };
const USD_PRICES = { [USDC]: 1, [WETH]: 2100, [cbBTC]: 70000 };

// ─── QuoterV2 Addresses (Base) ─────────────────────────────────────────────
const UNISWAP_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const PANCAKE_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const AERO_QUOTER = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';

// Standard UniV3/PancakeV3 QuoterV2 ABI (uses fee uint24)
const STANDARD_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// Aerodrome Slipstream QuoterV2 ABI (uses tickSpacing int24 instead of fee)
const AERO_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// Pool ABI to read tickSpacing at startup
const POOL_ABI = ['function tickSpacing() external view returns (int24)'];

// ─── Pool Universe ──────────────────────────────────────────────────────────
const POOLS = {
    // ── WETH/USDC ──────────────────────────────────────────────────────────
    WETH_USDC_UNI: {
        address: '0x6c561b446416e1a00e8e93e221854d6ea4171372',
        fee: 500, quoterType: 'uni', tvl: 89_000_000,
        token0: WETH, token1: USDC,
        label: 'WETH/USDC Uni 0.05% $89M',
    },
    WETH_USDC_AERO: {
        address: '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59',
        quoterType: 'aero', tvl: 22_000_000, tickSpacing: 0, // read at startup
        token0: USDC, token1: WETH,
        label: 'WETH/USDC Aero $22M',
    },
    WETH_USDC_PANCAKE: {
        address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38',
        fee: 100, quoterType: 'pancake', tvl: 4_900_000,
        token0: WETH, token1: USDC,
        label: 'WETH/USDC Pancake 0.01% $4.9M',
    },

    // ── cbBTC/WETH ─────────────────────────────────────────────────────────
    cbBTC_WETH_AERO: {
        address: '0x70acdf2ad0bf2402c957154f944c19ef4e1cbae1',
        quoterType: 'aero', tvl: 26_000_000, tickSpacing: 0,
        token0: cbBTC, token1: WETH,
        label: 'cbBTC/WETH Aero $26M',
    },
    cbBTC_WETH_UNI: {
        address: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
        fee: 500, quoterType: 'uni', tvl: 9_000_000,
        token0: WETH, token1: cbBTC,
        label: 'cbBTC/WETH Uni 0.05% $9M',
    },
    cbBTC_WETH_PANCAKE: {
        address: '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
        fee: 100, quoterType: 'pancake', tvl: 7_400_000,
        token0: cbBTC, token1: WETH,
        label: 'cbBTC/WETH Pancake 0.01% $7.4M',
    },

    // ── cbBTC/USDC ─────────────────────────────────────────────────────────
    cbBTC_USDC_AERO: {
        address: '0x4e962bb3889bf030368f56810a9c96b83cb3e778',
        quoterType: 'aero', tvl: 12_000_000, tickSpacing: 0,
        token0: cbBTC, token1: USDC,
        label: 'cbBTC/USDC Aero $12M',
    },
    cbBTC_USDC_UNI: {
        address: '0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef',
        fee: 500, quoterType: 'uni', tvl: 7_800_000,
        token0: cbBTC, token1: USDC,
        label: 'cbBTC/USDC Uni 0.05% $7.8M',
    },
};

// ─── Divergence Pairs ───────────────────────────────────────────────────────
const DIVERGENCE_PAIRS = [
    // WETH/USDC cross-DEX
    { name: 'WETH/USDC: Uni vs Aero', poolA: 'WETH_USDC_UNI', poolB: 'WETH_USDC_AERO', tokenIn: USDC, tokenOut: WETH, category: 'cross-dex' },
    { name: 'WETH/USDC: Uni vs Pancake', poolA: 'WETH_USDC_UNI', poolB: 'WETH_USDC_PANCAKE', tokenIn: USDC, tokenOut: WETH, category: 'cross-dex' },
    // cbBTC/WETH cross-DEX
    { name: 'cbBTC/WETH: Aero vs Uni', poolA: 'cbBTC_WETH_AERO', poolB: 'cbBTC_WETH_UNI', tokenIn: WETH, tokenOut: cbBTC, category: 'cross-dex' },
    { name: 'cbBTC/WETH: Aero vs Pancake', poolA: 'cbBTC_WETH_AERO', poolB: 'cbBTC_WETH_PANCAKE', tokenIn: WETH, tokenOut: cbBTC, category: 'cross-dex' },
    // cbBTC/USDC cross-DEX
    { name: 'cbBTC/USDC: Aero vs Uni', poolA: 'cbBTC_USDC_AERO', poolB: 'cbBTC_USDC_UNI', tokenIn: USDC, tokenOut: cbBTC, category: 'cross-dex' },
];

// ─── State ──────────────────────────────────────────────────────────────────
let provider, uniQuoter, pancakeQuoter, aeroQuoter;
let lastBlock = 0;
let signalHistory = [];
let lastClusterAlert = 0;
const divergenceBaseline = {};

// ETH price history for direction detection
const ethPriceHistory = [];
const ETH_PRICE_WINDOW = 600_000;

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
        } catch (e) { }
        resolve(nqPrice);
    });
}

// ─── Init ───────────────────────────────────────────────────────────────────
async function init() {
    provider = new ethers.JsonRpcProvider(ALCHEMY_API_URL);
    uniQuoter = new ethers.Contract(UNISWAP_QUOTER, STANDARD_QUOTER_ABI, provider);
    pancakeQuoter = new ethers.Contract(PANCAKE_QUOTER, STANDARD_QUOTER_ABI, provider);
    aeroQuoter = new ethers.Contract(AERO_QUOTER, AERO_QUOTER_ABI, provider);

    const network = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    console.log(`  Connected: chainId ${network.chainId} | Block ${block}`);

    // Read tickSpacing from Aerodrome pools at startup
    for (const [key, pool] of Object.entries(POOLS)) {
        if (pool.quoterType === 'aero') {
            try {
                const poolContract = new ethers.Contract(pool.address, POOL_ABI, provider);
                pool.tickSpacing = Number(await poolContract.tickSpacing());
                console.log(`  ${pool.label}: tickSpacing = ${pool.tickSpacing}`);
            } catch (e) {
                console.log(`  ⚠️ ${pool.label}: failed to read tickSpacing — ${e.message.slice(0, 50)}`);
                pool.tickSpacing = 100; // fallback
            }
        }
    }
}

// ─── QuoterV2 ───────────────────────────────────────────────────────────────
async function quotePool(poolKey, tokenIn, tokenOut) {
    const pool = POOLS[poolKey];
    if (!pool) return null;
    const decIn = DECIMALS[tokenIn] || 18;
    const priceIn = USD_PRICES[tokenIn] || 1;
    const amountIn = BigInt(Math.floor((INPUT_USD / priceIn) * (10 ** decIn)));

    try {
        let result;
        if (pool.quoterType === 'aero') {
            result = await aeroQuoter.quoteExactInputSingle.staticCall({
                tokenIn, tokenOut, amountIn, tickSpacing: pool.tickSpacing, sqrtPriceLimitX96: 0n,
            });
        } else if (pool.quoterType === 'pancake') {
            result = await pancakeQuoter.quoteExactInputSingle.staticCall({
                tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n,
            });
        } else {
            result = await uniQuoter.quoteExactInputSingle.staticCall({
                tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n,
            });
        }
        const decOut = DECIMALS[tokenOut] || 18;
        const humanOut = Number(result[0]) / (10 ** decOut);
        const usdOut = humanOut * (USD_PRICES[tokenOut] || 1);
        return { rawOut: result[0], humanOut, usdOut, amountIn };
    } catch (e) { return null; }
}

// ─── Divergence Measurement ─────────────────────────────────────────────────
async function measureDivergence(pair) {
    const [quoteA, quoteB] = await Promise.all([
        quotePool(pair.poolA, pair.tokenIn, pair.tokenOut),
        quotePool(pair.poolB, pair.tokenIn, pair.tokenOut),
    ]);
    if (!quoteA || !quoteB) return null;
    return {
        name: pair.name, category: pair.category,
        divergence: ((Number(quoteA.rawOut) - Number(quoteB.rawOut)) / Number(quoteA.rawOut)) * 100,
        priceA: quoteA.humanOut, priceB: quoteB.humanOut,
    };
}

// ─── ETH Price Tracking ─────────────────────────────────────────────────────
function trackEthPrice(price) {
    const now = Date.now();
    ethPriceHistory.push({ time: now, price });
    while (ethPriceHistory.length > 0 && now - ethPriceHistory[0].time > ETH_PRICE_WINDOW) {
        ethPriceHistory.shift();
    }
}

function getEthPriceMove(windowMs) {
    if (ethPriceHistory.length < 2) return { delta: 0, direction: 'flat', pctMove: 0 };
    const now = Date.now();
    const recent = ethPriceHistory.filter(p => p.time >= now - windowMs);
    if (recent.length < 2) return { delta: 0, direction: 'flat', pctMove: 0 };
    const first = recent[0].price;
    const last = recent[recent.length - 1].price;
    const delta = last - first;
    return {
        delta, direction: delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT',
        pctMove: (delta / first) * 100,
        high: Math.max(...recent.map(p => p.price)),
        low: Math.min(...recent.map(p => p.price)),
    };
}

// ─── Cluster Detection ──────────────────────────────────────────────────────
function detectCluster(newSignal) {
    const now = Date.now();
    signalHistory.push({ ...newSignal, time: now });
    signalHistory = signalHistory.filter(s => now - s.time < CLUSTER_WINDOW_MS);
    const uniquePairs = new Set(signalHistory.map(s => s.name));
    const ethMove = getEthPriceMove(CLUSTER_WINDOW_MS);
    const isQuality = uniquePairs.size >= CLUSTER_MIN_PAIRS
        && Math.abs(ethMove.delta) >= CLUSTER_MIN_ETH_MOVE;
    return {
        isCluster: isQuality, signalCount: signalHistory.length,
        uniquePairs: uniquePairs.size, pairNames: [...uniquePairs], ethMove,
        signals: signalHistory.map(s => ({
            name: s.name, divergence: s.divergence, deviation: s.deviation || 0,
            age: ((now - s.time) / 1000).toFixed(0),
        })),
    };
}

// ─── CSV Logging — Monthly Rotation ─────────────────────────────────────────
function getMonthlyFilename(prefix) {
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${prefix}_${month}.csv`;
}

const SCAN_LOG = getMonthlyFilename('base_signals_v2');
const CLUSTER_LOG = getMonthlyFilename('base_clusters_v2');

function ensureCSV(file, header) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, header);
        console.log(`  Created: ${file}`);
    } else {
        console.log(`  Appending: ${file}`);
    }
}

function initLogs() {
    ensureCSV(SCAN_LOG, 'timestamp,block,pair,category,divergence_pct,spike_pct,is_signal,cluster_pairs,eth_price,eth_delta_5m,nq_price\n');
    ensureCSV(CLUSTER_LOG, 'timestamp,block,unique_pairs,signal_count,eth_price,eth_delta,eth_direction,nq_price\n');
}

function logScan(block, pairName, category, divergence, spike, isSignal, clusterPairs, wethPrice, ethDelta, nqP) {
    const row = `${new Date().toISOString()},${block},${pairName},${category},${divergence.toFixed(6)},${spike.toFixed(6)},${isSignal ? 1 : 0},${clusterPairs},${wethPrice.toFixed(2)},${ethDelta.toFixed(2)},${nqP.toFixed(2)}\n`;
    fs.appendFileSync(SCAN_LOG, row);
}

function logCluster(block, cluster, wethPrice, nqP) {
    const row = `${new Date().toISOString()},${block},${cluster.uniquePairs},${cluster.signalCount},${wethPrice.toFixed(2)},${cluster.ethMove.delta.toFixed(2)},${cluster.ethMove.direction},${nqP.toFixed(2)}\n`;
    fs.appendFileSync(CLUSTER_LOG, row);
}

// ─── Telegram ───────────────────────────────────────────────────────────────
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

// ─── Main Scan ──────────────────────────────────────────────────────────────
async function scan() {
    const block = await provider.getBlockNumber();
    if (block <= lastBlock) return;
    lastBlock = block;
    const t0 = Date.now();

    // Get WETH price from Uniswap
    let wethPrice = USD_PRICES[WETH];
    try {
        const amtIn = ethers.parseUnits('0.1', 18);
        const result = await uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: WETH, tokenOut: USDC, amountIn: amtIn, fee: 500, sqrtPriceLimitX96: 0n,
        });
        wethPrice = Number(result[0]) / 1e6 * 10;
        USD_PRICES[WETH] = wethPrice;
    } catch (e) { }

    // Update cbBTC price estimate
    try {
        const amtIn = BigInt(Math.floor(0.001 * 1e8)); // 0.001 cbBTC
        const result = await uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: cbBTC, tokenOut: USDC, amountIn: amtIn, fee: 500, sqrtPriceLimitX96: 0n,
        });
        USD_PRICES[cbBTC] = Number(result[0]) / 1e6 * 1000;
    } catch (e) { }

    trackEthPrice(wethPrice);
    const ethMove5m = getEthPriceMove(CLUSTER_WINDOW_MS);
    const nqP = await fetchNQPrice();

    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    console.log(`\n[${now}] Block ${block} | WETH $${wethPrice.toFixed(2)} | 5m: ${ethMove5m.direction} $${ethMove5m.delta.toFixed(2)} | NQ ${nqP > 0 ? nqP.toFixed(2) : '?'} | scan ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    // Measure all divergence pairs
    const results = await Promise.all(
        DIVERGENCE_PAIRS.map(pair => measureDivergence(pair).then(r => ({ pair, result: r })))
    );

    let clusterInfo = { isCluster: false, signalCount: signalHistory.length, uniquePairs: 0 };

    for (const { pair, result } of results) {
        if (!result) continue;

        // Baseline tracking (EMA)
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

        // Log to CSV
        logScan(block, pair.name, pair.category, result.divergence, deviation, isSignal, clusterInfo.uniquePairs, wethPrice, ethMove5m.delta, nqP);

        // Console output
        const icon = isSignal ? '🟡' : (isWarmup ? '⏳' : '⚫');
        console.log(`  ${icon} ${result.name}: ${result.divergence > 0 ? '+' : ''}${result.divergence.toFixed(4)}% ${isWarmup ? `[warmup ${bl.count}/10]` : `[spike: ${deviation.toFixed(4)}%]`}`);

        if (isSignal) {
            clusterInfo = detectCluster({ ...result, deviation });
        }
    }

    // Quality cluster alert
    if (clusterInfo.isCluster) {
        const now_ts = Date.now();
        if (now_ts - lastClusterAlert < CLUSTER_COOLDOWN) {
            console.log(`  🔥 Quality cluster (${clusterInfo.uniquePairs} pairs, ETH $${clusterInfo.ethMove.delta.toFixed(0)}) — cooldown ${((CLUSTER_COOLDOWN - (now_ts - lastClusterAlert)) / 1000).toFixed(0)}s`);
            return;
        }

        console.log(`\n  🔥🔥🔥 BASE CLUSTER: ${clusterInfo.uniquePairs} pairs | ETH ${clusterInfo.ethMove.direction} $${Math.abs(clusterInfo.ethMove.delta).toFixed(2)} 🔥🔥🔥`);

        logCluster(block, clusterInfo, wethPrice, nqP);

        sendTelegram([
            `*🔥 BASE SIGNAL — CLUSTER*`,
            `${clusterInfo.uniquePairs} pairs diverging`,
            `ETH ${clusterInfo.ethMove.direction} $${Math.abs(clusterInfo.ethMove.delta).toFixed(2)}`,
            `Range: $${clusterInfo.ethMove.low?.toFixed(0) || '?'}-$${clusterInfo.ethMove.high?.toFixed(0) || '?'}`,
            `NQ: ${nqP > 0 ? nqP.toFixed(2) : '?'}`,
            `Block: ${block} | WETH $${wethPrice.toFixed(2)}`,
            `${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
        ].join('\n')).catch(() => { });

        lastClusterAlert = now_ts;

        // ─── REGIME ENGINE: log BASE cluster event ───
        regime.processBaseCluster({
            timestamp: new Date().toISOString(),
            pairs: clusterInfo.uniquePairs,
            signals: clusterInfo.signalCount,
            eth_price: wethPrice,
            eth_delta: clusterInfo.ethMove.delta,
            direction: clusterInfo.ethMove.direction,
            nq_price: nqP,
        });
    }
}

// ─── Startup ────────────────────────────────────────────────────────────────
(async () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  PREDATOR BASE SCANNER v2.1 — BLACK/YELLOW + NQ + REGIME ║');
    console.log('║  Cross-DEX divergence: Uniswap + Aerodrome + PancakeSwap ║');
    console.log('║  EMA baseline spike detection — same as ETH scanner      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Pools:          ${Object.keys(POOLS).length}`);
    console.log(`  Pairs:          ${DIVERGENCE_PAIRS.length}`);
    console.log(`  Cluster:        ${CLUSTER_MIN_PAIRS}+ unique pairs + ETH $${CLUSTER_MIN_ETH_MOVE}+ move`);
    console.log(`  Cooldown:       ${CLUSTER_COOLDOWN / 1000}s between alerts`);
    console.log(`  NQ Futures:     ✅ nq_price.json (from NinjaTrader)`);
    console.log(`  Regime Engine:  ✅ processBaseCluster wired`);
    console.log(`  Scan:           ${SCAN_INTERVAL}ms`);
    console.log('');

    await init();
    initLogs();

    sendTelegram([
        `*Predator BASE v2.1 — Black/Yellow LIVE*`,
        `${DIVERGENCE_PAIRS.length} pairs | Uni + Aero + Pancake`,
        `EMA baseline + NQ price tracking + Regime`,
        `Scan: ${SCAN_INTERVAL}ms`,
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