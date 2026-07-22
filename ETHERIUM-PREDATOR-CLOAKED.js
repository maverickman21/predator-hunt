// ─── PREDATOR SIGNAL SCANNER v1.0 — ETHEREUM MAINNET ─────────────────────────
// Pure signal detection. ZERO execution. No gas cost.
// Monitors cross-DEX price divergence between Uniswap V3 + PancakeSwap V3.
// Detects clusters: 3+ signals within 5 minutes = cluster event.
//
// Purpose: Early warning system for macro flow propagation.
// ETH price discovery happens on mainnet first → L2s lag → arb signals on Base.
// Clusters here correlate with NQ/futures momentum moves.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');

// ─── Config ──────────────────────────────────────────────────────────────────
const ALCHEMY_ETH_URL = process.env.ALCHEMY_API_URL
    ? process.env.ALCHEMY_API_URL.replace('base-mainnet', 'eth-mainnet')
    : 'https://eth-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_API_URL || '').split('/').pop();
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const SCAN_INTERVAL = 5000;       // 5s — Ethereum L1 blocks ~12s
const INPUT_USD = 100;        // Small size for signal detection (zero impact)
const CLUSTER_WINDOW_MS = 300_000;    // 5 minutes
const CLUSTER_MIN = 3;          // 3+ signals = cluster event
const MIN_DIVERGENCE = 0.02;       // 0.02% min absolute divergence for CSV logging

// ─── Tokens (Ethereum Mainnet) ───────────────────────────────────────────────
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const DECIMALS = { [USDC]: 6, [WETH]: 18, [USDT]: 6, [WBTC]: 8, [cbBTC]: 8 };
const SYMBOLS = { [USDC]: 'USDC', [WETH]: 'WETH', [USDT]: 'USDT', [WBTC]: 'WBTC', [cbBTC]: 'cbBTC' };
const USD_PRICES = { [USDC]: 1, [WETH]: 2100, [USDT]: 1, [WBTC]: 70000, [cbBTC]: 70000 };

// ─── QuoterV2 Addresses ─────────────────────────────────────────────────────
const UNI_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const PANCAKE_QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// ─── Pool Universe ───────────────────────────────────────────────────────────
const POOLS = {
    // ── WETH/USDC ──────────────────────────────────────────────────────────
    WETH_USDC_UNI_005: {
        address: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        fee: 500, quoter: 'uni', tvl: 100_000_000,
        token0: USDC, token1: WETH,
        label: 'WETH/USDC Uniswap 0.05% $100M',
    },
    WETH_USDC_PANCAKE_005: {
        address: '0x1ac1a8feaaea1900c4166deeed0c11cc10669d36',
        fee: 500, quoter: 'pancake', tvl: 386_000,
        token0: USDC, token1: WETH,
        label: 'WETH/USDC Pancake 0.05% $386k',
    },
    WETH_USDC_PANCAKE_001: {
        address: '0x1445f32d1a74872ba41f3d8cf4022e9996120b31',
        fee: 100, quoter: 'pancake', tvl: 207_000,
        token0: USDC, token1: WETH,
        label: 'WETH/USDC Pancake 0.01% $207k',
    },

    // ── WETH/USDT ──────────────────────────────────────────────────────────
    WETH_USDT_UNI_030: {
        address: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36',
        fee: 3000, quoter: 'uni', tvl: 70_000_000,
        token0: USDT, token1: WETH,
        label: 'WETH/USDT Uniswap 0.30% $70M',
    },
    WETH_USDT_PANCAKE_005: {
        address: '0x6ca298d2983ab03aa1da7679389d955a4efee15c',
        fee: 500, quoter: 'pancake', tvl: 1_000_000,
        token0: WETH, token1: USDT,
        label: 'WETH/USDT Pancake 0.05% $1M',
    },

    // ── WBTC/WETH ──────────────────────────────────────────────────────────
    WBTC_WETH_UNI_005: {
        address: '0x4585fe77225b41b697c938b018e2ac67ac5a20c0',
        fee: 500, quoter: 'uni', tvl: 47_000_000,
        token0: WBTC, token1: WETH,
        label: 'WBTC/WETH Uniswap 0.05% $47M',
    },
    WBTC_WETH_UNI_030: {
        address: '0xcbcdf9626bc03e24f779434178a73a0b4bad62ed',
        fee: 3000, quoter: 'uni', tvl: 44_000_000,
        token0: WBTC, token1: WETH,
        label: 'WBTC/WETH Uniswap 0.30% $44M',
    },

    // ── WBTC/USDC ──────────────────────────────────────────────────────────
    WBTC_USDC_UNI_030: {
        address: '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35',
        fee: 3000, quoter: 'uni', tvl: 28_000_000,
        token0: WBTC, token1: USDC,
        label: 'WBTC/USDC Uniswap 0.30% $28M',
    },

    // ── USDC/USDT ──────────────────────────────────────────────────────────
    USDC_USDT_UNI_001: {
        address: '0x3416cf6c708da44db2624d63ea0aaef7113527c6',
        fee: 100, quoter: 'uni', tvl: 24_000_000,
        token0: USDC, token1: USDT,
        label: 'USDC/USDT Uniswap 0.01% $24M',
    },
    USDC_USDT_PANCAKE_001: {
        address: '0x04c8577958ccc170eb3d2cca76f9d51bc6e42d8f',
        fee: 100, quoter: 'pancake', tvl: 17_000_000,
        token0: USDC, token1: USDT,
        label: 'USDC/USDT Pancake 0.01% $17M',
    },

    // ── WBTC/cbBTC ─────────────────────────────────────────────────────────
    WBTC_cbBTC_UNI_001: {
        address: '0xe8f7c89c5efa061e340f2d2f206ec78fd8f7e124',
        fee: 100, quoter: 'uni', tvl: 29_000_000,
        token0: cbBTC, token1: WBTC,
        label: 'WBTC/cbBTC Uniswap 0.01% $29M',
    },
};

// ─── Divergence Pairs ────────────────────────────────────────────────────────
// Each pair compares two pools pricing the same asset differently.
// When they disagree, macro flow is hitting.
const DIVERGENCE_PAIRS = [
    // Cross-DEX: same pair, different DEX
    {
        name: 'WETH/USDC: Uni vs Pancake',
        poolA: 'WETH_USDC_UNI_005',
        poolB: 'WETH_USDC_PANCAKE_005',
        tokenIn: USDC, tokenOut: WETH,
        category: 'cross-dex',
    },
    {
        name: 'WETH/USDC: Uni 0.05% vs Pancake 0.01%',
        poolA: 'WETH_USDC_UNI_005',
        poolB: 'WETH_USDC_PANCAKE_001',
        tokenIn: USDC, tokenOut: WETH,
        category: 'cross-dex',
    },
    {
        name: 'USDC/USDT: Uni vs Pancake',
        poolA: 'USDC_USDT_UNI_001',
        poolB: 'USDC_USDT_PANCAKE_001',
        tokenIn: USDC, tokenOut: USDT,
        category: 'cross-dex',
    },

    // Cross-fee-tier: same DEX, different fees (different tick distributions)
    {
        name: 'WBTC/WETH: Uni 0.05% vs 0.30%',
        poolA: 'WBTC_WETH_UNI_005',
        poolB: 'WBTC_WETH_UNI_030',
        tokenIn: WETH, tokenOut: WBTC,
        category: 'cross-fee',
    },

    // Cross-stablecoin: ETH priced in USDC vs USDT
    {
        name: 'ETH price: USDC vs USDT',
        poolA: 'WETH_USDC_UNI_005',
        poolB: 'WETH_USDT_UNI_030',
        tokenIn: WETH, tokenOut: null, // special: compare ETH→USDC vs ETH→USDT
        category: 'cross-stable',
    },
];

// ─── State ───────────────────────────────────────────────────────────────────
let provider;
let uniQuoter, pancakeQuoter;
let lastBlock = 0;
let signalHistory = []; // { time, pair, divergence }
let clusterCount = 0;

// Baseline tracking: rolling average of divergence per pair
// A signal fires when current divergence deviates from baseline by MIN_SPIKE
const divergenceBaseline = {}; // pair.name → { avg, count }
const BASELINE_ALPHA = 0.05;   // EMA smoothing factor (slow-moving baseline)
const MIN_SPIKE = 0.03;        // 0.03% deviation from baseline = signal

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
    provider = new ethers.JsonRpcProvider(ALCHEMY_ETH_URL);
    uniQuoter = new ethers.Contract(UNI_QUOTER, QUOTER_ABI, provider);
    pancakeQuoter = new ethers.Contract(PANCAKE_QUOTER, QUOTER_ABI, provider);

    const network = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    console.log(`  Connected to chainId ${network.chainId} | Block ${block}`);

    if (Number(network.chainId) !== 1) {
        console.error('  ⚠️ WARNING: Not on Ethereum mainnet! ChainId:', Number(network.chainId));
    }
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
        const rawOut = Number(result[0]);
        const humanOut = rawOut / (10 ** decOut);
        const priceOut = USD_PRICES[tokenOut] || 1;
        const usdOut = humanOut * priceOut;

        return { rawOut: result[0], humanOut, usdOut, amountIn };
    } catch (e) {
        return null;
    }
}

// ─── Divergence Calculation ──────────────────────────────────────────────────
async function measureDivergence(pair) {
    if (pair.category === 'cross-stable') {
        // Special: compare ETH→USDC vs ETH→USDT
        const [quoteA, quoteB] = await Promise.all([
            quotePool(pair.poolA, WETH, USDC),
            quotePool(pair.poolB, WETH, USDT),
        ]);
        if (!quoteA || !quoteB) return null;

        // Both should give ~$INPUT_USD in stablecoins
        const divergence = ((quoteA.usdOut - quoteB.usdOut) / quoteA.usdOut) * 100;
        return {
            name: pair.name,
            category: pair.category,
            divergence,
            priceA: quoteA.usdOut,
            priceB: quoteB.usdOut,
        };
    }

    const [quoteA, quoteB] = await Promise.all([
        quotePool(pair.poolA, pair.tokenIn, pair.tokenOut),
        quotePool(pair.poolB, pair.tokenIn, pair.tokenOut),
    ]);
    if (!quoteA || !quoteB) return null;

    const divergence = ((Number(quoteA.rawOut) - Number(quoteB.rawOut)) / Number(quoteA.rawOut)) * 100;

    return {
        name: pair.name,
        category: pair.category,
        divergence,
        priceA: quoteA.humanOut,
        priceB: quoteB.humanOut,
    };
}

// ─── Cluster Detection ───────────────────────────────────────────────────────
function detectCluster(newSignal) {
    const now = Date.now();
    signalHistory.push({ ...newSignal, time: now });

    // Prune old signals
    signalHistory = signalHistory.filter(s => now - s.time < CLUSTER_WINDOW_MS);

    // Count unique divergent pairs in window
    const uniquePairs = new Set(signalHistory.map(s => s.name));
    const count = signalHistory.length;

    if (count >= CLUSTER_MIN) {
        return {
            isCluster: true,
            count,
            uniquePairs: uniquePairs.size,
            window: CLUSTER_WINDOW_MS / 1000,
            signals: signalHistory.map(s => ({
                name: s.name,
                divergence: s.divergence,
                deviation: s.deviation || 0,
                age: ((now - s.time) / 1000).toFixed(0),
            })),
        };
    }

    return { isCluster: false, count, uniquePairs: uniquePairs.size };
}

// ─── CSV Logging ─────────────────────────────────────────────────────────────
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SCAN_LOG = `eth_signals_${SESSION_ID}.csv`;

function initLogs() {
    const header = 'timestamp,block,pair,category,divergence_pct,priceA,priceB,is_signal,cluster_count,weth_price\n';
    fs.writeFileSync(SCAN_LOG, header);
    console.log(`  Log: ${SCAN_LOG}`);
}

function logScan(block, pair, result, isSignal, clusterInfo, wethPrice) {
    const row = [
        new Date().toISOString(),
        block,
        pair.name,
        pair.category,
        result.divergence.toFixed(6),
        result.priceA,
        result.priceB,
        isSignal ? '1' : '0',
        clusterInfo.count,
        wethPrice.toFixed(2),
    ].join(',') + '\n';
    fs.appendFileSync(SCAN_LOG, row);
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
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

    // Get WETH price: quote 0.1 WETH → USDC directly (no USD_PRICE dependency)
    let wethPrice = USD_PRICES[WETH];
    try {
        const amtIn = ethers.parseUnits('0.1', 18); // 0.1 WETH
        const result = await uniQuoter.quoteExactInputSingle.staticCall({
            tokenIn: WETH, tokenOut: USDC, amountIn: amtIn, fee: 500, sqrtPriceLimitX96: 0n,
        });
        wethPrice = Number(result[0]) / 1e6 * 10; // scale 0.1 WETH → 1 WETH price
        USD_PRICES[WETH] = wethPrice;
    } catch (e) {
        console.log(`  WETH price quote failed: ${e.message.slice(0, 60)}`);
    }

    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    console.log(`\n[${now}] Block ${block} | WETH $${wethPrice.toFixed(2)} | scan ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    // Measure all divergence pairs in parallel
    const results = await Promise.all(
        DIVERGENCE_PAIRS.map(pair => measureDivergence(pair).then(r => ({ pair, result: r })))
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    let hasSignal = false;
    let clusterInfo = { isCluster: false, count: signalHistory.length };

    for (const { pair, result } of results) {
        if (!result) continue;

        const absDivergence = Math.abs(result.divergence);

        // Update baseline (EMA)
        const key = pair.name;
        if (!divergenceBaseline[key]) {
            divergenceBaseline[key] = { avg: result.divergence, count: 0 };
        }
        const bl = divergenceBaseline[key];
        bl.count++;
        if (bl.count < 10) {
            // Warmup: simple average for first 10 readings
            bl.avg = bl.avg + (result.divergence - bl.avg) / bl.count;
        } else {
            // EMA after warmup
            bl.avg = bl.avg + BASELINE_ALPHA * (result.divergence - bl.avg);
        }

        // Signal = deviation from baseline exceeds threshold
        const deviation = Math.abs(result.divergence - bl.avg);
        const isWarmup = bl.count < 10;
        const isSignal = !isWarmup && deviation >= MIN_SPIKE;

        // Log everything for data collection
        logScan(block, pair, result, isSignal, clusterInfo, wethPrice);

        // Always show output
        const icon = isSignal ? '🟡' : (isWarmup ? '⏳' : '⚫');
        const extra = isWarmup
            ? `[warmup ${bl.count}/10]`
            : `[baseline: ${bl.avg.toFixed(4)}% | spike: ${deviation.toFixed(4)}%]`;
        console.log(`  ${icon} ${result.name}: ${result.divergence > 0 ? '+' : ''}${result.divergence.toFixed(4)}% ${extra}`);

        if (isSignal) {
            hasSignal = true;
            clusterInfo = detectCluster({ ...result, deviation });
        }
    }

    // Cluster alert
    if (clusterInfo.isCluster && clusterInfo.count >= CLUSTER_MIN) {
        const prevCount = clusterCount;
        clusterCount = clusterInfo.count;

        // Only alert on new cluster (first time crossing threshold) or every 3rd signal
        /*if (prevCount < CLUSTER_MIN || clusterInfo.count % 3 === 0) {
            console.log(`\n  🔥🔥🔥 CLUSTER DETECTED: ${clusterInfo.count} signals in ${clusterInfo.window}s across ${clusterInfo.uniquePairs} pairs 🔥🔥🔥\n`);

            // Fire and forget — never block the scan loop
            sendTelegram([
                `*🔥 ETH MAINNET CLUSTER*`,
                `*${clusterInfo.count} signals in ${clusterInfo.window}s*`,
                `Pairs: ${clusterInfo.uniquePairs}`,
                `Block: ${block} | WETH $${wethPrice.toFixed(2)}`,
                ``,
                clusterInfo.signals.map(s =>
                    `  ${s.name}: spike ${Number(s.deviation).toFixed(4)}% [div: ${Number(s.divergence).toFixed(4)}%] (${s.age}s ago)`
                ).join('\n'),
                ``,
                `⚡ *Check NQ/MNQ for entry*`,
            ].join('\n')).catch(() => { });
        }
    } else {
        clusterCount = clusterInfo.count;*/
    }

    // Periodic status
    if (block % 50 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`  --- ${elapsed}s scan | Signals in window: ${clusterInfo.count} ---`);
    }
}

// ─── Startup ─────────────────────────────────────────────────────────────────
(async () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  PREDATOR SIGNAL SCANNER v1.0 — ETHEREUM MAINNET          ║');
    console.log('║  Pure signal detection | ZERO execution | No gas cost      ║');
    console.log('║  Cross-DEX + Cross-Fee divergence → Cluster detection      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Pools:          ${Object.keys(POOLS).length} pools (Uniswap V3 + PancakeSwap V3)`);
    console.log(`  Pairs:          ${DIVERGENCE_PAIRS.length} divergence pairs`);
    console.log(`  Scan interval:  ${SCAN_INTERVAL}ms (~every L1 block)`);
    console.log(`  Cluster:        ${CLUSTER_MIN}+ signals in ${CLUSTER_WINDOW_MS / 1000}s`);
    console.log(`  Signal:         ${MIN_SPIKE}% deviation from baseline`);
    console.log(`  Warmup:         10 blocks (baseline calibration)`);
    console.log('');

    await init();
    initLogs();

    const startBlock = await provider.getBlockNumber();

    await sendTelegram([
        `*Predator ETH Signal Scanner LIVE*`,
        `${Object.keys(POOLS).length} pools | ${DIVERGENCE_PAIRS.length} pairs`,
        `Cluster: ${CLUSTER_MIN}+ spikes in ${CLUSTER_WINDOW_MS / 1000}s`,
        `Spike: ${MIN_SPIKE}% from baseline | Warmup: 10 blocks`,
        `SCAN ONLY — no execution`,
    ].join('\n'));

    console.log(`  Scanning every ${SCAN_INTERVAL}ms...\n`);

    while (true) {
        try { await scan(); } catch (err) { console.error(`Scan error: ${err.message}`); }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})().catch(err => {
    console.error(`Fatal startup error: ${err.message}`);
    console.error(err.stack);
});

// Catch unhandled rejections — prevent silent crashes
process.on('unhandledRejection', (err) => {
    console.error(`Unhandled rejection: ${err.message || err}`);
});
process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception: ${err.message}`);
    console.error(err.stack);
});