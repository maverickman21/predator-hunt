const fs = require('fs');
const https = require('https');
const KEY = process.env.COINGLASS_API_KEY || '';
if (!KEY) { console.error('No COINGLASS_API_KEY in env. Run: export $(grep -v "^#" .env | xargs)'); process.exit(1); }
const BASE = 'open-api-v4.coinglass.com';
const START = Date.parse('2026-04-11T00:00:00Z');
const END   = Date.parse('2026-06-12T00:00:00Z');
const INTERVAL = '1h';

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: BASE, path, method: 'GET',
      headers: { 'CG-API-KEY': KEY, accept: 'application/json' } };
    const req = https.request(opts, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e){ reject(new Error(b.slice(0,300))); } });
    });
    req.on('error', reject); req.end();
  });
}
function rowsToCsv(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => r[c] ?? '').join(',')).join('\n') + '\n';
}
async function pull(name, path) {
  try {
    const j = await get(path);
    if (String(j.code) !== '0') { console.error(`[${name}] code=${j.code} msg=${j.msg}`); return; }
    const rows = Array.isArray(j.data) ? j.data : (j.data && j.data.list) ? j.data.list : null;
    if (!rows) { fs.writeFileSync(`${name}.raw.json`, JSON.stringify(j,null,2)); console.log(`[${name}] unknown shape -> ${name}.raw.json`); return; }
    fs.writeFileSync(`${name}.csv`, rowsToCsv(rows));
    console.log(`[${name}] wrote ${rows.length} rows -> ${name}.csv`);
  } catch(e) { console.error(`[${name}] ERROR: ${e.message}`); }
}
(async () => {
  const w = `&start_time=${START}&end_time=${END}&interval=${INTERVAL}&limit=4500`;
  await pull('eth_cvd_agg',     `/api/spot/aggregated-cvd/history?exchange_list=Binance,OKX,Bybit&symbol=ETH&unit=usd${w}`);
  await pull('eth_cvd_binance', `/api/spot/cvd/history?exchange=Binance&symbol=ETHUSDT&unit=usd${w}`);
  await pull('eth_optfut_oi',   `/api/index/option-vs-futures-oi-ratio?symbol=ETH${w}`);
  await pull('btc_optfut_oi',   `/api/index/option-vs-futures-oi-ratio?symbol=BTC${w}`);
  console.log('\n[DONE]');
})();
