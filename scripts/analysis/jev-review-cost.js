require('dotenv').config({path:__dirname+'/../../.env'});
const J=require('../../server/lib/jevAudit');const fs=require('fs');const D=__dirname+'/../../evals/runs/2026-10-09_jev-review/';
const rd=f=>fs.readFileSync(D+f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
(async()=>{
 const sum=(f)=>rd(f).reduce((s,x)=>s+(x.cost||0),0);
 const files={mismatch:'mismatch_answers.jsonl',trials:'trials_answers.jsonl',plan:'plan_answers.jsonl'};
 let tot=0;for(const [k,f] of Object.entries(files)){const c=sum(f);tot+=c;console.log(k,c.toFixed(4));}
 // sentence-call cost sample
 const sents=rd('text_answers.jsonl').length, st=JSON.parse(fs.readFileSync(D+'stories.json','utf8'));
 const r=await J.callJev({state:'Der Hund lief über die Wiese und bellte laut.',questions:{Q:{type:'noul',instructions:'The sentence states a size, colour or look of a thing or person, which the plot does not depend on.'}}});
 const per=r.cost;console.log('sentence call cost',per,'x',sents,'=',(per*sents).toFixed(4));tot+=per*sents;
 const counts={toddler:rd('toddler_answers.jsonl').length,q2:rd('q2_answers.jsonl').length,q12:rd('q12_answers.jsonl').length,page:rd('page_answers.jsonl').length,mention:rd('mention_answers.jsonl').length};
 // approximate cost per page/story-level call: use measured: page 0.00887/458, mention .00649/222, q2 .01244, toddler .024
 tot+=0.024+0.01244+0.00887+0.00649+counts.q12*0.00002;console.log(counts,'total est $'+tot.toFixed(3));
})();
