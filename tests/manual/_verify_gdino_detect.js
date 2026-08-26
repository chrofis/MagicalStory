process.env.FIGURE_DETECTION_BACKEND = 'grounding-dino';   // MUST be set before require
require('dotenv').config();
const fs = require('fs');
const { detectAllBoundingBoxes } = require('../../server/lib/images.js');

const SP = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/f5744f7b-c499-46ca-85f3-52fc37a98884/scratchpad';
const pageUri = 'data:image/jpeg;base64,' + fs.readFileSync(SP + '/samfig-page.jpg').toString('base64');

// full-identity descriptions become the DINO text prompts
const expectedCharacters = [
  { name: 'Emma',   description: 'a preschooler girl with brown hair in a pink top and blue jeans' },
  { name: 'Noah',   description: 'a young boy with blonde hair in a blue and white striped shirt and navy trousers' },
  { name: 'Daniel', description: 'an adult man with dark brown hair and a short beard in a green polo shirt' },
  { name: 'Sarah',  description: 'an adult woman with blonde hair and glasses in a yellow blouse and grey trousers' },
  { name: 'Hans',   description: 'an elderly man with white hair and a white mustache in a beige shirt' },
];
const TRUTH = { Emma:[21,70], Noah:[72,70], Daniel:[56,38], Sarah:[73,47], Hans:[65,20] };

(async () => {
  const t0 = Date.now();
  const r = await detectAllBoundingBoxes(pageUri, { expectedCharacters, expectedObjects: [], skipCache: true, pageContext: 'verify' });
  console.log('backend:', r?.detectionBackend, '| figures:', r?.figures?.length, '| ' + ((Date.now()-t0)/1000).toFixed(0) + 's');
  if (!r?.figures) { console.log('NULL result (fell back to Gemini?)'); process.exit(1); }
  // contract fields + accuracy
  let ok = 0;
  const boxes = {};
  for (const f of r.figures) {
    const contract = typeof f.name === 'string' && Array.isArray(f.bodyBox) && f.bodyBox.length === 4 && ['high','medium','low'].includes(f.confidence);
    const [ymin,xmin,ymax,xmax] = f.bodyBox;
    const cx = (xmin+xmax)/2*100, cy = (ymin+ymax)/2*100;
    boxes[f.name] = f.bodyBox;
    const t = TRUTH[f.name]; const hit = t && Math.hypot(cx-t[0], cy-t[1]) < 18;
    if (hit) ok++;
    console.log(`  ${f.name}: conf=${f.confidence} face=${f.faceBox?'yes':'null'} bodyBox=[${f.bodyBox.map(v=>v.toFixed(2))}] centroid(${cx.toFixed(0)},${cy.toFixed(0)}) ${hit?'CORRECT':'wrong'} contract:${contract?'OK':'BAD'}`);
  }
  // pairwise bodyBox overlap (sanity — should be < 30% overlap-of-smaller)
  const names = Object.keys(boxes);
  const areaN = b => Math.max(0,(b[2]-b[0]))*Math.max(0,(b[3]-b[1]));
  let maxOv = 0, maxPair = '';
  for (let i=0;i<names.length;i++) for (let j=i+1;j<names.length;j++){
    const a=boxes[names[i]], b=boxes[names[j]];
    const iy=Math.max(0, Math.min(a[2],b[2])-Math.max(a[0],b[0]));
    const ix=Math.max(0, Math.min(a[3],b[3])-Math.max(a[1],b[1]));
    const inter=iy*ix; const ov=inter/Math.max(1e-9,Math.min(areaN(a),areaN(b)));
    if(ov>maxOv){maxOv=ov;maxPair=names[i]+'/'+names[j];}
  }
  console.log(`=== ${ok}/5 correct | max bodyBox-overlap ${(maxOv*100).toFixed(0)}% (${maxPair}) ===`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
