'use strict';
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2];
  const pages = (process.argv[3]||'1,2,3,4,5,6,7,8,9,10').split(',').map(Number);
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d==='string') d=JSON.parse(d);
  const ir = await pool.query("SELECT DISTINCT ON (page_number) page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND is_test IS NOT TRUE ORDER BY page_number, version_index DESC", [storyId]);
  const url = new Map(ir.rows.map(r=>[r.page_number,r.image_url]));
  await pool.end();
  const fs = require('fs');
  const { loadPromptTemplates } = require('../../server/services/prompts'); await loadPromptTemplates();
  const newComp = fs.readFileSync('prompts/image-prompt-compliance.txt','utf8');
  const newSem = fs.readFileSync('prompts/image-semantic.txt','utf8');
  const { evaluateImageQuality } = require('../../server/lib/images');
  console.log('page | OLD final | NEW final | q / sem / 3s-CRIT | verdict');
  const oldF = {}; for(const s of (d.sceneImages||[])) oldF[s.pageNumber]=s.finalScore;
  let pass=0, wasFail=0;
  for (const pn of pages) {
    const s = (d.sceneImages||[]).find(x=>x.pageNumber===pn); if(!s||!url.get(pn)){console.log(`p${pn} no data`);continue;}
    const buf = Buffer.from(await (await fetch(url.get(pn))).arrayBuffer());
    try {
      const res = await evaluateImageQuality(`data:image/jpeg;base64,${buf.toString('base64')}`, s.prompt||'', s.referencePhotos||[], 'scene', null, `comb-p${pn}`, s.text||null, s.sceneMetadata?.hint||null, s.sceneCharacters||null,
        { complianceModelOverride:'qwen3-max', compliancePromptOverride:newComp, semanticTemplateOverride:newSem });
      const ts = res?.threeStageResult||{};
      const crit = (ts.fixableIssues||ts.issues||[]).filter(i=>/critical/i.test(String(i.severity))).length;
      const nf = res?.score ?? '?';
      if (typeof nf==='number' && nf>=50) pass++;
      if ((oldF[pn]??0) < 50) wasFail++;
      console.log(`p${pn} | ${oldF[pn]} | ${nf} | ${res?.qualityScore}/${res?.semanticScore}/${crit}CRIT | ${ts.verdict||'?'}`);
    } catch(e){ console.log(`p${pn} ERROR ${e.message}`); }
  }
  console.log(`\nNEW pages PASS(>=50): ${pass}/${pages.length}  (were FAIL under old: ${wasFail})`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
