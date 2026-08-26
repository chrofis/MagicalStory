require('dotenv').config();
const fs=require('fs');
const SP=process.env.SP;
(async()=>{
  await require('../../server/services/prompts').loadPromptTemplates();
  const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
  const { callGeminiAPIForImage } = require('../../server/lib/images');
  const STYLE='soft childrens-book watercolour, visible brushwork, loose washes';
  const DESC='a single sheet of thick yellowed parchment roughly the size of two open palms, soft deckled edges with small tears, a crease across the middle, a large brown water stain spreading from one edge inward, all markings are illegible weathered marks';
  const RV='It is rolled into a loose scroll and tied with a thin leather cord, resting on its side so only the blank outer surface of the parchment is visible.';
  const arms=[
    ['A-control-open', {id:'ART001',name:'m',description:DESC}],
    ['B-closed-refview',{id:'ART001',name:'m',description:DESC, referenceView:RV}],
  ];
  for (const [label, el] of arms) {
    const prompt=buildReferenceSheetPrompt([el], STYLE, null);
    fs.writeFileSync(`${SP}/refview-${label}.txt`, prompt);
    const t=Date.now();
    const r=await callGeminiAPIForImage(prompt, [], null, 'avatar', null, null, null, '');
    const data=r && (r.imageData||r.image||r.data);
    if (!data) { console.log(label,'NO IMAGE', JSON.stringify(r).slice(0,200)); continue; }
    const b64=String(data).replace(/^data:image\/\w+;base64,/,'');
    fs.writeFileSync(`${SP}/img/refview-${label}.jpg`, Buffer.from(b64,'base64'));
    console.log(label, 'OK', ((Date.now()-t)/1000).toFixed(1)+'s', Math.round(b64.length*0.75/1024)+'kB');
  }
})().catch(e=>{console.error('THREW:',e&&e.message);process.exit(1);});
