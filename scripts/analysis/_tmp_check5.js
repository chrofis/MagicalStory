const fs=require('fs');
const SP=process.env.SP;
const j=JSON.parse(fs.readFileSync(`${SP}/prod.json`,'utf8'));
const p=(j.data.sceneImages||[]).find(x=>x.pageNumber===15);
const strip=(o,d=0)=>{ if(d>6) return '…'; if(Array.isArray(o)) return o.slice(0,4).map(x=>strip(x,d+1)); if(o&&typeof o==='object'){const r={};for(const k of Object.keys(o)){ if(/imageData|image_data|base64/i.test(k)) {r[k]='<img>';continue;} r[k]=strip(o[k],d+1);} return r;} if(typeof o==='string'&&o.length>300) return o.slice(0,300)+'…'; return o; };
for (const k of Object.keys(p)) {
  if (['prompt','sceneDescription','sceneDescriptionPrompt','emptyScenePrompt','entityReport','textAreaMask','visualBibleGrid','emptySceneVbGrid','grokRefImages','referencePhotos','landmarkPhotos','imageVersions','thinkingText','text','description'].includes(k)) continue;
  console.log('###',k,'=',JSON.stringify(strip(p[k])).slice(0,1200));
}
console.log('\n=== STORY-LEVEL REPORT KEYS ===');
for (const k of ['finalChecksReport','sceneReviewReport','beatsReviewReport','textRefineReport','clothingReviewReport','arcReviewReport','runMetrics']) {
  const v=j.data[k];
  console.log(k, v?('keys: '+(Array.isArray(v)?`array[${v.length}]`:Object.keys(v).join(','))):'(none)');
}
