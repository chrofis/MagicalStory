#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  const d = rows[0].data;

  // Outline section for this page (what Sonnet wrote in the unified pass)
  const outline = d.outline || '';
  const pageRe = new RegExp(
    `(?:^|\\n)\\*\\*Page ${pageNum}\\*\\*([\\s\\S]*?)(?=\\n\\*\\*Page ${pageNum + 1}\\*\\*|\\n---|$)`,
    'i'
  );
  const m = outline.match(pageRe);
  console.log('============================================================');
  console.log(`OUTLINE — Page ${pageNum} block (what Sonnet wrote)`);
  console.log('============================================================');
  console.log(m ? `**Page ${pageNum}**${m[1]}` : '(not found in outline)');

  const scene = (d.sceneImages || [])[pageNum - 1];
  if (!scene) { console.log('\n(no sceneImage for this page)'); await pool.end(); return; }

  console.log('\n============================================================');
  console.log('SCENE METADATA (parsed from unified prose)');
  console.log('============================================================');
  console.log(JSON.stringify(scene.sceneMetadata || scene.outlineExtract || null, null, 2));

  console.log('\n============================================================');
  console.log('SCENE DESCRIPTION (full prose used in prompt)');
  console.log('============================================================');
  console.log(scene.sceneDescription || scene.description || '(none)');

  // v0 prompt = the original send to Grok
  const v0 = (scene.imageVersions || [])[0];
  console.log('\n============================================================');
  console.log('FULL PROMPT SENT TO GROK FOR v0 (original)');
  console.log('============================================================');
  console.log(v0?.prompt || scene.prompt || '(none)');

  console.log('\n============================================================');
  console.log('REFERENCE IMAGES SENT TO GROK FOR v0');
  console.log('============================================================');
  if (Array.isArray(v0?.grokRefImages)) {
    console.log(`count: ${v0.grokRefImages.length}`);
    v0.grokRefImages.forEach((r, i) => {
      const head = typeof r === 'string' ? r.slice(0, 60) : JSON.stringify(r).slice(0, 60);
      console.log(`  [${i}] ${head}...`);
    });
  } else if (Array.isArray(scene.grokRefImages)) {
    console.log(`(top-level grokRefImages, count: ${scene.grokRefImages.length})`);
  } else {
    console.log('(none stored)');
  }

  await pool.end();
})();
