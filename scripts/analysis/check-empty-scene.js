#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const jobId = process.argv[2];
  const pageNum = parseInt(process.argv[3], 10);
  const { rows } = await pool.query(`SELECT data FROM stories WHERE id = $1`, [jobId]);
  const d = rows[0].data;
  const scene = (d.sceneImages || [])[pageNum - 1];
  if (!scene) { console.log('no scene'); process.exit(0); }

  console.log('Page ' + pageNum + ' empty-scene fields:');
  console.log('  hasEmptySceneImage:', !!scene.emptySceneImage || !!scene.hasEmptySceneImage);
  console.log('  emptySceneImage stored:', typeof scene.emptySceneImage);
  console.log('  emptySceneQc:', JSON.stringify(scene.emptySceneQc, null, 2));
  console.log('  emptySceneAttempts (history):',
    (scene.emptySceneAttempts || scene.emptySceneRetryHistory || scene.emptySceneHistory || []).length);
  if (scene.emptySceneAttempts) console.log(JSON.stringify(scene.emptySceneAttempts, null, 2));
  if (scene.emptySceneRetryHistory) console.log(JSON.stringify(scene.emptySceneRetryHistory, null, 2));
  if (scene.emptySceneHistory) console.log(JSON.stringify(scene.emptySceneHistory, null, 2));
  console.log('  emptyScenePrompt (first 400):',
    (scene.emptyScenePrompt || '').slice(0, 400));
  console.log('  emptySceneVbGrid:', !!scene.emptySceneVbGrid);

  // List all keys mentioning emptyScene
  console.log('\nAll empty-scene-related keys on this scene:');
  Object.keys(scene).filter(k => /empty/i.test(k)).forEach(k => {
    const v = scene[k];
    const desc = Array.isArray(v) ? `array[${v.length}]`
      : typeof v === 'string' ? `string(${v.length})`
      : typeof v === 'object' && v ? 'object{' + Object.keys(v).join(',') + '}'
      : String(v);
    console.log(`  ${k}: ${desc}`);
  });

  // Save the empty scene image to disk for visual inspection
  if (scene.emptySceneImage && typeof scene.emptySceneImage === 'string' && scene.emptySceneImage.startsWith('data:image')) {
    const out = path.join(require('os').tmpdir(), `empty-scene-p${pageNum}.jpg`);
    const b64 = scene.emptySceneImage.split(',')[1];
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log(`\n💾 Saved empty scene image to: ${out}`);
  }

  // Generation log: count empty scene calls for this page
  const log = (d.generationLog || []).filter(l => /empty/i.test(JSON.stringify(l)) && (
    JSON.stringify(l).includes(`"page":${pageNum}`) || JSON.stringify(l).includes(`page ${pageNum}`)
  ));
  console.log(`\nGeneration-log empty-scene entries for page ${pageNum}:`, log.length);
  log.slice(0, 8).forEach(l => console.log('  ' + JSON.stringify(l).slice(0, 300)));

  await pool.end();
})();
