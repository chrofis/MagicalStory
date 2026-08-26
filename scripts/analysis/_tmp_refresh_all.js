// TRIAL 1: refresh-bbox every page + cover of the outage story, sequentially.
const SID=process.env.SID||'job_1787262655143_s9zb960muni';
const BASE='https://magicalstory.ch';
(async()=>{
const {execSync}=require('child_process');
const token=execSync('node scripts/admin/get-admin-token.js --base='+BASE,{encoding:'utf8'}).trim().split('\n').pop();
const pages=[...Array.from({length:18},(_,i)=>i+1), -1, -2, -3];
let ok=0,fail=0;
for(const p of pages){
  const t0=Date.now();
  try{
    const r=await fetch(`${BASE}/api/stories/${SID}/refresh-bbox/${p}`,{
      method:'POST',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      signal:AbortSignal.timeout(420000)});
    const j=await r.json().catch(()=>({}));
    const backend=j?.bboxDetection?.detectionBackend||j?.detectionBackend||'?';
    const figs=(j?.bboxDetection?.figures||j?.figures||[]).length;
    console.log(`p${String(p).padStart(3)}: HTTP ${r.status} backend=${backend} figures=${figs} ${(Date.now()-t0)/1000|0}s`);
    if(r.status===200 && /dino/.test(String(backend))) ok++; else fail++;
  }catch(e){console.log(`p${String(p).padStart(3)}: ERROR ${e.message}`);fail++;}
}
console.log(`\nDONE: ${ok} dino-ok, ${fail} not-ok of ${pages.length}`);
})();
