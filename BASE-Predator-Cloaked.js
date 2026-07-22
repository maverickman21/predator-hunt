// ─── PREDATOR LISTENER v3.2 ───────────────────────────────────────────────────
// QuoterV2 integration — real execution prices replace spot mid-prices
//
// CHANGES FROM v3.1:
//  - QuoterV2 quotes now use correct USD-equivalent amounts per token
//    (v3.1 bug: quoted 100 WETH = $200k instead of $100 worth of WETH)
//  - Fee double-counting FIXED — QuoterV2 output already includes pool fees,
//    calcTriangleEdge no longer subtracts fees again
//  - Pool selection changed from "cheapest fee" to "best execution price"
//    (with QuoterV2, the price already reflects fees + liquidity depth)
//  - buildDynamicLegs decimal conversion FIXED — minAmountOut now provides
//    real per-leg slippage protection instead of effectively zero
//  - MIN_PROFIT_USD = $1 for diagnostic signal collection
//
// Triangles:
//   cbBTC:   USDC <-> cbBTC <-> WETH  (split routing, $5k)
//   AERO:    USDC <-> WETH <-> AERO   (single path, $5k)
//   VIRTUAL: USDC <-> WETH <-> VIRTUAL (single path, $15k)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────
const ALCHEMY_API_URL = process.env.ALCHEMY_API_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.CHAT_ID;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDR = process.env.PREDATOR_CONTRACT;

const INPUT_USD = 5000;           // signal calculation size (base scan)
const SCAN_INTERVAL = 250;             // 250ms — aligned with Flashblocks 200ms cadence
const SLIPPAGE = 0.0075;         // 0.75% per-leg slippage tolerance
const MIN_PROFIT_USD = 1.0;            // $1 min at $5k scan — triggers dynamic sizing
const MIN_EXECUTE_USD = 8.0;            // $8 min at optimal size — actually sends TX
const EXEC_COOLDOWN = 3;              // blocks between executions

// ─── Dynamic Flash Loan Sizing ───────────────────────────────────────────────
// When a signal fires at $5k, re-quote the path at multiple sizes in parallel.
// Pick the size with the highest total dollar profit.
// Bigger sizes capture more dollars but price impact reduces the edge percentage.
// The optimal size is where total dollar profit peaks before impact eats it.
const DYNAMIC_SIZES = [5000, 10000, 25000, 50000]; // USD amounts to test

// ─── Flashblocks Config ──────────────────────────────────────────────────────
// Base Flashblocks: 200ms preconfirmation blocks, 10x faster than standard 2s blocks.
// Using 'pending' blockTag reads the latest flashblock state (~200ms fresh)
// instead of 'latest' which is up to 2s stale. This dramatically reduces
// the quote-to-execution timing gap that was killing our marginal trades.
const BLOCK_TAG = 'pending'; // Read latest flashblock state for all quotes

// Gas config
const GAS_TIP_NORMAL = '0.1';   // gwei — higher tip = earlier in flashblock ordering
const GAS_TIP_EVENT = '0.5';   // gwei — volatility events
const GAS_LIMIT = 1_200_000n;

// ─── Token Addresses ──────────────────────────────────────────────────────────
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const msUSD = '0x526728dbc96689597f85ae4cd716d4f7fccbae9d';
const msETH = '0x7ba6f01772924a82d9626c126347a28299e98c98';

const DECIMALS = {
    [USDC]: 6, [WETH]: 18, [cbBTC]: 8, [VIRTUAL]: 18, [AERO]: 18,
    [msUSD]: 18, [msETH]: 18,
};

// ─── Approximate USD prices for QuoterV2 sizing ───────────────────────────────
// These don't need to be exact — just close enough so we quote ~$5k worth
// of each token instead of 5000 raw units. Updated periodically.
const USD_PRICE_APPROX = {
    [USDC]: 1,
    [WETH]: 2100,
    [cbBTC]: 70000,
    [VIRTUAL]: 1.0,
    [AERO]: 0.8,
    [msUSD]: 1.0,
    [msETH]: 2100,
};

// ─── Pool Universe ─────────────────────────────────────────────────────────────
// ALL TVL figures verified directly from DEX interfaces March 2026
// type    = clAMM6 (Aerodrome Slipstream) | clAMM7 (UniV3/Pancake) | vAMM
// poolType = 0 UniV3/Slipstream | 1 PancakeV3 | 2 vAMM

const POOLS = {

    // ── WETH/USDC ──────────────────────────────────────────────────────────────
    WETH_USDC_UNI_BIG: {
        address: '0x6c561b446416e1a00e8e93e221854d6ea4171372',
        type: 'clAMM7', fee: 0.000500, tvl: 89000000, feeBps: 500, poolType: 0,
        label: 'WETH/USDC Uniswap 0.05% $89M ★', token0: WETH, token1: USDC,
    },
    WETH_USDC_AERO: {
        address: '0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59',
        type: 'clAMM6', fee: 0.000550, tvl: 22000000, feeBps: 550, poolType: 0,
        label: 'WETH/USDC Aerodrome 0.055% $22M', token0: USDC, token1: WETH,
    },
    WETH_USDC_AERO2: {
        address: '0xcdac0d6c6c59727a65f871236188350531885c43',
        type: 'vAMM', fee: 0.000550, tvl: 11000000, feeBps: 550, poolType: 2,
        label: 'WETH/USDC Aerodrome V2 0.055% $11M', token0: USDC, token1: WETH,
    },
    WETH_USDC_UNI_OLD: {
        address: '0xd0b53d9277642d899df5c87a3966a349a798f224',
        type: 'clAMM7', fee: 0.000500, tvl: 13000000, feeBps: 500, poolType: 0,
        label: 'WETH/USDC Uniswap 0.05% $13M', token0: USDC, token1: WETH,
    },
    WETH_USDC_PANCAKE: {
        address: '0x72ab388e2e2f6facef59e3c3fa2c4e29011c2d38',
        type: 'clAMM7', fee: 0.000100, tvl: 4900000, feeBps: 100, poolType: 1,
        label: 'WETH/USDC Pancake 0.01% $4.9M', token0: WETH, token1: USDC,
    },
    WETH_USDC_PANCAKE2: {
        address: '0xb775272e537cc670c65dc852908ad47015244eaf',
        type: 'clAMM7', fee: 0.000250, tvl: 2300000, feeBps: 250, poolType: 1,
        label: 'WETH/USDC Pancake #2 $2.3M', token0: WETH, token1: USDC,
    },

    // ── cbBTC/WETH ─────────────────────────────────────────────────────────────
    cbBTC_WETH_AERO: {
        address: '0x70acdf2ad0bf2402c957154f944c19ef4e1cbae1',
        type: 'clAMM6', fee: 0.000220, tvl: 26000000, feeBps: 220, poolType: 0,
        label: 'cbBTC/WETH Aerodrome 0.022% $26M ★', token0: cbBTC, token1: WETH,
    },
    cbBTC_WETH_UNI: {
        address: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
        type: 'clAMM7', fee: 0.000500, tvl: 9000000, feeBps: 500, poolType: 0,
        label: 'cbBTC/WETH Uniswap 0.05% $9M', token0: WETH, token1: cbBTC,
    },
    cbBTC_WETH_PANCAKE: {
        address: '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
        type: 'clAMM7', fee: 0.000100, tvl: 7400000, feeBps: 100, poolType: 1,
        label: 'cbBTC/WETH Pancake 0.01% $7.4M', token0: cbBTC, token1: WETH,
    },

    // ── USDC/cbBTC ─────────────────────────────────────────────────────────────
    cbBTC_USDC_AERO: {
        address: '0x4e962bb3889bf030368f56810a9c96b83cb3e778',
        type: 'clAMM6', fee: 0.000312, tvl: 12000000, feeBps: 312, poolType: 0,
        label: 'cbBTC/USDC Aerodrome 0.031% $12M ★', token0: cbBTC, token1: USDC,
    },
    cbBTC_USDC_UNI: {
        address: '0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef',
        type: 'clAMM7', fee: 0.000500, tvl: 7800000, feeBps: 500, poolType: 0,
        label: 'cbBTC/USDC Uniswap 0.05% $7.8M', token0: cbBTC, token1: USDC,
    },
    cbBTC_USDC_PANCAKE: {
        address: '0xb94b22332abf5f89877a14cc88f2abc48c34b3df',
        type: 'clAMM7', fee: 0.000100, tvl: 2500000, feeBps: 100, poolType: 1,
        label: 'cbBTC/USDC Pancake 0.01% $2.5M', token0: cbBTC, token1: USDC,
    },

    // ── USDC/AERO ──────────────────────────────────────────────────────────────
    AERO_USDC_AERO: {
        address: '0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d',
        type: 'vAMM', fee: 0.000200, tvl: 22000000, feeBps: 200, poolType: 2,
        label: 'USDC/AERO Aerodrome V2 0.02% $22M ★', token0: USDC, token1: AERO,
    },

    // ── AERO/WETH ──────────────────────────────────────────────────────────────
    AERO_WETH_AERO1: {
        address: '0x7f670f78b17dec44d5ef68a48740b6f8849cc2e6',
        type: 'vAMM', fee: 0.000300, tvl: 2500000, feeBps: 300, poolType: 2,
        label: 'WETH/AERO Aerodrome V2 0.03% $2.5M', token0: WETH, token1: AERO,
    },
    AERO_WETH_AERO2: {
        address: '0x82321f3beb69f503380d6b233857d5c43562e2d0',
        type: 'clAMM6', fee: 0.000300, tvl: 1600000, feeBps: 300, poolType: 0,
        label: 'WETH/AERO Aerodrome #2 0.03% $1.6M', token0: WETH, token1: AERO,
    },

    // ── VIRTUAL/WETH ───────────────────────────────────────────────────────────
    VIRTUAL_WETH_AERO: {
        address: '0x21594b992f68495dd28d605834b58889d0a727c7',
        type: 'vAMM', fee: 0.000300, tvl: 5800000, feeBps: 300, poolType: 2,
        label: 'VIRTUAL/WETH Aerodrome V2 0.03% $5.8M ★', token0: VIRTUAL, token1: WETH,
    },
    VIRTUAL_WETH_UNI: {
        address: '0x9c087eb773291e50cf6c6a90ef0f4500e349b903',
        type: 'clAMM7', fee: 0.000500, tvl: 838000, feeBps: 500, poolType: 0,
        label: 'VIRTUAL/WETH Uniswap 0.05%', token0: VIRTUAL, token1: WETH,
    },

    // ── msUSD/USDC ─────────────────────────────────────────────────────────────
    // Slipstream $17M + vAMM $5M — stablecoin depeg arb
    msUSD_USDC_AERO: {
        address: '0x7501bc8bb51616f79bfa524e464fb7b41f0b10fb',
        type: 'clAMM6', fee: 0.000100, tvl: 17000000, feeBps: 100, poolType: 0,
        label: 'msUSD/USDC Aerodrome SL $17M ★', token0: msUSD, token1: USDC,
    },
    msUSD_USDC_AERO_V2: {
        address: '0xcefc8b799a8ee5d9b312aeca73262645d664aaf7',
        type: 'vAMM', fee: 0.000300, tvl: 5000000, feeBps: 300, poolType: 2,
        label: 'msUSD/USDC Aerodrome V2 $5M', token0: msUSD, token1: USDC,
    },

    // ── msETH/WETH ─────────────────────────────────────────────────────────────
    // Slipstream $18M — ETH derivative, deep liquidity
    msETH_WETH_AERO: {
        address: '0x74f72788f4814d7ff3c49b44684aa98eee140c0e',
        type: 'clAMM6', fee: 0.000100, tvl: 18000000, feeBps: 100, poolType: 0,
        label: 'msETH/WETH Aerodrome SL $18M ★', token0: WETH, token1: msETH,
    },

    // ── msUSD/msETH ────────────────────────────────────────────────────────────
    // Slipstream $1.2M — synthetic cross-pair, bottleneck pool
    msUSD_msETH_AERO: {
        address: '0x8845126640b36df1d24bf3df9b2903fd4c730fe6',
        type: 'clAMM6', fee: 0.000300, tvl: 1200000, feeBps: 300, poolType: 0,
        label: 'msUSD/msETH Aerodrome SL $1.2M', token0: msUSD, token1: msETH,
    },
};

// ─── Triangle Definitions ──────────────────────────────────────────────────────
const TRIANGLES = [
    {
        name: 'cbBTC',
        fwd: {
            name: 'USDC → cbBTC → WETH → USDC',
            legs: [
                { from: USDC, to: cbBTC, pools: ['cbBTC_USDC_PANCAKE', 'cbBTC_USDC_AERO', 'cbBTC_USDC_UNI'] },
                { from: cbBTC, to: WETH, pools: ['cbBTC_WETH_PANCAKE', 'cbBTC_WETH_AERO', 'cbBTC_WETH_UNI'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_PANCAKE', 'WETH_USDC_UNI_BIG', 'WETH_USDC_AERO', 'WETH_USDC_UNI_OLD'] },
            ],
        },
        rev: {
            name: 'USDC → WETH → cbBTC → USDC',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_PANCAKE', 'WETH_USDC_UNI_BIG', 'WETH_USDC_AERO', 'WETH_USDC_UNI_OLD'] },
                { from: WETH, to: cbBTC, pools: ['cbBTC_WETH_PANCAKE', 'cbBTC_WETH_AERO', 'cbBTC_WETH_UNI'] },
                { from: cbBTC, to: USDC, pools: ['cbBTC_USDC_PANCAKE', 'cbBTC_USDC_AERO', 'cbBTC_USDC_UNI'] },
            ],
        },
    },
    {
        name: 'WETH-2leg',
        // 2-leg cross-DEX: buy WETH cheap on one DEX, sell dear on another
        // Fee floor: 0.01% + 0.05% = 0.06% — lower than any triangle
        fwd: {
            name: 'USDC → WETH(Pancake) → USDC(Uni/Aero)',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_PANCAKE'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_UNI_BIG', 'WETH_USDC_AERO', 'WETH_USDC_UNI_OLD'] },
            ],
        },
        rev: {
            name: 'USDC → WETH(Uni/Aero) → USDC(Pancake)',
            legs: [
                { from: USDC, to: WETH, pools: ['WETH_USDC_UNI_BIG', 'WETH_USDC_AERO', 'WETH_USDC_UNI_OLD'] },
                { from: WETH, to: USDC, pools: ['WETH_USDC_PANCAKE'] },
            ],
        },
    },
    {
        // DISABLED: AERO_USDC vAMM 0.3% + AERO_WETH vAMM 1% = 0.38% fee floor.
        // Shows -$30 to -$40 consistently. Would need 1%+ dislocation to profit.
        fwd: null,
        rev: null,
    },
    {
        name: 'VIRTUAL',
        // DISABLED: Both VIRTUAL/WETH pools are vAMM with 1% factory fees.
        // 2.1% total fee floor — needs 2%+ depeg to profit, effectively never fires.
        fwd: null,
        rev: null,
    },
    {
        name: 'msETH',
        // DISABLED: msUSD/msETH pool uses factory 0xaDe65c38 which has no QuoterV2 deployed.
        // The MixedRouteQuoterV1 (0xE2af5F) points to a different factory (0x9592CD).
        // Cannot get execution-accurate pricing. Re-enable if Aerodrome deploys a quoter,
        // or replicate this triangle on Arbitrum where quoter coverage is complete.
        fwd: null,
        rev: null,
    },
];

// ─── QuoterV2 Addresses ──────────────────────────────────────────────────────
const UNISWAP_QUOTER_V2 = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const PANCAKE_QUOTER_V2 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';

// Aerodrome has TWO Slipstream deployments with different factories and quoters
// Each pool's factory determines which quoter to use
// The older deployment uses MixedRouteQuoterV1 with quoteExactInputSingleV3 for CL pools
const AERO_QUOTER_NEWER = '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0';
const AERO_QUOTER_OLDER = '0xE2af5FdE219B4c6047AAEc44444f120675b406E2';
const AERO_FACTORY_QUOTER_MAP = {
    '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a': AERO_QUOTER_NEWER,
    '0xade65c38cd4849adba595a4323a8c7ddfe89716a': AERO_QUOTER_OLDER,
};
const POOL_QUOTER = {}; // poolKey → quoter address, populated at startup

// Uniswap V3 / PancakeSwap V3 QuoterV2 — uses fee (uint24) to identify pool
const QUOTER_V2_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// Aerodrome Slipstream QuoterV2 (newer) — uses tickSpacing (int24) instead of fee
const AERO_QUOTER_V2_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

// Aerodrome MixedRouteQuoterV1 (older) — quoteExactInputSingleV3 is internal only
// Must use quoteExactInput with path-encoded bytes: tokenIn(20) + tickSpacing(3) + tokenOut(20)
const AERO_MIXED_QUOTER_ABI = [
    'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)',
];

// ─── ABIs ──────────────────────────────────────────────────────────────────────
const CLAMM6_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function tickSpacing() view returns (int24)',
];
const CLAMM7_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];
const VAMM_ABI = [
    'function getReserves() view returns (uint256, uint256, uint256)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];
const PREDATOR_ABI = [
    'function trigger(uint256 borrowAmount, tuple(address pool, address tokenIn, address tokenOut, uint24 fee, uint8 poolType, uint256 minAmountOut, bool useBalance, uint256 splitAmount)[] legs, uint256 minFinalReturn) external',
    'function paused() view returns (bool)',
];

// ─── Provider + Wallet ────────────────────────────────────────────────────────
let provider;
let wallet;

async function initProvider() {
    provider = new ethers.JsonRpcProvider(ALCHEMY_API_URL);
    await provider.getBlockNumber();
    if (PRIVATE_KEY && CONTRACT_ADDR) {
        wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log('✅ Base provider connected — EXECUTION MODE');
        console.log(`   Wallet:   ${wallet.address}`);
        console.log(`   Contract: ${CONTRACT_ADDR}`);
    } else {
        console.log('✅ Base provider connected — DRY-RUN MODE');
    }
}

// ─── Pool Cache Init ──────────────────────────────────────────────────────────
// Queries immutable pool data ONCE at startup:
//   - token0/token1 addresses (never change, saves 24 RPC calls per scan)
//   - tickSpacing for Aerodrome Slipstream pools (needed for QuoterV2)
//
// For the 4 Aerodrome pools that reject standard ABI calls, we probe with
// raw eth_call using known function selectors and try multiple return decodings.
// Aerodrome has multiple deployments — some use a different slot0 signature.

const TICK_SPACINGS = {};              // poolKey → int24 tickSpacing
const TOKEN_CACHE = {};              // poolKey → { t0: address, t1: address }
const COMMON_TICK_SPACINGS = [1, 10, 50, 100, 200];

// Known function selectors
const SEL_TOKEN0 = '0x0dfe1681';  // token0()
const SEL_TOKEN1 = '0xd21220a7';  // token1()
const SEL_TICK_SPACING = '0xd0c93a7c'; // tickSpacing()
const SEL_SLOT0 = '0x3850c7bd';  // slot0()

// Multiple ABI variants for Aerodrome pools — different deployments use different slot0 signatures
const SLOT0_ABIS = [
    // Standard Aerodrome Slipstream (6 returns)
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
    // UniV3-style (7 returns — some Aerodrome forks use this)
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    // Minimal (just sqrtPrice and tick — some proxies truncate)
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
];

async function initPoolCache() {
    const allPools = Object.entries(POOLS);
    const aeroPools = allPools.filter(([, p]) => p.type === 'clAMM6');

    // ── Phase 1: Cache token0/token1 for ALL pools ────────────────────────
    console.log(`  Caching token0/token1 for ${allPools.length} pools...`);

    await Promise.all(
        allPools.map(async ([key, p]) => {
            try {
                // Try typed ABI first (fast path)
                const abi = ['function token0() view returns (address)', 'function token1() view returns (address)'];
                const c = new ethers.Contract(p.address, abi, provider);
                const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
                TOKEN_CACHE[key] = { t0: t0.toLowerCase(), t1: t1.toLowerCase() };
            } catch {
                // Fallback: raw eth_call
                try {
                    const [t0raw, t1raw] = await Promise.all([
                        provider.call({ to: p.address, data: SEL_TOKEN0 }),
                        provider.call({ to: p.address, data: SEL_TOKEN1 }),
                    ]);
                    const decode = ethers.AbiCoder.defaultAbiCoder();
                    const t0 = decode.decode(['address'], t0raw)[0].toLowerCase();
                    const t1 = decode.decode(['address'], t1raw)[0].toLowerCase();
                    TOKEN_CACHE[key] = { t0, t1 };
                    console.log(`    ${key}: tokens resolved via raw call`);
                } catch (e) {
                    console.error(`    ${key}: FAILED to read tokens — ${e.message.slice(0, 50)}`);
                }
            }
        })
    );

    const tokenOk = Object.keys(TOKEN_CACHE).length;
    console.log(`  ✅ Tokens cached: ${tokenOk}/${allPools.length}`);

    // ── Phase 1b: Map Aerodrome pools to their correct QuoterV2 ───────────
    // Aerodrome has multiple factory deployments, each with its own QuoterV2.
    // Query factory() on each clAMM6 pool and look up the paired quoter.
    console.log(`  Mapping ${aeroPools.length} Aerodrome pools to QuoterV2...`);
    const FACTORY_QUERY_ABI = ['function factory() view returns (address)'];

    await Promise.all(
        aeroPools.map(async ([key, p]) => {
            try {
                const c = new ethers.Contract(p.address, FACTORY_QUERY_ABI, provider);
                const factory = (await c.factory()).toLowerCase();
                const quoter = AERO_FACTORY_QUOTER_MAP[factory];
                if (quoter) {
                    POOL_QUOTER[key] = quoter;
                    console.log(`    ${key}: factory=${factory.slice(0, 10)}... → quoter=${quoter.slice(0, 10)}...`);
                } else {
                    console.error(`    ${key}: unknown factory ${factory} — no quoter mapped!`);
                }
            } catch (e) {
                console.error(`    ${key}: FAILED to query factory — ${e.message.slice(0, 50)}`);
            }
        })
    );

    // ── Phase 2: Resolve tick spacings for Aerodrome pools ────────────────
    console.log(`  Resolving tick spacings for ${aeroPools.length} Aerodrome pools...`);

    // Phase 2a: try typed tickSpacing() call
    const phase2aFailed = [];
    await Promise.all(
        aeroPools.map(async ([key, p]) => {
            try {
                const c = new ethers.Contract(p.address, [...CLAMM6_ABI], provider);
                const ts = await c.tickSpacing();
                TICK_SPACINGS[key] = Number(ts);
                console.log(`    ${key}: tickSpacing = ${TICK_SPACINGS[key]} (direct)`);
            } catch {
                phase2aFailed.push(key);
            }
        })
    );

    // Phase 2b: raw eth_call for tickSpacing selector
    const phase2bFailed = [];
    if (phase2aFailed.length > 0) {
        console.log(`    Trying raw selectors for ${phase2aFailed.length} pools...`);
        for (const key of phase2aFailed) {
            try {
                const data = await provider.call({ to: POOLS[key].address, data: SEL_TICK_SPACING });
                if (data && data !== '0x') {
                    // Try decoding as int24, uint24, int256 (different ABIs encode differently)
                    const decode = ethers.AbiCoder.defaultAbiCoder();
                    let ts;
                    try { ts = Number(decode.decode(['int24'], data)[0]); } catch { }
                    if (!ts) try { ts = Number(decode.decode(['int256'], data)[0]); } catch { }
                    if (ts && ts > 0 && ts <= 1000) {
                        TICK_SPACINGS[key] = ts;
                        console.log(`    ${key}: tickSpacing = ${ts} (raw selector)`);
                        continue;
                    }
                }
                phase2bFailed.push(key);
            } catch {
                phase2bFailed.push(key);
            }
        }
    }

    // Phase 2c: read slot0 with multiple ABI variants, then cross-validate against QuoterV2
    if (phase2bFailed.length > 0) {
        console.log(`    Probing ${phase2bFailed.length} pools with multiple slot0 ABIs...`);

        for (const key of phase2bFailed) {
            const p = POOLS[key];
            const tokens = TOKEN_CACHE[key];
            if (!tokens) { console.error(`    ${key}: no cached tokens — skipping`); continue; }

            // Use the pool's mapped quoter
            const quoterAddr = POOL_QUOTER[key];
            if (!quoterAddr) { console.error(`    ${key}: no quoter mapped — skipping`); continue; }
            const isOlder = quoterAddr === AERO_QUOTER_OLDER;
            const qAbi = isOlder ? AERO_MIXED_QUOTER_ABI : AERO_QUOTER_V2_ABI;
            if (!quoterCache[quoterAddr]) {
                quoterCache[quoterAddr] = new ethers.Contract(quoterAddr, qAbi, provider);
            }
            const quoter = quoterCache[quoterAddr];

            // Try raw slot0 call first — see if the function exists at all
            let poolSqrtPrice = null;
            try {
                const slot0Data = await provider.call({ to: p.address, data: SEL_SLOT0 });
                if (slot0Data && slot0Data.length >= 66) {
                    // sqrtPriceX96 is always the first uint160 (first 32 bytes)
                    const decode = ethers.AbiCoder.defaultAbiCoder();
                    // Decode just the first value as uint256 — sqrtPriceX96 fits in it
                    const sqrtP = decode.decode(['uint256'], '0x' + slot0Data.slice(2, 66))[0];
                    poolSqrtPrice = BigInt(sqrtP);
                    console.log(`    ${key}: slot0 raw OK — sqrtPrice=${poolSqrtPrice.toString().slice(0, 20)}...`);
                }
            } catch (e) {
                console.log(`    ${key}: slot0 raw failed — ${e.message.slice(0, 40)}`);
            }

            // Also try typed ABI variants
            if (!poolSqrtPrice) {
                for (const abiStr of SLOT0_ABIS) {
                    try {
                        const c = new ethers.Contract(p.address, [abiStr], provider);
                        const slot0 = await c.slot0();
                        poolSqrtPrice = BigInt(slot0[0]);
                        console.log(`    ${key}: slot0 via variant ABI — sqrtPrice=${poolSqrtPrice.toString().slice(0, 20)}...`);
                        break;
                    } catch { }
                }
            }

            if (!poolSqrtPrice) {
                console.error(`    ${key}: FAILED — cannot read slot0 with any method`);
                continue;
            }

            // Cross-validate: try each tick spacing against QuoterV2
            const dec0 = DECIMALS[tokens.t0] || 18;
            const tokenPriceUsd = USD_PRICE_APPROX[tokens.t0] || 1;
            const amountIn = BigInt(Math.floor((10 / tokenPriceUsd) * (10 ** dec0)));

            let found = false;
            for (const ts of COMMON_TICK_SPACINGS) {
                try {
                    let quoterSqrtPrice;
                    if (isOlder) {
                        // MixedRouteQuoterV1: path-encoded quoteExactInput
                        const tsHex = ethers.zeroPadValue(ethers.toBeHex(ts), 3);
                        const path = ethers.concat([tokens.t0, tsHex, tokens.t1]);
                        const result = await quoter.quoteExactInput.staticCall(path, amountIn);
                        quoterSqrtPrice = BigInt(result[1][0]); // sqrtPriceX96AfterList[0]
                    } else {
                        // Standard QuoterV2
                        const result = await quoter.quoteExactInputSingle.staticCall({
                            tokenIn: tokens.t0,
                            tokenOut: tokens.t1,
                            amountIn: amountIn,
                            tickSpacing: ts,
                            sqrtPriceLimitX96: 0n,
                        });
                        quoterSqrtPrice = BigInt(result[1]);
                    }
                    const diff = Number(quoterSqrtPrice - poolSqrtPrice);
                    const pctDiff = Math.abs(diff / Number(poolSqrtPrice)) * 100;

                    if (pctDiff < 0.5) {
                        TICK_SPACINGS[key] = ts;
                        console.log(`    ${key}: tickSpacing = ${ts} (cross-validated, ${pctDiff.toFixed(4)}% diff)`);
                        found = true;
                        break;
                    } else {
                        console.log(`      ${key}: ts=${ts} rejected — ${pctDiff.toFixed(2)}% diff (wrong pool)`);
                    }
                } catch { }
            }
            if (!found) {
                console.error(`    ${key}: FAILED — no tick spacing matched this pool`);
            }
        }
    }

    const tsOk = Object.keys(TICK_SPACINGS).length;
    console.log(`  ✅ Tick spacings resolved: ${tsOk}/${aeroPools.length}`);
    if (tsOk < aeroPools.length) {
        const missing = aeroPools.filter(([k]) => !TICK_SPACINGS[k]).map(([k]) => k);
        console.log(`  ⚠️  Missing: ${missing.join(', ')} — these pools will be skipped`);
    }

    // ── Phase 3: Query ACTUAL fees from PoolFactory for vAMM pools ────────
    // Aerodrome V2 vAMM pools have DYNAMIC fees set by the PoolFactory.
    // The fee shown on the DEX interface may be from a different pool.
    // PoolFactory.getFee(pool, stable) returns fee in basis points (100 = 1%).
    // Our feeBps encoding uses hundredths of a bip: our_feeBps = aero_fee * 100
    const vammPools = allPools.filter(([, p]) => p.type === 'vAMM');
    if (vammPools.length > 0) {
        console.log(`  Querying actual fees for ${vammPools.length} vAMM pools...`);
        const FACTORY_ABI = [
            'function factory() view returns (address)',
            'function stable() view returns (bool)',
        ];
        const POOL_FACTORY_ABI = [
            'function getFee(address pool, bool stable) view returns (uint256)',
        ];

        for (const [key, p] of vammPools) {
            try {
                const poolContract = new ethers.Contract(p.address, FACTORY_ABI, provider);
                const [factoryAddr, isStable] = await Promise.all([
                    poolContract.factory(),
                    poolContract.stable(),
                ]);
                const factory = new ethers.Contract(factoryAddr, POOL_FACTORY_ABI, provider);
                const aeroFee = await factory.getFee(p.address, isStable);
                const aeroFeeBps = Number(aeroFee); // Aerodrome basis points (100 = 1%)

                // Convert: Aerodrome fee 100 (1%) → our encoding 10000 hundredths-of-bip
                // Aerodrome: fee / 10000 = decimal rate
                // Ours: feeBps / 1_000_000 = decimal rate
                // So: our_feeBps = aero_fee * 100
                const ourFeeBps = aeroFeeBps * 100;
                const oldFee = p.fee;
                const newFee = ourFeeBps / 1_000_000;

                // Update pool definition in place
                POOLS[key].fee = newFee;
                POOLS[key].feeBps = ourFeeBps;

                const changed = Math.abs(oldFee - newFee) > 0.000001;
                console.log(`    ${key}: factory fee = ${aeroFeeBps}bp (${(newFee * 100).toFixed(3)}%)${changed ? ` ← CHANGED from ${(oldFee * 100).toFixed(3)}%` : ''}`);
            } catch (e) {
                console.error(`    ${key}: FAILED to query factory fee — ${e.message.slice(0, 50)}`);
                console.error(`    ⚠️  Using configured fee ${(p.fee * 100).toFixed(3)}% — may be wrong!`);
            }
        }
    }
}

// ─── Price Reading (QuoterV2 — Bidirectional) ─────────────────────────────────
// Uses TOKEN_CACHE from startup — zero token0/token1 RPC calls per scan.
// Quotes BOTH directions: token0→token1 AND token1→token0.
// V3 price impact is directional — no more 1/price inversion.
//
// IMPORTANT: QuoterV2 output ALREADY INCLUDES the pool fee deduction.
// Do NOT subtract fees again in calcTriangleEdge or buildDynamicLegs.

const quoterCache = {};

async function readPoolPrice(poolKey) {
    const p = POOLS[poolKey];

    // Use cached tokens — queried once at startup, never changes
    const tokens = TOKEN_CACHE[poolKey];
    if (!tokens) return { ok: false, error: `No cached tokens for ${poolKey}` };
    const t0 = tokens.t0, t1 = tokens.t1;
    const dec0 = DECIMALS[t0] || 18, dec1 = DECIMALS[t1] || 18;

    try {
        // Skip unresolved Slipstream pools entirely — vAMM math is wrong for CL pools
        if (p.type === 'clAMM6' && !TICK_SPACINGS[poolKey]) {
            return { ok: false, error: `No tickSpacing for ${poolKey} — skipped` };
        }

        if (p.type === 'vAMM') {
            // vAMM: use reserves for both directions (xy=k is exact here)
            const c = new ethers.Contract(p.address, VAMM_ABI, provider);
            const res = await c.getReserves({ blockTag: BLOCK_TAG });
            const r0 = Number(res[0]) / (10 ** dec0);
            const r1 = Number(res[1]) / (10 ** dec1);

            const feeMultiplier = 1 - p.fee;
            // Forward: t0 → t1
            const t0Price = USD_PRICE_APPROX[t0] || 1;
            const t0In = INPUT_USD / t0Price;
            const t0InWithFee = t0In * feeMultiplier;
            const t1Out = (t0InWithFee * r1) / (r0 + t0InWithFee);
            const t0inT1 = t1Out / t0In;

            // Reverse: t1 → t0
            const t1Price = USD_PRICE_APPROX[t1] || 1;
            const t1In = INPUT_USD / t1Price;
            const t1InWithFee = t1In * feeMultiplier;
            const t0Out = (t1InWithFee * r0) / (r1 + t1InWithFee);
            const t1inT0 = t0Out / t1In;

            return { t0, t1, t0inT1, t1inT0, ok: true };
        } else {
            // clAMM: QuoterV2 for BOTH directions — no token queries needed
            const t0Price = USD_PRICE_APPROX[t0] || 1;
            const t1Price = USD_PRICE_APPROX[t1] || 1;
            const t0Amount = INPUT_USD / t0Price;
            const t1Amount = INPUT_USD / t1Price;
            const amountInFwd = BigInt(Math.floor(t0Amount * (10 ** dec0)));
            const amountInRev = BigInt(Math.floor(t1Amount * (10 ** dec1)));

            // Select quoter — Aerodrome pools use their mapped quoter from startup
            const isAero = p.type === 'clAMM6';
            const quoterAddr = isAero ? POOL_QUOTER[poolKey]
                : p.poolType === 1 ? PANCAKE_QUOTER_V2
                    : UNISWAP_QUOTER_V2;
            if (!quoterAddr) return { ok: false, error: `No quoter for ${poolKey}` };
            const isOlderAero = quoterAddr === AERO_QUOTER_OLDER;
            const quoterAbi = isOlderAero ? AERO_MIXED_QUOTER_ABI
                : isAero ? AERO_QUOTER_V2_ABI
                    : QUOTER_V2_ABI;
            if (!quoterCache[quoterAddr]) {
                quoterCache[quoterAddr] = new ethers.Contract(quoterAddr, quoterAbi, provider);
            }
            const quoter = quoterCache[quoterAddr];

            let fwdResult, revResult;

            if (isOlderAero) {
                // MixedRouteQuoterV1: use quoteExactInput with path-encoded bytes
                // Path format: tokenIn(20 bytes) + tickSpacing(3 bytes) + tokenOut(20 bytes)
                const ts = TICK_SPACINGS[poolKey];
                const tsHex = ethers.zeroPadValue(ethers.toBeHex(ts), 3); // 3 bytes for tickSpacing
                const fwdPath = ethers.concat([t0, tsHex, t1]);
                const revPath = ethers.concat([t1, tsHex, t0]);

                [fwdResult, revResult] = await Promise.all([
                    quoter.quoteExactInput.staticCall(fwdPath, amountInFwd, { blockTag: BLOCK_TAG }),
                    quoter.quoteExactInput.staticCall(revPath, amountInRev, { blockTag: BLOCK_TAG }),
                ]);
            } else {
                // Standard QuoterV2: quoteExactInputSingle with struct params
                let fwdParams, revParams;
                if (isAero) {
                    const ts = TICK_SPACINGS[poolKey];
                    fwdParams = { tokenIn: t0, tokenOut: t1, amountIn: amountInFwd, tickSpacing: ts, sqrtPriceLimitX96: 0n };
                    revParams = { tokenIn: t1, tokenOut: t0, amountIn: amountInRev, tickSpacing: ts, sqrtPriceLimitX96: 0n };
                } else {
                    fwdParams = { tokenIn: t0, tokenOut: t1, amountIn: amountInFwd, fee: p.feeBps, sqrtPriceLimitX96: 0n };
                    revParams = { tokenIn: t1, tokenOut: t0, amountIn: amountInRev, fee: p.feeBps, sqrtPriceLimitX96: 0n };
                }

                [fwdResult, revResult] = await Promise.all([
                    quoter.quoteExactInputSingle.staticCall(fwdParams, { blockTag: BLOCK_TAG }),
                    quoter.quoteExactInputSingle.staticCall(revParams, { blockTag: BLOCK_TAG }),
                ]);
            }

            const t0inT1 = (Number(fwdResult[0]) / (10 ** dec1)) / t0Amount;
            const t1inT0 = (Number(revResult[0]) / (10 ** dec0)) / t1Amount;

            return { t0, t1, t0inT1, t1inT0, ok: true, quoted: true };
        }
    } catch (e) {
        return { ok: false, error: e.message.slice(0, 80) };
    }
}

// extractPrice: uses the correct pre-computed direction, no more 1/price
function extractPrice(poolResult, tokenFrom, tokenTo) {
    if (!poolResult || !poolResult.ok) return null;
    const from = tokenFrom.toLowerCase(), to = tokenTo.toLowerCase();
    if (poolResult.t0 === from && poolResult.t1 === to) return poolResult.t0inT1;
    if (poolResult.t1 === from && poolResult.t0 === to) return poolResult.t1inT0;
    return null;
}

// ─── Triangle Calculation ─────────────────────────────────────────────────────
// ── FIX #2: No fee deduction — QuoterV2 prices are post-fee
// ── FIX #3: Pool selection by best execution price, not cheapest fee
//
// With QuoterV2 prices, the "best" pool per leg is simply the one that gives
// the most output. A 0.01% fee pool with thin liquidity might give WORSE
// execution than a 0.05% fee pool with deep liquidity. Let the quote decide.

function calcTriangleEdge(legDefs, poolResults) {
    // Single path: best execution price, prefer TVL > $5M for safety
    const singleLegs = [];
    let singleValid = true;
    for (const leg of legDefs) {
        let bestKey = null, bestPrice = 0;

        // First pass: only pools with TVL > $5M (safe for execution)
        for (const key of leg.pools) {
            if (!POOLS[key] || !poolResults[key]?.ok) continue;
            if (POOLS[key].tvl < 5000000) continue;
            const price = extractPrice(poolResults[key], leg.from, leg.to);
            if (!price || price <= 0) continue;
            if (price > bestPrice) { bestPrice = price; bestKey = key; }
        }
        // Fallback: any pool if no deep pool found
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

    // Calculate edge — NO fee deduction, price already includes fees
    let sAmt = INPUT_USD;
    if (singleValid) {
        for (const { price } of singleLegs) {
            sAmt = sAmt * price;  // fees already baked into QuoterV2 price
        }
    }
    const singleFeeTotal = singleLegs.reduce((s, l) => s + l.fee, 0); // nominal, for logging only
    const singleEdge = singleValid ? ((sAmt - INPUT_USD) / INPUT_USD) * 100 : null;
    const singleNet = singleValid ? sAmt - INPUT_USD : null;

    // Split path: best execution price, any TVL
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
        for (const { price } of splitLegs) {
            spAmt = spAmt * price;  // fees already baked in
        }
    }
    const splitFeeTotal = splitLegs.reduce((s, l) => s + l.fee, 0);
    const splitEdge = splitValid ? ((spAmt - INPUT_USD) / INPUT_USD) * 100 : null;
    const splitNet = splitValid ? spAmt - INPUT_USD : null;

    return {
        single: {
            edgePct: singleEdge, profitUSD: singleNet, feePct: singleFeeTotal * 100,
            pools: singleLegs.map(l => l.key),
            legs: singleLegs.map((l, i) => ({
                poolKey: l.key,
                from: legDefs[i].from,
                to: legDefs[i].to,
                price: l.price,
                fee: l.fee,
            })),
        },
        split: {
            edgePct: splitEdge, profitUSD: splitNet, feePct: splitFeeTotal * 100,
            pools: splitLegs.map(l => l.key),
            legs: splitLegs.map((l, i) => ({
                poolKey: l.key,
                from: legDefs[i].from,
                to: legDefs[i].to,
                price: l.price,
                fee: l.fee,
            })),
        },
    };
}

// ─── VIRTUAL Spread Detection ──────────────────────────────────────────────────
function calcVirtualSpread(poolResults) {
    const vPools = ['VIRTUAL_WETH_AERO', 'VIRTUAL_WETH_UNI'];
    const prices = [];
    for (const key of vPools) {
        if (!poolResults[key]?.ok) continue;
        const p = extractPrice(poolResults[key], VIRTUAL, WETH);
        if (p && p > 0) prices.push({ price: p, key });
    }
    if (prices.length < 2) return { spread: 0, min: null, max: null, count: prices.length };
    const min = Math.min(...prices.map(p => p.price));
    const max = Math.max(...prices.map(p => p.price));
    return { spread: ((max - min) / min) * 100, min, max, count: prices.length };
}

// ─── Slippage helper ──────────────────────────────────────────────────────────
function withSlippage(expectedAmt) {
    return BigInt(Math.floor(Number(expectedAmt) * (1 - SLIPPAGE)));
}

// ─── Dynamic Leg Builder ─────────────────────────────────────────────────────
// leg.price = human-readable "per unit" execution price (post-fee)
// currentAmount = raw token amount (with decimals, e.g. 5000e6 for USDC)
//
// Contract v2.1 uses actual pool fee from Leg.fee for vAMM pools,
// so no correction factor is needed — signal and execution use the same fee.

function buildDynamicLegs(signalLegs, poolResults, flashLoan) {
    const contractLegs = [];
    let currentAmount = flashLoan;

    let i = 0;
    while (i < signalLegs.length) {
        const leg = signalLegs[i];

        // Look ahead for parallel split legs (same from + to)
        let splitCount = 1;
        while (i + splitCount < signalLegs.length &&
            signalLegs[i + splitCount].from === leg.from &&
            signalLegs[i + splitCount].to === leg.to) {
            splitCount++;
        }

        if (splitCount === 1) {
            // Sequential leg
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
            i++;
        } else {
            // Split legs — divide by TVL weight
            const splitPools = signalLegs.slice(i, i + splitCount);
            const totalTvl = splitPools.reduce((s, l) => s + POOLS[l.poolKey].tvl, 0);
            let remaining = currentAmount;
            let totalOut = 0n;

            for (let j = 0; j < splitPools.length; j++) {
                const sl = splitPools[j];
                const pool = POOLS[sl.poolKey];
                const decIn = DECIMALS[sl.from] || 18;
                const decOut = DECIMALS[sl.to] || 18;
                const isLast = j === splitPools.length - 1;
                const amt = isLast ? remaining : BigInt(Math.floor(Number(currentAmount) * pool.tvl / totalTvl));
                remaining -= amt;

                const expectedOut = BigInt(Math.floor(
                    Number(amt) * sl.price * (10 ** decOut) / (10 ** decIn)
                ));
                totalOut += expectedOut;

                contractLegs.push({
                    pool: pool.address,
                    tokenIn: sl.from,
                    tokenOut: sl.to,
                    fee: pool.feeBps,
                    poolType: pool.poolType,
                    minAmountOut: withSlippage(expectedOut),
                    useBalance: false,
                    splitAmount: amt,
                });
            }
            currentAmount = totalOut;
            i += splitCount;
        }
    }

    // Fix useBalance for legs following a split group
    for (let j = 1; j < contractLegs.length; j++) {
        const prev = contractLegs[j - 1];
        const curr = contractLegs[j];
        if (prev.splitAmount > 0n && curr.tokenIn === prev.tokenOut && curr.splitAmount === 0n) {
            let hasSplit = false;
            for (let k = 0; k < j; k++) {
                if (contractLegs[k].splitAmount > 0n && contractLegs[k].tokenOut === curr.tokenIn) {
                    hasSplit = true; break;
                }
            }
            if (hasSplit) curr.useBalance = true;
        }
    }

    const totalUsdcBack = currentAmount;

    // DEBUG: log built legs with readable info
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

// Helper: token address → symbol for logging
function tokenSymbol(addr) {
    const a = addr.toLowerCase();
    if (a === USDC) return 'USDC';
    if (a === WETH) return 'WETH';
    if (a === cbBTC) return 'cbBTC';
    if (a === VIRTUAL) return 'VIRTUAL';
    if (a === AERO) return 'AERO';
    if (a === msUSD) return 'msUSD';
    if (a === msETH) return 'msETH';
    return addr.slice(0, 8);
}

// ─── Execution ─────────────────────────────────────────────────────────────────
let lastExecutedBlock = 0;

// ─── Dynamic Size Quoting ────────────────────────────────────────────────────
// Quotes a single pool leg at a specific raw token input amount.
// Returns raw output amount (BigInt) or null on failure.
async function quoteLegAtSize(poolKey, tokenIn, tokenOut, amountInRaw) {
    const p = POOLS[poolKey];
    const tokens = TOKEN_CACHE[poolKey];
    if (!p || !tokens) return null;
    const t0 = tokens.t0, t1 = tokens.t1;
    const dec0 = DECIMALS[t0] || 18, dec1 = DECIMALS[t1] || 18;

    try {
        if (p.type === 'vAMM') {
            const c = new ethers.Contract(p.address, VAMM_ABI, provider);
            const res = await c.getReserves({ blockTag: BLOCK_TAG });
            const from = tokenIn.toLowerCase(), to = tokenOut.toLowerCase();
            const zeroForOne = from === t0;
            const r0 = Number(res[0]), r1 = Number(res[1]);
            const reserveIn = zeroForOne ? r0 : r1;
            const reserveOut = zeroForOne ? r1 : r0;
            const amtIn = Number(amountInRaw);
            const feeMultiplier = 1 - p.fee;
            const amtInWithFee = amtIn * feeMultiplier;
            const amtOut = (amtInWithFee * reserveOut) / (reserveIn + amtInWithFee);
            return BigInt(Math.floor(amtOut));
        } else {
            // clAMM: use QuoterV2
            const isAero = p.type === 'clAMM6';
            const quoterAddr = isAero ? POOL_QUOTER[poolKey]
                : p.poolType === 1 ? PANCAKE_QUOTER_V2
                    : UNISWAP_QUOTER_V2;
            if (!quoterAddr) return null;
            const isOlderAero = quoterAddr === AERO_QUOTER_OLDER;
            const quoterAbi = isOlderAero ? AERO_MIXED_QUOTER_ABI
                : isAero ? AERO_QUOTER_V2_ABI
                    : QUOTER_V2_ABI;
            if (!quoterCache[quoterAddr]) {
                quoterCache[quoterAddr] = new ethers.Contract(quoterAddr, quoterAbi, provider);
            }
            const quoter = quoterCache[quoterAddr];

            if (isOlderAero) {
                const ts = TICK_SPACINGS[poolKey];
                const tsHex = ethers.zeroPadValue(ethers.toBeHex(ts), 3);
                const path = ethers.concat([tokenIn, tsHex, tokenOut]);
                const result = await quoter.quoteExactInput.staticCall(path, amountInRaw, { blockTag: BLOCK_TAG });
                return BigInt(result[0]);
            } else if (isAero) {
                const ts = TICK_SPACINGS[poolKey];
                const result = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn, tokenOut, amountIn: amountInRaw, tickSpacing: ts, sqrtPriceLimitX96: 0n,
                }, { blockTag: BLOCK_TAG });
                return BigInt(result[0]);
            } else {
                const result = await quoter.quoteExactInputSingle.staticCall({
                    tokenIn, tokenOut, amountIn: amountInRaw, fee: p.feeBps, sqrtPriceLimitX96: 0n,
                }, { blockTag: BLOCK_TAG });
                return BigInt(result[0]);
            }
        }
    } catch { return null; }
}

// Quotes an entire path sequentially at a given USD size.
// Returns { size, loanAmount, finalAmount, profitUSD, legs } or null.
async function quotePathAtSize(signalLegs, sizeUSD) {
    const loanAmount = BigInt(sizeUSD) * 1_000_000n; // USDC 6 decimals
    let currentAmount = loanAmount;
    const quotedLegs = [];

    for (const leg of signalLegs) {
        const output = await quoteLegAtSize(leg.poolKey, leg.from, leg.to, currentAmount);
        if (!output || output <= 0n) return null;
        quotedLegs.push({
            ...leg,
            amountIn: currentAmount,
            amountOut: output,
        });
        currentAmount = output;
    }

    const profitUSD = (Number(currentAmount) - Number(loanAmount)) / 1e6;

    return {
        size: sizeUSD,
        loanAmount,
        finalAmount: currentAmount,
        profitUSD,
        legs: quotedLegs,
    };
}

// Quotes all candidate sizes in parallel, returns the best one.
async function findOptimalSize(signalLegs) {
    const results = await Promise.all(
        DYNAMIC_SIZES.map(size => quotePathAtSize(signalLegs, size))
    );

    // Filter successful quotes, pick highest dollar profit
    const valid = results.filter(r => r !== null);
    if (valid.length === 0) return null;

    // Log all sizes for visibility
    console.log(`  [SIZING] Quoting ${DYNAMIC_SIZES.length} sizes:`);
    for (const r of valid) {
        const marker = r.profitUSD > 0 ? '🟢' : '🔴';
        console.log(`    ${marker} $${r.size.toLocaleString()}: profit=$${r.profitUSD.toFixed(2)} (${((Number(r.finalAmount) - Number(r.loanAmount)) / Number(r.loanAmount) * 100).toFixed(4)}%)`);
    }

    // Pick the size with highest dollar profit (only if above execution threshold)
    const profitable = valid.filter(r => r.profitUSD >= MIN_EXECUTE_USD);
    if (profitable.length === 0) {
        // Still return the least-bad for signal logging, but don't execute
        valid.sort((a, b) => b.profitUSD - a.profitUSD);
        return { ...valid[0], shouldExecute: false };
    }

    profitable.sort((a, b) => b.profitUSD - a.profitUSD);
    const best = profitable[0];
    console.log(`    ⭐ OPTIMAL: $${best.size.toLocaleString()} → $${best.profitUSD.toFixed(2)} profit`);
    return { ...best, shouldExecute: true };
}

async function executeArb(triangleName, directionName, signalLegs, poolResults, isEventMode) {
    if (!wallet || !CONTRACT_ADDR) return null;

    const currentBlock = await provider.getBlockNumber();
    if (currentBlock - lastExecutedBlock < EXEC_COOLDOWN) {
        console.log(`  Cooldown: ${EXEC_COOLDOWN - (currentBlock - lastExecutedBlock)} blocks remaining`);
        return null;
    }

    // ── Dynamic sizing: re-quote path at multiple sizes, pick optimal ──
    const optimal = await findOptimalSize(signalLegs);
    if (!optimal) {
        console.log(`  Dynamic sizing failed — no valid quotes`);
        return null;
    }

    if (!optimal.shouldExecute) {
        console.log(`  Best size $${optimal.size.toLocaleString()}: $${optimal.profitUSD.toFixed(2)} — not profitable at any size, skipping execution`);
        return null;
    }

    // Build execution legs at the optimal size
    const trade = buildDynamicLegs(signalLegs, poolResults, optimal.loanAmount);

    if (!trade || !trade.legs.length) {
        console.log(`  Dynamic builder failed for: ${triangleName} / ${directionName}`);
        return null;
    }

    console.log(`  Leg builder estimate: $${trade.expectedProfit.toFixed(2)} at $${optimal.size.toLocaleString()}`);

    let txHash = null;
    try {
        const contract = new ethers.Contract(CONTRACT_ADDR, PREDATOR_ABI, wallet);
        if (await contract.paused({ blockTag: BLOCK_TAG })) { console.log('  Contract paused'); return null; }

        const feeData = await provider.getFeeData();
        const tipGwei = isEventMode ? GAS_TIP_EVENT : GAS_TIP_NORMAL;
        const priorityFee = ethers.parseUnits(tipGwei, 'gwei');
        const maxFee = feeData.maxFeePerGas > priorityFee ? feeData.maxFeePerGas : priorityFee;

        console.log(`\n  🚀 EXECUTING: ${directionName} [Flashblocks | $${optimal.size.toLocaleString()}]`);
        console.log(`     Loan: $${Number(trade.loanAmount) / 1e6} | Legs: ${trade.legs.length} | Est: $${optimal.profitUSD.toFixed(2)}`);

        const tx = await contract.trigger(
            trade.loanAmount,
            trade.legs,
            trade.minFinalReturn,
            { maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee, gasLimit: GAS_LIMIT }
        );
        txHash = tx.hash;

        console.log(`     TX: ${txHash}`);
        lastExecutedBlock = currentBlock;

        const receipt = await tx.wait(0); // Flashblocks: preconfirmation in ~200ms
        if (receipt && receipt.status === 1) {
            console.log(`     ✅ CONFIRMED block ${receipt.blockNumber} | gas: ${receipt.gasUsed}`);
            return { success: true, hash: txHash, block: receipt.blockNumber };
        } else {
            console.log(`     ❌ REVERTED${receipt ? ' block ' + receipt.blockNumber : ' (preconf null)'}`);
            return { success: false, hash: txHash };
        }
    } catch (err) {
        console.error(`     ❌ ${err.message.slice(0, 120)}`);
        return { success: false, error: err.message, hash: txHash || err.receipt?.hash || null };
    }
}

// ─── CSV Logging ───────────────────────────────────────────────────────────────
const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = `predator_v32_${SESSION_START}.csv`;

const CSV_HEADER = [
    'timestamp', 'block', 'triangle', 'direction',
    'single_gross_pct', 'single_fee_pct', 'single_net_pct', 'single_profit_usd',
    'split_gross_pct', 'split_fee_pct', 'split_net_pct', 'split_profit_usd',
    'virtual_spread_pct', 'executed',
    'weth_usd', 'cbbtc_usd', 'aero_usd',
].join(',') + '\n';

function initCSV() {
    fs.writeFileSync(LOG_FILE, CSV_HEADER);
    console.log(`Logging to: ${LOG_FILE}`);
}

function logToCSV(block, tri, dir, singleR, splitR, vSpread, spotPrices, executed = false) {
    // edgePct IS the true net (fees included in QuoterV2 price)
    // feePct is nominal pool fees — logged for info, NOT subtracted from edge
    // gross = edge + nominal fee (approximate, for comparison with old logs)
    const sg = (singleR.edgePct || 0) + (singleR.feePct || 0);
    const spg = (splitR.edgePct || 0) + (splitR.feePct || 0);
    const row = [
        new Date().toISOString(), block, tri, dir,
        sg.toFixed(4), (singleR.feePct || 0).toFixed(4), (singleR.edgePct || 0).toFixed(4), (singleR.profitUSD || 0).toFixed(2),
        spg.toFixed(4), (splitR.feePct || 0).toFixed(4), (splitR.edgePct || 0).toFixed(4), (splitR.profitUSD || 0).toFixed(2),
        vSpread.toFixed(4), executed ? '1' : '0',
        spotPrices.weth.toFixed(2), spotPrices.cbbtc.toFixed(0), spotPrices.aero.toFixed(4),
    ].join(',') + '\n';
    fs.appendFileSync(LOG_FILE, row);
}

// ─── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' });
    return new Promise((resolve) => {
        const req = https.request(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            resolve
        );
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// ─── Main Scan ─────────────────────────────────────────────────────────────────
let lastBlock = 0;

async function scan() {
    const block = await provider.getBlockNumber();
    if (block <= lastBlock) return;
    lastBlock = block;
    const t0 = Date.now();

    const poolKeys = Object.keys(POOLS);
    const poolResultsArr = await Promise.all(poolKeys.map(k => readPoolPrice(k)));
    const poolResults = Object.fromEntries(poolKeys.map((k, i) => [k, poolResultsArr[i]]));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    const wethPrice = extractPrice(poolResults['WETH_USDC_UNI_BIG'], WETH, USDC) || 0;
    const cbbtcPrice = extractPrice(poolResults['cbBTC_USDC_AERO'], cbBTC, USDC) || 0;
    const _aeroRaw = extractPrice(poolResults['AERO_USDC_AERO'], AERO, USDC);
    const aeroPrice = _aeroRaw && _aeroRaw > 0 ? _aeroRaw : 0;
    const spotPrices = { weth: wethPrice, cbbtc: cbbtcPrice, aero: aeroPrice };
    const vSpread = calcVirtualSpread(poolResults);
    const isEventMode = vSpread.spread > 2.5; // 1% fee per vAMM leg = need 2%+ spread to profit

    // Count how many pools returned valid quotes
    const okCount = poolResultsArr.filter(r => r.ok).length;
    const quotedCount = poolResultsArr.filter(r => r.quoted).length;

    console.log(`\n[${now}] Block ${block} | ${elapsed}s | ${okCount}/${poolKeys.length} pools (${quotedCount} quoted)`);
    console.log(`  Prices: WETH $${wethPrice.toFixed(0)} | cbBTC $${cbbtcPrice.toFixed(0)} | AERO $${aeroPrice.toFixed(3)}`);
    if (vSpread.spread > 0.5) {
        console.log(`  🔵 VIRTUAL spread: ${vSpread.spread.toFixed(3)}% across ${vSpread.count} pools${isEventMode ? ' 🔥 EVENT MODE' : ''}`);
    }

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

            // Determine best path: single or split
            const bestIsSplit = spProfit > sProfit && spProfit > 0;
            const bestProfit = bestIsSplit ? spProfit : sProfit;
            const bestNet = bestIsSplit ? spNet : sNet;
            const bestLabel = bestIsSplit ? 'SPLIT' : 'SINGLE';

            const icon = bestNet > 0 ? '🟢' : '🔴';
            console.log(`  ${icon} ${dir.name}`);
            console.log(`     Single: net=${sNet.toFixed(3)}%  $${sProfit.toFixed(2)}  [fee=${single.feePct.toFixed(3)}% nominal]`);
            if (single.pools) console.log(`     Pools:  ${single.pools.map(k => POOLS[k]?.label || k).join(' > ')}`);
            console.log(`     Split:  net=${spNet.toFixed(3)}%  $${spProfit.toFixed(2)}`);
            if (split.pools && spNet > 0) console.log(`     SPools: ${split.pools.map(k => POOLS[k]?.label || k).join(' > ')}`);

            // Log every block for data collection — see how close spreads get
            logToCSV(block, tri.name, dir.name, single, split, vSpread.spread, spotPrices);

            // Alert on whichever path is profitable — single OR split
            if (bestProfit > MIN_PROFIT_USD && bestNet > 0) {
                hasAlert = true;
                alerts.push({
                    triangle: tri.name,
                    name: dir.name,
                    sNet: bestNet,
                    spNet,
                    profit: bestProfit,
                    signalLegs: bestIsSplit ? split.legs : single.legs,
                    pathType: bestLabel,
                });
            }
        }
    }

    if (!hasAlert) console.log(`  ⏳ No profitable opportunities this block`);

    // Sort by profit descending — execute best opportunity first
    alerts.sort((a, b) => b.profit - a.profit);

    for (const a of alerts) {
        await sendTelegram([
            `*PREDATOR v3.2 — ${a.pathType} SIGNAL*`,
            ``,
            `Path: \`${a.name}\``,
            `Edge: \`+${a.sNet.toFixed(3)}%\` ($${a.profit.toFixed(2)} at $${INPUT_USD / 1000}k)`,
            `Type: ${a.pathType}`,
            `Block: ${block} | VIRTUAL: ${vSpread.spread.toFixed(3)}%`,
            `WETH $${wethPrice.toFixed(0)} | cbBTC $${cbbtcPrice.toFixed(0)} | AERO $${aeroPrice.toFixed(3)}`,
            `Mode: ${wallet ? 'LIVE' : 'DRY-RUN'} | QuoterV2`,
        ].join('\n'));

        if (wallet) {
            const result = await executeArb(a.triangle, a.name, a.signalLegs, poolResults, isEventMode);
            if (result?.success) {
                logToCSV(block, a.triangle, a.name, {}, {}, vSpread.spread, spotPrices, true);
                await sendTelegram([
                    `*✅ TRADE EXECUTED*`,
                    `Hash: \`${result.hash}\``,
                    `https://basescan.org/tx/${result.hash}`,
                    `Block: ${result.block} | Path: ${a.name}`,
                ].join('\n'));
            } else if (result && !result.success) {
                const failLines = [`*❌ TRADE FAILED*`];
                if (result.hash) {
                    failLines.push(`Hash: \`${result.hash}\``);
                    failLines.push(`https://basescan.org/tx/${result.hash}`);
                }
                failLines.push(`Path: ${a.name}`);
                failLines.push(`${result.error?.slice(0, 100) || 'reverted'}`);
                await sendTelegram(failLines.join('\n'));
            }
        }
    }

    if (vSpread.spread > 2.5 && !hasAlert) {
        await sendTelegram([
            `*VIRTUAL SPREAD ALERT*`,
            `Spread: \`${vSpread.spread.toFixed(3)}%\` across ${vSpread.count} pools`,
            `Block: ${block}`,
        ].join('\n'));
    }
}

// ─── Startup ───────────────────────────────────────────────────────────────────
(async () => {
    const mode = (PRIVATE_KEY && CONTRACT_ADDR) ? 'EXECUTION' : 'DRY-RUN';
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log(`║  PREDATOR LISTENER v3.2  [${mode}]                      ║`);
    console.log('║  Flashblocks + QuoterV2 — 200ms state, no phantoms       ║');
    console.log('║  cbBTC + WETH-2leg — verified pools                      ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Pool universe:  ${Object.keys(POOLS).length} pools | WETH/USDC $124M depth`);
    console.log(`  Triangles:      cbBTC ($5k) | WETH-2leg ($5k)`);
    console.log(`  Quoting:        QuoterV2 @ pending blockTag (Flashblocks 200ms state)`);
    console.log(`  Scan interval:  ${SCAN_INTERVAL}ms`);
    console.log(`  Min profit:     $${MIN_PROFIT_USD} (diagnostic mode)`);
    console.log('');

    await initProvider();
    await initPoolCache();
    initCSV();

    const startBlock = await provider.getBlockNumber();

    await sendTelegram([
        `*Predator v3.2 LIVE — ${mode} ⚡ FLASHBLOCKS*`,
        `QuoterV2 @ pending blockTag (200ms state)`,
        `cbBTC ($5k) | WETH-2leg ($5k)`,
        `Scan: ${SCAN_INTERVAL}ms`,
        `Min profit: $${MIN_PROFIT_USD}`,
        `Block: ${startBlock}`,
        `${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
    ].join('\n'));

    console.log(`Scanning every ${SCAN_INTERVAL}ms...\n`);

    while (true) {
        try { await scan(); } catch (err) { console.error(`Scan error: ${err.message}`); }
        await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
})();