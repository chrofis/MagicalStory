require('dotenv').config();
const fs=require('fs'); const SP=process.env.SP;
(async()=>{
  await require('../../server/services/prompts').loadPromptTemplates();
  const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
  const { callGeminiAPIForImage } = require('../../server/lib/images');
  const STYLE='soft childrens-book watercolour, visible brushwork, loose washes';
  const els=[
    {id:'ART001',description:'a single sheet of thick yellowed parchment the size of two open palms, soft deckled edges with small tears, a large brown water stain spreading from one edge inward',
     referenceView:'It is rolled into a loose scroll and tied with a thin leather cord, lying on its side with only the blank outer surface of the parchment turned to us.'},
    {id:'ART002',description:'a small hand-held notebook, dark brown worn leather covers with a wraparound strap, cream paper block, corners softened with use',
     referenceView:'It is shut with the strap wrapped round it, lying flat with the front cover facing up.'},
    {id:'ART003',description:'a hanging ship lantern, black iron frame with four flat glass panels and a looped handle at the top, candle stub inside'},
    {id:'ART004',description:'a coiled hemp rope, pale tan with darker brown twist lines, wound into a flat circle with the tail end resting across the top loop'},
  ];
  const prompt=buildReferenceSheetPrompt(els, STYLE, null);
  fs.writeFileSync(`${SP}/refview-D-batch4.txt`, prompt);
  const r=await callGeminiAPIForImage(prompt, [], null, 'avatar', null, null, null, '');
  const data=r && (r.imageData||r.image||r.data);
  if (!data) return console.log('NO IMAGE');
  fs.writeFileSync(`${SP}/img/refview-D-batch4.jpg`, Buffer.from(String(data).replace(/^data:image\/\w+;base64,/,''),'base64'));
  console.log('D-batch4 OK');
})().catch(e=>{console.error('THREW:',e&&e.message);process.exit(1);});
