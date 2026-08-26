const fs=require('fs');
const SP=process.env.SP;
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata');
const { checkPage } = require('../../server/lib/sceneBriefCheck');
const acts=md=>[...new Set(((md&&md.interactions)||[]).map(i=>String(i.action||'').trim().toLowerCase()).filter(a=>a&&!['watching','standing'].includes(a)))];
const hands=md=>((md&&md.interactions)||[]).filter(i=>i.hands===true).map(i=>`${i.character}->${i.object}`);
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const d=j.data, cast=(d.characters||[]).map(c=>c.name).filter(Boolean);
  const pre=(d.sceneReviewReport&&d.sceneReviewReport.briefsIn)||[];
  const post=d.sceneImages||[];
  console.log(`\n######## ${f} — ${j.title}`);
  console.log('page | BEFORE actions                              -> AFTER actions                              | before/after findings');
  for (const p of post) {
    const preB = pre.find(b=>b.pageNumber===p.pageNumber || b.page===p.pageNumber) || pre[p.pageNumber-1];
    const preMd = preB ? extractSceneMetadata(preB.brief||preB.sceneDescription||'') : null;
    const postMd = p.sceneMetadata || extractSceneMetadata(p.sceneDescription||'');
    const fPre = preB ? checkPage({pageNumber:p.pageNumber,brief:preB.brief||'',metadata:preMd},cast,d.visualBible).map(x=>x.type.replace('interaction_','')) : ['?'];
    const fPost = checkPage({pageNumber:p.pageNumber,brief:p.sceneDescription||'',metadata:postMd},cast,d.visualBible).map(x=>x.type.replace('interaction_',''));
    const chg = (fPre.length&&!fPost.length)?' FIXED':(fPost.length?' STILL-BAD':'');
    console.log(String(p.pageNumber).padStart(4)+' | '+
      (preMd?acts(preMd).join(' + '):'(no pre)').padEnd(44).slice(0,44)+' -> '+
      acts(postMd).join(' + ').padEnd(44).slice(0,44)+' | '+
      '['+fPre.join(',')+'] -> ['+fPost.join(',')+']'+chg);
  }
}
