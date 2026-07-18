'use strict';
require('dotenv').config();
process.env.FIGURE_DETECTION_BACKEND = 'grounding-dino';
const { Pool } = require('pg');
(async () => {
  const storyId = 'job_1784404956456_ggvjxti9d';
  const pages = (process.argv[2]||'1,3,5').split(',').map(Number);
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d==='string') d=JSON.parse(d);
  const ir = await pool.query("SELECT DISTINCT ON (page_number) page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND is_test IS NOT TRUE ORDER BY page_number, version_index DESC", [storyId]);
  const url = new Map(ir.rows.map(r=>[r.page_number,r.image_url]));
  await pool.end();
  const { detectAllBoundingBoxes, buildExpectedCharactersForBbox, buildObjectGroundingHints } = require('../../server/lib/images');
  const { buildCharacterDescriptionsForBbox } = require('../../server/lib/storyHelpers');
  for (const pn of pages) {
    const s = (d.sceneImages||[]).find(x=>x.pageNumber===pn); if(!s||!url.get(pn)){console.log(`p${pn} no data`);continue;}
    const buf = Buffer.from(await (await fetch(url.get(pn))).arrayBuffer());
    const img = `data:image/jpeg;base64,${buf.toString('base64')}`;
    const meta = s.sceneMetadata||{};
    const names = (s.sceneCharacters||[]).map(c=>typeof c==='string'?c:c?.name).filter(Boolean);
    const descs = buildCharacterDescriptionsForBbox(d, meta.characterPositions||{});
    const onPage = {}; for(const n of names){const k=Object.keys(descs).find(x=>x.toLowerCase()===n.toLowerCase()); if(k)onPage[k]=descs[k];}
    const expected = buildExpectedCharactersForBbox(onPage, meta.characterPositions||{}, meta.characterClothing||{});
    try {
      const det = await detectAllBoundingBoxes(img, { expectedCharacters: expected, expectedObjects: [], pageContext:`som-p${pn}`, skipCache:true, artStyle: d.artStyle });
      const named = (det?.figures||[]).filter(f=>f.name!=='UNKNOWN').map(f=>f.name);
      const som = det?.gdinoDiag?.identity?.answers ? JSON.stringify(det.gdinoDiag.identity.answers) : '';
      const missing = names.filter(e=>!named.map(x=>x.toLowerCase()).includes(e.toLowerCase()));
      console.log(`p${pn} exp[${names.join(',')}] named[${named.join(',')}] ${missing.length?'MISSING:'+missing.join(','):'✓ ALL'}  SoM=${som}`);
    } catch(e){ console.log(`p${pn} ERROR ${e.message}`); }
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
