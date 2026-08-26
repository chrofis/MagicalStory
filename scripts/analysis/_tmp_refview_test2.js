require('dotenv').config();
const fs=require('fs'); const SP=process.env.SP;
(async()=>{
  await require('../../server/services/prompts').loadPromptTemplates();
  const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
  const { callGeminiAPIForImage } = require('../../server/lib/images');
  const STYLE='soft childrens-book watercolour, visible brushwork, loose washes';
  // Description as the NEW bible rule produces it: object only, face kept out.
  const DESC_FACEFREE='a single sheet of thick yellowed parchment roughly the size of two open palms, soft deckled edges with small tears, a large brown water stain spreading from one edge inward';
  const RV='It is rolled into a loose scroll and tied with a thin leather cord, lying on its side with only the blank outer surface of the parchment turned to us.';
  const arms=[['C-facefree-closed', {id:'ART001',name:'m',description:DESC_FACEFREE, referenceView:RV}]];
  for (const [label, el] of arms) {
    const prompt=buildReferenceSheetPrompt([el], STYLE, null);
    fs.writeFileSync(`${SP}/refview-${label}.txt`, prompt);
    const r=await callGeminiAPIForImage(prompt, [], null, 'avatar', null, null, null, '');
    const data=r && (r.imageData||r.image||r.data);
    if (!data) { console.log(label,'NO IMAGE'); continue; }
    fs.writeFileSync(`${SP}/img/refview-${label}.jpg`, Buffer.from(String(data).replace(/^data:image\/\w+;base64,/,''),'base64'));
    console.log(label,'OK');
  }
})().catch(e=>{console.error('THREW:',e&&e.message);process.exit(1);});
