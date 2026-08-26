// Dump P5 prompt + character photos — using targeted JSON extraction
// (story data blob is 126MB, can't fetch whole thing).
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT_DIR = __dirname;
const STORY_ID = 'job_1776286048220_aj0q6y71p';
const PAGE = 5;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });

  console.log('querying P5 scene (targeted)...');
  const r = await pool.query(`
    SELECT scene FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const scene = r.rows[0].scene;
  console.log('scene loaded');

  const prompt = scene.prompt || '';
  fs.writeFileSync(path.join(OUT_DIR, 'p5_prompt.txt'), prompt);
  console.log('p5_prompt.txt saved (' + prompt.length + ' chars)');

  const refs = scene.referencePhotos || [];
  console.log('characters:', refs.length);
  for (let i = 0; i < refs.length; i++) {
    const p = refs[i];
    const url = p.photoUrl || p.photoData;
    if (!url || !url.startsWith('data:image')) { console.log('  skip', p.name); continue; }
    const b64 = url.replace(/^data:image\/\w+;base64,/, '');
    const ext = url.match(/^data:image\/(\w+)/)?.[1] || 'jpg';
    const tag = `${p.name || 'char'}-${p.photoType || 'main'}`.replace(/[^a-z0-9_-]/gi, '_');
    fs.writeFileSync(path.join(OUT_DIR, `p5_char_${i + 1}_${tag}.${ext}`), Buffer.from(b64, 'base64'));
    console.log('  saved', tag);
  }

  await pool.end();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
