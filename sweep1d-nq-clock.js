/**
 * SWEEP 1D - NQ-CLOCK LATCH + SUSTAINED SMOKE
 *
 * Changes from 1c:
 *  1. Latch window counts TRADEABLE hours only: weekend (Fri 21:00 UTC ->
 *     Sun 22:00 UTC) is skipped when measuring "within H hours". The crowd
 *     loaded Friday night is still "recent" on Monday morning.
 *  2. Smoke measured on 3-HOUR same-side liq sums (sustained burn, not blips),
 *     ranked vs trailing 7d of 3h sums, bar raised: P80 / P90.
 *  3. Sign guard + slope checks retained from 1c.
 *
 * Auditions: mem {92,95} x latchH {24,36} tradeable-hours x smoke {80,90} = 8 variants.
 * Output: sweep1d_results.txt
 */
const fs = require('fs');
const PCT = 95, LOOKBACK_D = 14, STEP_MS = 5*60*1000;
const LATCH_MEM = [92, 95];
const LATCH_HOURS = [24, 36];
const SMOKE_PCTS = [80, 90];
const GRADED = { '2026-07-13':'SHORT','2026-07-14':'LONG','2026-07-15':'NONE','2026-07-16':'SHORT','2026-07-17':'SHORT' };

function loadFunding() {
  const pts = new Map();
  const load = (f, tn, fn, mc) => {
    if (!fs.existsSync(f)) return;
    const lines = fs.readFileSync(f,'utf8').split('\n');
    const h = lines[0].split(','); const ti=h.indexOf(tn), fi=h.indexOf(fn);
    for (let i=1;i<lines.length;i++){ const c=lines[i].split(','); if(c.length<mc) continue;
      const ms=Date.parse(c[ti]), fr=parseFloat(c[fi]);
      if(isFinite(ms)&&isFinite(fr)) pts.set(ms-ms%60000, fr); }
  };
  load('eth_pillars_v2_2026-06.csv','timestamp','funding_rate',6);
  load('eth_pillars_v3_2026-06.csv','timestamp','funding_close',9);
  load('eth_pillars_v3_2026-07.csv','timestamp','funding_close',9);
  return [...pts.entries()].sort((a,b)=>a[0]-b[0]);
}
function loadLiqs() {
  const longM=new Map(), shortM=new Map();
  for (const f of ['eth_liquidations_v2_2026-06.csv','eth_liquidations_v2_2026-07.csv']) {
    if (!fs.existsSync(f)) continue;
    const lines=fs.readFileSync(f,'utf8').split('\n');
    const h=lines[0].split(','); const ti=h.indexOf('log_time'), ui=h.indexOf('usd_value'), si=h.indexOf('side');
    for (let i=1;i<lines.length;i++){ const c=lines[i].split(','); if(c.length<7) continue;
      const ms=Date.parse(c[ti]); const usd=parseFloat(c[ui]); const side=parseInt(c[si]);
      if(!isFinite(ms)||!isFinite(usd)) continue;
      const k=ms-ms%60000;
      if(side===1) longM.set(k,(longM.get(k)||0)+usd);
      else if(side===2) shortM.set(k,(shortM.get(k)||0)+usd); }
  }
  return {longM, shortM};
}
function qldDay(ms){ return new Date(ms+36e6).toISOString().slice(0,10); }
function isWeekend(ms){
  // NQ dark: Fri 21:00 UTC -> Sun 22:00 UTC
  const d = new Date(ms); const dow = d.getUTCDay(); const h = d.getUTCHours();
  if (dow === 6) return true;                       // Saturday
  if (dow === 5 && h >= 21) return true;            // Fri after 21:00
  if (dow === 0 && h < 22) return true;             // Sun before 22:00
  return false;
}

(function main(){
  const series = loadFunding();
  const {longM, shortM} = loadLiqs();
  const msArr = series.map(p=>p[0]), frArr = series.map(p=>p[1]);
  const ms0 = msArr[0], win = LOOKBACK_D*864e5;
  const frAt = new Map(series);

  function liqSum(map,t,mins){ let s=0; for(let m=t-(mins-1)*60000;m<=t;m+=60000) s+=map.get(m)||0; return s; }
  function smokeRank3h(map,t){ const cur=liqSum(map,t,180); let below=0,n=0;
    for(let m=t-7*864e5;m<t;m+=60*60000){ if(liqSum(map,m,180)<cur) below++; n++; } return n?below/n:0; }
  function frAgo(t,hrs){ for(let m=t-hrs*3600e3; m<=t-hrs*3600e3+10*60000; m+=60000){ if(frAt.has(m)) return frAt.get(m); } return null; }

  const grid=[]; let wStart=0;
  for(let i=0;i<msArr.length;i++){
    const t=msArr[i];
    if(t-ms0<win) continue; if(t%STEP_MS!==0) continue;
    while(msArr[wStart]<t-win) wStart++;
    const n=i-wStart; if(n<500) continue;
    let below=0; const cur=frArr[i];
    for(let j=wStart;j<i;j++) if(frArr[j]<cur) below++;
    grid.push({t, fr:cur, rank:below/n});
  }
  console.log('grid: '+grid.length+' steps');

  const out=[];
  out.push('SWEEP 1D - NQ-CLOCK LATCH + 3H SMOKE  (base P'+PCT+'/'+LOOKBACK_D+'d)  '+new Date().toISOString());
  out.push('');

  for(const LP of LATCH_MEM) for(const H of LATCH_HOURS) for(const SP of SMOKE_PCTS){
    const armedDays=new Map();
    for(let g=0; g<grid.length; g++){
      const {t, fr, rank}=grid[g];
      if(!qldDay(t).startsWith('2026-07')) continue;
      let state='NONE';
      if(rank>=PCT/100 && fr>0) state='SHORT';
      else if(rank<=1-PCT/100 && fr<0) state='LONG';
      else {
        // NQ-clock latch: walk back, budget H tradeable hours (skip weekend spans)
        let sawHi=false, sawLo=false, hiFr=0, loFr=0;
        let budget = H*3600e3;
        for(let k=g-1; k>=0 && budget>0; k--){
          const dt = grid[k+1].t - grid[k].t;
          if(!isWeekend(grid[k].t)) budget -= dt;
          if(grid[k].rank>=LP/100 && grid[k].fr>0){ sawHi=true; hiFr=Math.max(hiFr,grid[k].fr); }
          if(grid[k].rank<=1-LP/100 && grid[k].fr<0){ sawLo=true; loFr=Math.min(loFr,grid[k].fr); }
        }
        const fr2h = frAgo(t,2);
        const falling = fr2h!==null && fr < fr2h;
        const rising  = fr2h!==null && fr > fr2h;
        if(sawHi && fr>0 && fr<hiFr && falling && smokeRank3h(longM,t)>=SP/100) state='SHORT';
        else if(sawLo && fr<0 && fr>loFr && rising && smokeRank3h(shortM,t)>=SP/100) state='LONG';
      }
      if(state!=='NONE'){
        const d=qldDay(t);
        if(!armedDays.has(d)) armedDays.set(d,{S:0,L:0});
        armedDays.get(d)[state==='SHORT'?'S':'L']+=5;
      }
    }
    out.push('=== mem P'+LP+' / latch '+H+'h(NQ-clock) / smoke3h P'+SP+' ===');
    let passes=0;
    for(const [day,want] of Object.entries(GRADED)){
      const a=armedDays.get(day)||{S:0,L:0};
      const got = a.S>=60&&a.S>a.L?'SHORT':a.L>=60&&a.L>a.S?'LONG':'NONE';
      const ok = got===want; if(ok) passes++;
      out.push('  '+day+' want:'+want+' got:'+got+' (S:'+a.S+'m L:'+a.L+'m) '+(ok?'PASS':'FAIL'));
    }
    out.push('  SCORE '+passes+'/5');
    const jul=[...armedDays.entries()].filter(([d,v])=>v.S>=60||v.L>=60).map(([d,v])=>d.slice(8)+(v.S>v.L?'S':'L'));
    out.push('  July armed days: '+jul.join(' '));
    out.push('');
  }
  fs.writeFileSync('sweep1d_results.txt', out.join('\n')+'\n');
  console.log('wrote sweep1d_results.txt');
})();
