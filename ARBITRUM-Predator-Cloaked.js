// ─── PREDATOR LISTENER v3.2 — ARBITRUM ──────────────────────────────────────
// Clean port from Base. Unified QuoterV2, no Aerodrome, no vAMM.
// All pools are Uniswap V3 or PancakeSwap V3 concentrated liquidity.
//
// Triangles:
//   USDT:       USDC <-> WETH <-> USDT  (3 legs, $5k-50k dynamic)
//   WBTC-direct: USDC <-> WETH <-> WBTC  (3 legs, 0.4% fee floor)
//   WBTC-USDT:  USDC <-> WETH <-> WBTC <-> USDT  (4 legs, 0.16% fee floor)
//   2-leg:      Pancake WETH/USDC <-> Uniswap WETH/USDC
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────
const ALCHEMY_API_URL = process.env.ALCHEMY_ARB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDR = process.env.PREDATOR_CONTRACT_ARB;

const INPUT_USD = 5000;
const SCAN_INTERVAL = 250;             // Arbitrum ~250ms blocks natively
const SLIPPAGE = 0.0075;
const MIN_PROFIT_USD = 1.0;             // $1 at $5k triggers dynamic sizing
const MIN_EXECUTE_USD = 8.0;             // $8 at optimal size sends TX
const EXEC_COOLDOWN = 3;

// Dynamic sizing
const DYNAMIC_SIZES = [5000, 10000, 25000, 50000];

// Gas config — Arbitrum gas is ~$0.008/tx
const GAS_TIP_NORMAL = '0.01';  // gwei
const GAS_TIP_EVENT = '0.1';   // gwei
const GAS_LIMIT = 1_200_000n;

// ─── Token Addresses (Arbitrum) ──────────────────────────────────────────────
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDT = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const WBTC = '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f';

const DECIMALS = {
    [USDC]: 6, [WETH]: 18, [USDT]: 6, [WBTC]: 8,
};

const USD_PRICE_APPROX = {
    [USDC]: 1, [WETH]: 2100, [USDT]: 1, [WBTC]: 70000,
};

// ─── Pool Universe ────────────────────────────────────────────────────────────
// All Uniswap V3 and PancakeSwap V3 — unified QuoterV2, no vAMM
// poolType: 0 = UniV3, 1 = PancakeV3

const POOLS = {
    // ── WETH/USDC ─────────────────────────────────────────────────────────
    WETH_USDC_UNI: {
        address: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
        fee: 0.000500, tvl: 52000000, feeBps: 500, poolType: 0,
        label: 'WETH/USDC Uniswap 0.05% $52M ★',
    },
    WETH_USDC_PANCAKE: {
        address: '0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c',
        fee: 0.000100, tvl: 886000, feeBps: 100, poolType: 1,
        label: 'WETH/USDC Pancake 0.01% $886k',
    },
    WETH_USDC_PANCAKE2: {
        address: '0x7fCDC35463E3770c2fB992716Cd070B63540b947',
        fee: 0.000100, tvl: 612000, feeBps: 100, poolType: 1,
        label: 'WETH/USDC Pancake 0.01% $612k',
    },

    // ── WBTC/WETH ─────────────────────────────────────────────────────────
    WBTC_WETH_UNI: {
        address: '0x2f5e87C9312fa29aed5c179E456625D79015299c',
        fee: 0.000500, tvl: 47000000, feeBps: 500, poolType: 0,
        label: 'WBTC/WETH Uniswap 0.05% $47M ★',
    },
    WBTC_WETH_PANCAKE: {
        address: '0x4bfc22A4dA7f31F8a912a79A7e44a822398b4390',
        fee: 0.000100, tvl: 1500000, feeBps: 100, poolType: 1,
        label: 'WBTC/WETH Pancake 0.01% $1.5M',
    },

    // ── WETH/USDT ─────────────────────────────────────────────────────────
    WETH_USDT_UNI: {
        address: '0x641C00A822e8b671738d32a431a4Fb6074E5c79d',
        fee: 0.000500, tvl: 13000000, feeBps: 500, poolType: 0,
        label: 'WETH/USDT Uniswap 0.05% $13M ★',
    },
    WETH_USDT_PANCAKE: {
        address: '0x0BaCc7a9717e70EA0DA5Ac075889Bd87d4C81197',
        fee: 0.000500, tvl: 364000, feeBps: 500, poolType: 1,
        label: 'WETH/USDT Pancake 0.05% $364k',
    },

    // ── WBTC/USDT ─────────────────────────────────────────────────────────
    WBTC_USDT_UNI: {
        address: '0x5969EFddE3cF5C0D9a88aE51E47d721096A97203',
        fee: 0.000500, tvl: 12000000, feeBps: 500, poolType: 0,
        label: 'WBTC/USDT Uniswap 0.05% $12M ★',
    },

    // ── WBTC/USDC ─────────────────────────────────────────────────────────
    WBTC_USDC_UNI: {
        address: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',
        fee: 0.003000, tvl: 26000000, feeBps: 3000, poolType: 0,
        label: 'WBTC/USDC Uniswap 0.3% $26M ★',
    },
    WBTC_USDC_PANCAKE: {
        address: '0x843aC8dc6D34AEB07a56812b8b36429eE46BDd07',
        fee: 0.000500, tvl: 477000, feeBps: 500, poolType: 1,
        label: 'WBTC/USDC Pancake 0.05% $477k',
    },

    // ── USDC/USDT ─────────────────────────────────────────────────────────
    USDC_USDT_UNI: {
        address: '0xbE3aD6a5669Dc0B8b12FeBC03608860C31E2eef6',
        fee: 0.000100, tvl: 2400000, feeBps: 100, poolType: 0,
        label: 'USDC/USDT Uniswap 0.01% $2.4M',
    },
};

// ─── Triangle Definitions ─────────────────────────────────────────────────────
const TRIANGLES = [
    {
        name: 'USDT',
        fwd: {
            name: 'USDC → WETH → USDT → USDC',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
                { from: WETH, to: USDT, pools: ['WETH_USDT_UNI', 'WETH_USDT_PANCAKE'] },
                { from: USDT, to: USDC, pools: ['USDC_USDT_UNI'] },
            ],
        },
        rev: {
            name: 'USDC → USDT → WETH → USDC',
            legs: [
                { from: USDC, to: USDT, pools: ['USDC_USDT_UNI'] },
                { from: USDT, to: WETH, pools: ['WETH_USDT_UNI', 'WETH_USDT_PANCAKE'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
            ],
        },
    },
    {
        name: 'WBTC-direct',
        fwd: {
            name: 'USDC → WETH → WBTC → USDC',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
                { from: WETH, to: WBTC, pools: ['WBTC_WETH_UNI', 'WBTC_WETH_PANCAKE'] },
                { from: WBTC, to: USDC, pools: ['WBTC_USDC_UNI', 'WBTC_USDC_PANCAKE'] },
            ],
        },
        rev: {
            name: 'USDC → WBTC → WETH → USDC',
            legs: [
                { from: USDC, to: WBTC, pools: ['WBTC_USDC_UNI', 'WBTC_USDC_PANCAKE'] },
                { from: WBTC, to: WETH, pools: ['WBTC_WETH_UNI', 'WBTC_WETH_PANCAKE'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
            ],
        },
    },
    {
        name: 'WBTC-USDT',
        fwd: {
            name: 'USDC → WETH → WBTC → USDT → USDC',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
                { from: WETH, to: WBTC, pools: ['WBTC_WETH_UNI', 'WBTC_WETH_PANCAKE'] },
                { from: WBTC, to: USDT, pools: ['WBTC_USDT_UNI'] },
                { from: USDT, to: USDC, pools: ['USDC_USDT_UNI'] },
            ],
        },
        rev: {
            name: 'USDC → USDT → WBTC → WETH → USDC',
            legs: [
                { from: USDC, to: USDT, pools: ['USDC_USDT_UNI'] },
                { from: USDT, to: WBTC, pools: ['WBTC_USDT_UNI'] },
                { from: WBTC, to: WETH, pools: ['WBTC_WETH_UNI', 'WBTC_WETH_PANCAKE'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_UNI', 'WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
            ],
        },
    },
    {
        name: 'WETH-2leg',
        fwd: {
            name: 'USDC → WETH(Pancake) → USDC(Uni)',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_UNI'] },
            ],
        },
        rev: {
            name: 'USDC → WETH(Uni) → USDC(Pancake)',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_UNI'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_PANCAKE', 'WETH_USDC_PANCAKE2'] },
            ],
        },
    },
];

// ─── QuoterV2 Addresses ──────────────────────────────────────────────────────
const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const PANCAKE_QUOTER_V2 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

const QUOTER_V2_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const V3_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

const PREDATOR_ABI = [
    'function trigger(uint256 borrowAmount, tuple(address pool, address tokenIn, address tokenOut, uint24 fee, uint8 poolType, uint256 minAmountOut, bool useBalance, uint256 splitAmount)[] legs, uint256 minFinalReturn) external',
    'function paused() view returns (bool)',
];

// ─── Globals ──────────────────────────────────────────────────────────────────
let provider, wallet;
const TOKEN_CACHE = {};
const quoterCache = {};

// ─── Provider Init ────────────────────────────────────────────────────────────
async function initProvider() {
    provider = new ethers.JsonRpcProvider(ALCHEMY_API_URL);
    await provider.getBlockNumber();
    if (PRIVATE_KEY && CONTRACT_ADDR) {
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log('✅ Arbitrum provider connected — EXECUTION MODE');
        console.log(`   Wallet:   ${wallet.address}`);
        console.log(`   Contract: ${CONTRACT_ADDR}`);
    } else {
        console.log('✅ Arbitrum provider connected — DRY-RUN MODE');
    }
}

// ─── Pool Cache Init ──────────────────────────────────────────────────────────
async function initPoolCache() {
    const allPools = Object.entries(POOLS);
    console.log(`  Caching token0/token1 for ${allPools.length} pools...`);

    await Promise.all(
        allPools.map(async ([key, p]) => {
            try {
                const c = new ethers.Contract(p.address, V3_ABI, provider);
                const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
                TOKEN_CACHE[key] = { t0: t0.toLowerCase(), t1: t1.toLowerCase() };
            } catch (e) {
                console.error(`    ${key}: FAILED — ${e.message.slice(0, 50)}`);
            }
        })
    );

    console.log(`  ✅ Tokens cached: ${Object.keys(TOKEN_CACHE).length}/${allPools.length}`);
}

// ─── Price Reading (QuoterV2 — Bidirectional) ─────────────────────────────────
async function readPoolPrice(poolKey) {
    const p = POOLS[poolKey];
    const tokens = TOKEN_CACHE[poolKey];
    if (!tokens) return { ok: false, error: `No cached tokens for ${poolKey}` };
    const t0 = tokens.t0, t1 = tokens.t1;
    const dec0 = DECIMALS[t0] || 18, dec1 = DECIMALS[t1] || 18;

    try {
        const t0Price = USD_PRICE_APPROX[t0] || 1;
        const t1Price = USD_PRICE_APPROX[t1] || 1;
        const t0Amount = INPUT_USD / t0Price;
        const t1Amount = INPUT_USD / t1Price;
        const amountInFwd = BigInt(Math.floor(t0Amount * (10 ** dec0)));
        const amountInRev = BigInt(Math.floor(t1Amount * (10 ** dec1)));

        const quoterAddr = p.poolType === 1 ? PANCAKE_QUOTER_V2 : UNISWAP_QUOTER_V2;
        if (!quoterCache[quoterAddr]) {
            quoterCache[quoterAddr] = new ethers.Contract(quoterAddr, QUOTER_V2_ABI, provider);
        }
        const quoter = quoterCache[quoterAddr];

        const fwdParams = { tokenIn: t0, tokenOut: t1, amountIn: amountInFwd, fee: p.feeBps, sqrtPriceLimitX96: 0n };
        const revParams = { tokenIn: t1, tokenOut: t0, amountIn: amountInRev, fee: p.feeBps, sqrtPriceLimitX96: 0n };

        const [fwdResult, revResult] = await Promise.all([
            quoter.quoteExactInputSingle.staticCall(fwdParams),
            quoter.quoteExactInputSingle.staticCall(revParams),
        ]);

        const t0inT1 = (Number(fwdResult[0]) / (10 ** dec1)) / t0Amount;
        const t1inT0 = (Number(revResult[0]) / (10 ** dec0)) / t1Amount;

        return { t0, t1, t0inT1, t1inT0, ok: true, quoted: true };
    } catch (e) {
        return { ok: false, error: e.message.slice(0, 80) };
    }
}

function extractPrice(poolResult, tokenFrom, tokenTo) {
    if (!poolResult || !poolResult.ok) return null;
    const from = tokenFrom.toLowerCase(), to = tokenTo.toLowerCase();
    if (poolResult.t0 === from && poolResult.t1 === to) return poolResult.t0inT1;
    if (poolResult.t1 === from && poolResult.t0 === to) return poolResult.t1inT0;
    return null;
}

// ─── Triangle Calculation ─────────────────────────────────────────────────────
function calcTriangleEdge(legDefs, poolResults) {
    const singleLegs = [];
    let singleValid = true;
    for (const leg of legDefs) {
        let bestKey = null, bestPrice = 0;
        for (const key of leg.pools) {
            if (!POOLS[key] || !poolResults[key]?.ok) continue;
            if (POOLS[key].tvl < 2000000) continue;
            const price = extractPrice(poolResults[key], leg.from, leg.to);
            if (!price || price <= 0) continue;
            if (price > bestPrice) { bestPrice = price; bestKey = key; }
        }
        if (!bestKey) {
            for (const key of leg.pools) {
                if (!POOLS[key] || !poolResults[key]?.ok) continue;
                const price = extractPrice(poolResults[key], leg.from, leg.to);
                if (!price || price <= 0) continue;
                if (price > bestPrice) { bestPrice = price; bestKey = key; }
            }
        }
        if (!bestKey) { singleValid = false; break; }
        singleLegs.push({ price: bestPrice, fee: POOLS[bestKey].fee, key: bestKey, label: POOLS[bestKey].label });
    }

    let sAmt = INPUT_USD;
    if (singleValid) {
        for (const { price } of singleLegs) sAmt = sAmt * price;
    }
    const singleFeeTotal = singleLegs.reduce((s, l) => s + l.fee, 0);
    const singleEdge = singleValid ? ((sAmt - INPUT_USD) / INPUT_USD) * 100 : null;
    const singleNet = singleValid ? sAmt - INPUT_USD : null;

    const splitLegs = [];
    let splitValid = true;
    for (const leg of legDefs) {
        let bestKey = null, bestPrice = 0;
        for (const key of leg.pools) {
            if (!POOLS[key] || !poolResults[key]?.ok) continue;
            const price = extractPrice(poolResults[key], leg.from, leg.to);
            if (!price || price <= 0) continue;
            if (price > bestPrice) { bestPrice = price; bestKey = key; }
        }
        if (!bestKey) { splitValid = false; break; }
        splitLegs.push({ price: bestPrice, fee: POOLS[bestKey].fee, key: bestKey });
    }
    let spAmt = INPUT_USD;
    if (splitValid) {
        for (const { price } of splitLegs) spAmt = spAmt * price;
    }
    const splitFeeTotal = splitLegs.reduce((s, l) => s + l.fee, 0);
    const splitEdge = splitValid ? ((spAmt - INPUT_USD) / INPUT_USD) * 100 : null;
    const splitNet = splitValid ? spAmt - INPUT_USD : null;

    return {
        single: {
            edgePct: singleEdge, profitUSD: singleNet, feePct: singleFeeTotal * 100,
            pools: singleLegs.map(l => l.key),
            legs: singleLegs.map((l, i) => ({
                poolKey: l.key, from: legDefs[i].from, to: legDefs[i].to, price: l.price, fee: l.fee,
            })),
        },
        split: {
            edgePct: splitEdge, profitUSD: splitNet, feePct: splitFeeTotal * 100,
            pools: splitLegs.map(l => l.key),
            legs: splitLegs.map((l, i) => ({
                poolKey: l.key, from: legDefs[i].from, to: legDefs[i].to, price: l.price, fee: l.fee,
            })),
        },
    };
}

// ─── Slippage helper ──────────────────────────────────────────────────────────
function withSlippage(expectedAmt) {
    return BigInt(Math.floor(Number(expectedAmt) * (1 - SLIPPAGE)));
}

// ─── Dynamic Leg Builder ──────────────────────────────────────────────────────
function buildDynamicLegs(signalLegs, poolResults, flashLoan) {
    const contractLegs = [];
    let currentAmount = flashLoan;

    for (const leg of signalLegs) {
        const pool = POOLS[leg.poolKey];
        const decIn = DECIMALS[leg.from] || 18;
        const decOut = DECIMALS[leg.to] || 18;

        const expectedOut = BigInt(Math.floor(
            Number(currentAmount) * leg.price * (10 ** decOut) / (10 ** decIn)
        ));

        contractLegs.push({
            pool: pool.address,
            tokenIn: leg.from,
            tokenOut: leg.to,
            fee: pool.feeBps,
            poolType: pool.poolType,
            minAmountOut: withSlippage(expectedOut),
            useBalance: false,
            splitAmount: 0n,
        });
        currentAmount = expectedOut;
    }

    const totalUsdcBack = currentAmount;
    console.log(`  [BUILD] ${contractLegs.length} legs:`);
    contractLegs.forEach((l, idx) => {
        const poolLabel = Object.values(POOLS).find(p => p.address.toLowerCase() === l.pool.toLowerCase())?.label || l.pool;
        const symIn = tokenSymbol(l.tokenIn);
        const symOut = tokenSymbol(l.tokenOut);
        const minHuman = Number(l.minAmountOut) / (10 ** (DECIMALS[l.tokenOut.toLowerCase()] || 18));
        console.log(`    Leg ${idx}: ${symIn}→${symOut} via ${poolLabel} | min=${minHuman.toPrecision(6)} | split=${l.splitAmount} | useBalance=${l.useBalance}`);
    });

    return {
        legs: contractLegs,
        loanAmount: flashLoan,
        expectedProfit: (Number(totalUsdcBack) - Number(flashLoan)) / 1e6,
        minFinalReturn: flashLoan + 10000n,
    };
}

function tokenSymbol(addr) {
    const a = addr.toLowerCase();
    if (a === USDC) return 'USDC';
    if (a === WETH) return 'WETH';
    if (a === USDT) return 'USDT';
    if (a === WBTC) return 'WBTC';
    return addr.slice(0, 8);
}

// ─── Dynamic Size Quoting ─────────────────────────────────────────────────────
async function quoteLegAtSize(poolKey, tokenIn, tokenOut, amountInRaw) {
    const p = POOLS[poolKey];
    const tokens = TOKEN_CACHE[poolKey];
    if (!p || !tokens) return null;

    try {
        const quoterAddr = p.poolType === 1 ? PANCAKE_QUOTER_V2 : UNISWAP_QUOTER_V2;
        if (!quoterCache[quoterAddr]) {
            quoterCache[quoterAddr] = new ethers.Contract(quoterAddr, QUOTER_V2_ABI, provider);
        }
        const quoter = quoterCache[quoterAddr];
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn, tokenOut, amountIn: amountInRaw, fee: p.feeBps, sqrtPriceLimitX96: 0n,
        });
        return BigInt(result[0]);
    } catch { return null; }
}

async function quotePathAtSize(signalLegs, sizeUSD) {
    const loanAmount = BigInt(sizeUSD) * 1_000_000n;
    let currentAmount = loanAmount;
    const quotedLegs = [];

    for (const leg of signalLegs) {
        const output = await quoteLegAtSize(leg.poolKey, leg.from, leg.to, currentAmount);
        if (!output || output <= 0n) return null;
        quotedLegs.push({ ...leg, amountIn: currentAmount, amountOut: output });
        currentAmount = output;
    }

    return {
        size: sizeUSD,
        loanAmount,
        finalAmount: currentAmount,
        profitUSD: (Number(currentAmount) - Number(loanAmount)) / 1e6,
        legs: quotedLegs,
    };
}

async function findOptimalSize(signalLegs) {
    const results = await Promise.all(
        DYNAMIC_SIZES.map(size => quotePathAtSize(signalLegs, size))
    );
    const valid = results.filter(r => r !== null);
    if (valid.length === 0) return null;

    console.log(`  [SIZING] Quoting ${DYNAMIC_SIZES.length} sizes:`);
    for (const r of valid) {
        const marker = r.profitUSD > 0 ? '🟢' : '🔴';
        console.log(`    ${marker} $${r.size.toLocaleString()}: profit=$${r.profitUSD.toFixed(2)} (${((Number(r.finalAmount) - Number(r.loanAmount)) / Number(r.loanAmount) * 100).toFixed(4)}%)`);
    }

    const profitable = valid.filter(r => r.profitUSD >= MIN_EXECUTE_USD);
    if (profitable.length === 0) {
        valid.sort((a, b) => b.profitUSD - a.profitUSD);
        return { ...valid[0], shouldExecute: false };
    }

    profitable.sort((a, b) => b.profitUSD - a.profitUSD);
    const best = profitable[0];
    console.log(`    ⭐ OPTIMAL: $${best.size.toLocaleString()} → $${best.profitUSD.toFixed(2)} profit`);
    return { ...best, shouldExecute: true };
}

// ─── Execution ────────────────────────────────────────────────────────────────
let lastExecutedBlock = 0;

async function executeArb(triangleName, directionName, signalLegs, poolResults) {
    if (!wallet || !CONTRACT_ADDR) return null;

    const currentBlock = await provider.getBlockNumber();
    if (currentBlock - lastExecutedBlock < EXEC_COOLDOWN) {
        console.log(`  Cooldown: ${EXEC_COOLDOWN - (currentBlock - lastExecutedBlock)} blocks remaining`);
        return null;
    }

    const optimal = await findOptimalSize(signalLegs);
    if (!optimal) { console.log(`  Dynamic sizing failed`); return null; }
    if (!optimal.shouldExecute) {
        console.log(`  Best size $${optimal.size.toLocaleString()}: $${optimal.profitUSD.toFixed(2)} — not profitable, skipping`);
        return null;
    }

    const trade = buildDynamicLegs(signalLegs, poolResults, optimal.loanAmount);
    if (!trade || !trade.legs.length) { console.log(`  Builder failed`); return null; }

    console.log(`  Leg builder estimate: $${trade.expectedProfit.toFixed(2)} at $${optimal.size.toLocaleString()}`);

    let txHash = null;
    try {
        const contract = new ethers.Contract(CONTRACT_ADDR, PREDATOR_ABI, wallet);
        if (await contract.paused()) { console.log('  Contract paused'); return null; }

        const feeData = await provider.getFeeData();
        const priorityFee = ethers.parseUnits(GAS_TIP_NORMAL, 'gwei');
        const maxFee = feeData.maxFeePerGas > priorityFee ? feeData.maxFeePerGas : priorityFee;

        console.log(`\n  🚀 EXECUTING: ${directionName} [$${optimal.size.toLocaleString()}]`);
        console.log(`     Loan: $${Number(trade.loanAmount) / 1e6} | Legs: ${trade.legs.length} | Est: $${optimal.profitUSD.toFixed(2)}`);

        const tx = await contract.trigger(
            trade.loanAmount, trade.legs, trade.minFinalReturn,
            { maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee, gasLimit: GAS_LIMIT }
        );
        txHash = tx.hash;
        console.log(`     TX: ${txHash}`);
        lastExecutedBlock = currentBlock;

        const receipt = await tx.wait(1);
        if (receipt && receipt.status === 1) {
            console.log(`     ✅ CONFIRMED block ${receipt.blockNumber} | gas: ${receipt.gasUsed}`);
            return { success: true, hash: txHash, block: receipt.blockNumber };
        } else {
            console.log(`     ❌ REVERTED${receipt ? ' block ' + receipt.blockNumber : ''}`);
            return { success: false, hash: txHash };
        }
    } catch (err) {
        console.error(`     ❌ ${err.message.slice(0, 120)}`);
        return { success: false, error: err.message, hash: txHash || err.receipt?.hash || null };
    }
}

// ─── CSV Logging ──────────────────────────────────────────────────────────────
const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
let csvStream;
function initCSV() {
    const file = `predator_arb_${SESSION_START}.csv`;
    csvStream = fs.createWriteStream(file, { flags: 'a' });
    csvStream.write('timestamp,block,triangle,direction,singleEdge,singleProfit,splitEdge,splitProfit,wethPrice,wbtcPrice\n');
    console.log(`Logging to: ${file}`);
}
function logToCSV(block, tri, dir, single, split, spotPrices) {
    const ts = new Date().toISOString();
    csvStream.write(`${ts},${block},${tri},${dir},${single.edgePct?.toFixed(4) || ''},${single.profitUSD?.toFixed(2) || ''},${split.edgePct?.toFixed(4) || ''},${split.profitUSD?.toFixed(2) || ''},${spotPrices.weth},${spotPrices.wbtc}\n`);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, resolve);
        req.on('error', () => resolve());
        req.write(data);
        req.end();
    });
}

// ─── Main Scan Loop ───────────────────────────────────────────────────────────
async function main() {
    const mode = (PRIVATE_KEY && CONTRACT_ADDR) ? 'EXECUTION' : 'DRY-RUN';
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log(`║  PREDATOR LISTENER v3.2 — ARBITRUM  [${mode}]          ║`);
    console.log('║  QuoterV2 + Dynamic Sizing — unified infrastructure      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Pool universe:  ${Object.keys(POOLS).length} pools`);
    console.log(`  Triangles:      USDT | WBTC-direct | WBTC-USDT | WETH-2leg`);
    console.log(`  Quoting:        QuoterV2 bidirectional`);
    console.log(`  Scan interval:  ${SCAN_INTERVAL}ms (Arbitrum ~250ms blocks)`);
    console.log(`  Dynamic sizing: $${DYNAMIC_SIZES.join('/$')} | Execute threshold: $${MIN_EXECUTE_USD}`);
    console.log('');

    await initProvider();
    await initPoolCache();
    initCSV();

    const startBlock = await provider.getBlockNumber();
    await sendTelegram([
        `*Predator v3.2 ARBITRUM — ${mode}*`,
        `USDT | WBTC-direct | WBTC-USDT | WETH-2leg`,
        `Dynamic sizing: $${DYNAMIC_SIZES.join('/$')}`,
        `Block: ${startBlock}`,
        `${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
    ].join('\n'));

    console.log(`Scanning every ${SCAN_INTERVAL}ms...\n`);

    setInterval(async () => {
        try {
            const scanStart = Date.now();
            const block = await provider.getBlockNumber();

            const poolKeys = Object.keys(POOLS);
            const poolResultsArr = await Promise.all(poolKeys.map(k => readPoolPrice(k)));
            const poolResults = Object.fromEntries(poolKeys.map((k, i) => [k, poolResultsArr[i]]));

            const okCount = poolResultsArr.filter(r => r.ok).length;
            const quotedCount = poolResultsArr.filter(r => r.quoted).length;
            const elapsed = ((Date.now() - scanStart) / 1000).toFixed(2);
            const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

            const wethPrice = extractPrice(poolResults['WETH_USDC_UNI'], WETH, USDC) || 0;
            const wbtcPrice = extractPrice(poolResults['WBTC_WETH_UNI'], WBTC, WETH) || 0;
            const wbtcUsd = wbtcPrice * wethPrice;
            const spotPrices = { weth: wethPrice.toFixed(0), wbtc: wbtcUsd.toFixed(0) };

            console.log(`\n[${now}] Block ${block} | ${elapsed}s | ${okCount}/${poolKeys.length} pools (${quotedCount} quoted)`);
            console.log(`  Prices: WETH $${wethPrice.toFixed(0)} | WBTC $${wbtcUsd.toFixed(0)}`);

            let hasAlert = false;
            const alerts = [];

            for (const tri of TRIANGLES) {
                const directions = [tri.fwd, tri.rev].filter(Boolean);
                for (const dir of directions) {
                    const result = calcTriangleEdge(dir.legs, poolResults);
                    const { single, split } = result;
                    if (single.edgePct === null) continue;

                    const sNet = single.edgePct;
                    const spNet = split.edgePct || 0;
                    const sProfit = single.profitUSD || 0;
                    const spProfit = split.profitUSD || 0;

                    const bestIsSplit = spProfit > sProfit && spProfit > 0;
                    const bestProfit = bestIsSplit ? spProfit : sProfit;
                    const bestNet = bestIsSplit ? spNet : sNet;
                    const bestLabel = bestIsSplit ? 'SPLIT' : 'SINGLE';

                    const icon = bestNet > 0 ? '🟢' : '🔴';
                    console.log(`  ${icon} ${dir.name}`);
                    console.log(`     Single: net=${sNet.toFixed(3)}%  $${sProfit.toFixed(2)}  [fee=${single.feePct.toFixed(3)}% nominal]`);
                    if (single.pools) console.log(`     Pools:  ${single.pools.map(k => POOLS[k]?.label || k).join(' > ')}`);
                    console.log(`     Split:  net=${spNet.toFixed(3)}%  $${spProfit.toFixed(2)}`);

                    // Log every block for data collection — see how close spreads get
                    logToCSV(block, tri.name, dir.name, single, split, spotPrices);

                    if (bestProfit > MIN_PROFIT_USD && bestNet > 0) {
                        hasAlert = true;
                        alerts.push({
                            triangle: tri.name, name: dir.name,
                            sNet: bestNet, spNet, profit: bestProfit,
                            signalLegs: bestIsSplit ? split.legs : single.legs,
                            pathType: bestLabel,
                        });
                    }
                }
            }

            if (!hasAlert) console.log(`  ⏳ No profitable opportunities this block`);

            alerts.sort((a, b) => b.profit - a.profit);
            for (const a of alerts) {
                await sendTelegram([
                    `*PREDATOR v3.2 ARB — ${a.pathType} SIGNAL*`,
                    `Path: \`${a.name}\``,
                    `Edge: \`+${a.sNet.toFixed(3)}%\` ($${a.profit.toFixed(2)} at $${INPUT_USD / 1000}k)`,
                    `Block: ${block}`,
                    `WETH $${wethPrice.toFixed(0)} | WBTC $${wbtcUsd.toFixed(0)}`,
                    `Mode: ${wallet ? 'LIVE' : 'DRY-RUN'} | Dynamic Sizing`,
                ].join('\n'));

                if (wallet) {
                    const result = await executeArb(a.triangle, a.name, a.signalLegs, poolResults);
                    if (result?.success) {
                        await sendTelegram([
                            `*✅ TRADE EXECUTED — ARBITRUM*`,
                            `Hash: \`${result.hash}\``,
                            `https://arbiscan.io/tx/${result.hash}`,
                            `Block: ${result.block} | Path: ${a.name}`,
                        ].join('\n'));
                    } else if (result && !result.success) {
                        const failLines = [`*❌ TRADE FAILED*`];
                        if (result.hash) {
                            failLines.push(`Hash: \`${result.hash}\``);
                            failLines.push(`https://arbiscan.io/tx/${result.hash}`);
                        }
                        failLines.push(`Path: ${a.name}`);
                        failLines.push(`${result.error?.slice(0, 100) || 'reverted'}`);
                        await sendTelegram(failLines.join('\n'));
                    }
                }
            }
        } catch (err) {
            console.error(`Scan error: ${err.message.slice(0, 100)}`);
        }
    }, SCAN_INTERVAL);
}

main().catch(console.error);