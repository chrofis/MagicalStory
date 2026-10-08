const fs=require('fs');const c=require('../../../server/lib/trialIdeaCheck');
for (const v of process.argv.slice(2)) { console.log('=====',v);
 for (const l of fs.readFileSync(v+'.jsonl','utf8').trim().split('\n')) { const r=JSON.parse(l);
  let idea=c.stripIdeaSelfCheck(r.text), ok='';
  if(v==='new'){try{const p=c.parseIdeaSelfCheck(r.text);ok=p.ok?'PASS':'FAIL:'+p.failure}catch(e){ok='THROW'}}
  console.log(`[${r.cell}${r.arm[0]}] ${r.axis.obstacleKind||''} ${ok}\n   ${idea.replace(/\n/g,' ')}`);}}
