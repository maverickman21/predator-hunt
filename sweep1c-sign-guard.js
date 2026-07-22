/**
 * SWEEP 1C - SIGN GUARD + SOFTER LATCH MEMORY + SLOPE CHECK
 *
 * Fixes from 1b diagnosis:
 *  1. SIGN GUARD: SHORT arm requires funding > 0; LONG arm requires funding < 0.
 *     (rank = extremity, sign = who is crowded. Tank law, finally enforced.)
 *  2. Latch memory threshold softer than instant-arm: visit >= LP within H hours
 *     (LP auditioned 88/90/92) vs instant arm at 95.
 *  3. Latch requires FALLING funding: fr now < fr 2h ago (blocks Wed-evening refill).
 *
 * Auditions: LP {88,90,92} x H {24,36,48}h x smoke {60,70} = 18 variants.
 * Output: sweep1c_results.txt
 */
const fs = require('fs');
const PCT = 95, LOOKBACK_D = 14, STEP_MS = 5*60*1000;
const LATCH_MEM = [88, 90, 92];
const LATCH_HOURS = [24, 36, 48];
const SMOKE_PCTS = [60, 70];
const GRADED = { '2026-07-13':'SHORT','2026-07-14':'LONG','2026-07-15':'NONE','2026-07-16':'SHORT','2026-07-17':'SHORT' };

function loadFunding() {
  const pts = new Map();
  const load = (f, ti_name, fi_name, minCols) => {
    if (!fs.existsSync(f)) return;
    const lines = fs.readFileSync(f,'utf8').split('\n');
    const hdr = lines[0].split(','); const ti = hdr.indexOf(ti_name), fi = hdr.indexOf(fi_name);
    for (let i=1;i<lines.length;i++){ const c=lines[i].split(','); if(c.length<minCols) continue;
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
    const hdr=lines[0].split(','); const ti=hdr.indexOf('log_time'), ui=hdr.indexOf('usd_value'), si=hdr.indexOf('side');
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

(function main(){
  const series = loadFunding();
  const {longM, shortM} = loadLiqs();
  const msArr = series.map(p=>p[0]), frArr = series.map(p=>p[1]);
  const ms0 = msArr[0], win = LOOKBACK_D*864e5;
  const frAt = new Map(series);   // minute -> funding for slope lookup

  function liqSum60(map,t){ let s=0; for(let m=t-59*60000;m<=t;m+=60000) s+=map.get(m)||0; return s; }
  function smokeRank(map,t){ const cur=liqSum60(map,t); let below=0,n=0;
    for(let m=t-7*864e5;m<t;m+=30*60000){ if(liqSum60(map,m)<cur) below++; n++; } return n?below/n:0; }
  function frAgo(t, hrs){ for(let m=t-hrs*3600e3; m<=t-hrs*3600e3+10*60000; m+=60000){ if(frAt.has(m)) return frAt.get(m); } return null; }

  // base grid with ranks
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
  out.push('SWEEP 1C - SIGN GUARD + LATCH  (base P'+PCT+'/'+LOOKBACK_D+'d)  '+new Date().toISOString());
  out.push('');

  for(const LP of LATCH_MEM) for(const H of LATCH_HOURS) for(const SP of SMOKE_PCTS){
    const armedDays=new Map(); const latchWin=H*3600e3;
    for(let g=0; g<grid.length; g++){
      const {t, fr, rank}=grid[g];
      if(!qldDay(t).startsWith('2026-07')) continue;
      let state='NONE';
      // instant arms WITH SIGN GUARD
      if(rank>=PCT/100 && fr>0) state='SHORT';
      else if(rank<=1-PCT/100 && fr<0) state='LONG';
      else {
        // latch: visited soft tail within H, falling, sign-consistent, smoke
        let sawHi=false, sawLo=false, hiFr=0, loFr=0;
        for(let k=g-1; k>=0 && grid[k].t>=t-latchWin; k--){
          if(grid[k].rank>=LP/100 && grid[k].fr>0){ sawHi=true; hiFr=Math.max(hiFr,grid[k].fr); }
          if(grid[k].rank<=1-LP/100 && grid[k].fr<0){ sawLo=true; loFr=Math.min(loFr,grid[k].fr); }
        }
        const fr2h = frAgo(t,2);
        const falling = fr2h!==null && fr < fr2h;
        const rising  = fr2h!==null && fr > fr2h;
        if(sawHi && fr>0 && fr<hiFr && falling && smokeRank(longM,t)>=SP/100) state='SHORT';
        else if(sawLo && fr<0 && fr>loFr && rising && smokeRank(shortM,t)>=SP/100) state='LONG';
      }
      if(state!=='NONE'){
        const d=qldDay(t);
        if(!armedDays.has(d)) armedDays.set(d,{S:0,L:0});
        armedDays.get(d)[state==='SHORT'?'S':'L']+=5;
      }
    }
    out.push('=== mem P'+LP+' / latch '+H+'h / smoke P'+SP+' ===');
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
  fs.writeFileSync('sweep1c_results.txt', out.join('\n')+'\n');
  console.log('wrote sweep1c_results.txt');
})();
