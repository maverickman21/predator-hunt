const fs = require('fs');
const https = require('https');
const KEY = process.env.COINGLASS_API_KEY || '';
if (!KEY) { console.error('No COINGLASS_API_KEY. Run: export $(grep -v "^#" .env | xargs)'); process.exit(1); }
const BASE = 'open-api-v4.coinglass.com';

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: BASE, path, method: 'GET',
      headers: { 'CG-API-KEY': KEY, accept: 'application/json' } };
    const req = https.request(opts, (res) => {
      let b=''; res.on('data',c=>b+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){reject(new Error(b.slice(0,300)));} });
    });
    req.on('error', reject); req.end();
  });
}
function rowsToCsv(rows){
  if(!rows||!rows.length) return '';
  const cols=Object.keys(rows[0]);
  return cols.join(',')+'\n'+rows.map(r=>cols.map(c=>r[c]??'').join(',')).join('\n')+'\n';
}
(async()=>{
  // Option max-pain is dated daily; pull ETH on Deribit. No time params per docs - it returns the series.
  for (const sym of ['ETH','BTC']) {
    try {
      const j = await get(`/api/option/max-pain?symbol=${sym}&exchange=Deribit`);
      if(String(j.code)!=='0'){ console.error(`[${sym}] code=${j.code} msg=${j.msg}`); continue; }
      const rows = Array.isArray(j.data)?j.data:(j.data&&j.data.list)?j.data.list:null;
      if(!rows){ fs.writeFileSync(`${sym}_maxpain.raw.json`,JSON.stringify(j,null,2)); console.log(`[${sym}] unknown shape -> raw.json`); continue; }
      fs.writeFileSync(`${sym.toLowerCase()}_option_maxpain.csv`, rowsToCsv(rows));
      console.log(`[${sym}] wrote ${rows.length} rows -> ${sym.toLowerCase()}_option_maxpain.csv`);
    } catch(e){ console.error(`[${sym}] ERROR: ${e.message}`); }
  }
  console.log('[DONE]');
})();
