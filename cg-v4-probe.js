const https = require('https');
const KEY = process.env.COINGLASS_API_KEY || '';
if (!KEY) { console.error('No COINGLASS_API_KEY in env.'); process.exit(1); }
const BASE = 'open-api-v4.coinglass.com';
const PATH = '/api/spot/aggregated-cvd/history?exchange_list=Binance&symbol=ETH&interval=1h&limit=1&unit=usd';
function probe(headerName) {
  return new Promise((resolve) => {
    const opts = { hostname: BASE, path: PATH, method: 'GET',
      headers: { [headerName]: KEY, accept: 'application/json' } };
    const req = https.request(opts, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ headerName, status: res.statusCode, body: b.slice(0, 400) }));
    });
    req.on('error', e => resolve({ headerName, status: 'ERR', body: e.message }));
    req.end();
  });
}
(async () => {
  for (const h of ['CG-API-KEY', 'coinglassSecret']) {
    const r = await probe(h);
    console.log(`\n--- header: ${h} ---`);
    console.log(`HTTP ${r.status}`);
    console.log(r.body);
  }
})();
