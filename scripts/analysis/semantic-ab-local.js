'use strict';
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const [storyId, pagesCsv] = process.argv.slice(2);
  const pages = (pagesCsv||'').split(',').map(Number).filter(Boolean);
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sres = await pool.query('SELECT data FROM stories WHERE id=$1', [storyId]);
  let d = sres.rows[0].data; if (typeof d==='string') d=JSON.parse(d);
  const ir = await pool.query("SELECT DISTINCT ON (page_number) page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='scene' AND is_test IS NOT TRUE ORDER BY page_number, version_index DESC", [storyId]);
  const url = new Map(ir.rows.map(r=>[r.page_number,r.image_url]));
  await pool.end();
  const { loadPromptTemplates } = require('../../server/services/prompts'); await loadPromptTemplates();
  const newPrompt = require('fs').readFileSync('prompts/image-semantic.txt','utf8');
  const { evaluateSemanticFidelity } = require('../../server/lib/sceneValidator');
  for (const pn of pages) {
    const s = (d.sceneImages||[]).find(x=>x.pageNumber===pn); if(!s||!url.get(pn)){console.log(`p${pn} no data`);continue;}
    const buf = Buffer.from(await (await fetch(url.get(pn))).arrayBuffer());
    const img = `data:image/jpeg;base64,${buf.toString('base64')}`;
    const hint = s.sceneMetadata?.hint || s.outlineExtract || null;
    // OLD (current deployed prompt) vs NEW (edited file)
    const oldRes = await evaluateSemanticFidelity(img, s.text||'', s.prompt||'', hint, null);
    const newRes = await evaluateSemanticFidelity(img, s.text||'', s.prompt||'', hint, newPrompt);
    const cnt = r => (r?.semanticIssues||r?.issues||[]).length;
    const sc = r => r?.score ?? r?.semanticScore ?? '?';
    console.log(`p${pn}: OLD sem=${sc(oldRes)} (${cnt(oldRes)} iss)  ->  NEW sem=${sc(newRes)} (${cnt(newRes)} iss)`);
    (newRes?.semanticIssues||newRes?.issues||[]).forEach(i=>console.log(`     NEW [${i.severity}] ${String(i.problem||i.description||'').slice(0,100)}`));
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
