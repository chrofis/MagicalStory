process.env.FIGURE_DETECTION_BACKEND = 'grounding-dino';
require('dotenv').config();
process.env.REPLICATE_API_TOKEN = '';  // disable API tier so it can't hang on throttle
const fs = require('fs');
const { detectAllBoundingBoxes } = require('../../server/lib/images.js');
const SP = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const pageUri = 'data:image/jpeg;base64,' + fs.readFileSync(SP + '/samfig-page.jpg').toString('base64');
const expectedCharacters = [
  { name: 'Emma',   description: 'a preschooler girl with brown hair in a pink top and blue jeans' },
  { name: 'Noah',   description: 'a young boy with blonde hair in a blue and white striped shirt and navy trousers' },
  { name: 'Daniel', description: 'an adult man with dark brown hair and a short beard in a green polo shirt' },
  { name: 'Sarah',  description: 'an adult woman with blonde hair and glasses in a yellow blouse and grey trousers' },
  { name: 'Hans',   description: 'an elderly man with white hair and a white mustache in a beige shirt' },
];
const TRUTH = { Emma:[21,70], Noah:[72,70], Daniel:[56,38], Sarah:[73,47], Hans:[65,20] };
const t = () => (Date.now()-T0)/1000|0;
const T0 = Date.now();
(async () => {
  console.log(`[${t()}s] calling detectAllBoundingBoxes...`);
  const r = await detectAllBoundingBoxes(pageUri, { expectedCharacters, expectedObjects: [], skipCache: true, pageContext: 'verify' });
  console.log(`[${t()}s] done. backend=${r?.detectionBackend} figures=${r?.figures?.length}`);
  if (!r?.figures) { console.log('NULL (fell back to Gemini)'); process.exit(1); }
  let ok = 0;
  for (const f of r.figures) {
    const contract = typeof f.name==='string' && Array.isArray(f.bodyBox) && f.bodyBox.length===4 && ['high','medium','low'].includes(f.confidence);
    const [ymin,xmin,ymax,xmax]=f.bodyBox; const cx=(xmin+xmax)/2*100, cy=(ymin+ymax)/2*100;
    const tr=TRUTH[f.name]; const hit=tr&&Math.hypot(cx-tr[0],cy-tr[1])<18; if(hit)ok++;
    console.log(`  ${f.name}: conf=${f.confidence} face=${f.faceBox?'set':'null'} centroid(${cx.toFixed(0)},${cy.toFixed(0)}) ${hit?'CORRECT':'wrong'} contract:${contract?'OK':'BAD'}`);
  }
  console.log(`=== ${ok}/5 correct ===`);
  process.exit(0);
})().catch(e => { console.error(`[${t()}s] FAIL:`, e.message); process.exit(1); });
