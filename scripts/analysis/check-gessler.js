require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT jsonb_agg(jsonb_build_object(
       'name', c->>'name',
       'type', c->>'type',
       'role', c->>'role',
       'isMain', c->>'isMain',
       'keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(c) k)
     )) AS chars
     FROM stories, jsonb_array_elements(data::jsonb->'characters') AS c
     WHERE id = $1`,
    [storyId]
  );
  console.log('characters:');
  console.log(JSON.stringify(r.rows[0]?.chars, null, 2));

  const vb = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.visualBible') AS vb
     FROM stories WHERE id = $1`,
    [storyId]
  );
  const visualBible = vb.rows[0]?.vb;
  if (visualBible) {
    console.log('\nvisualBible top-level keys:', Object.keys(visualBible));
    if (visualBible.characters) {
      console.log('VB characters:');
      for (const c of visualBible.characters) {
        console.log(' -', c.id || '?', c.name || '?', 'keys:', Object.keys(c).join(','));
      }
    }
  } else {
    console.log('\nNo visualBible field');
  }

  // Look at scene 8 metadata
  const s = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.sceneImages[*] ? (@.pageNumber == 8)') AS scene
     FROM stories WHERE id = $1`,
    [storyId]
  );
  const scene = s.rows[0]?.scene;
  if (scene) {
    const clean = JSON.parse(JSON.stringify(scene));
    delete clean.imageData;
    delete clean.imageVersions;
    delete clean.emptySceneImage;
    console.log('\nscene 8 (minus images):');
    console.log(JSON.stringify(clean, null, 2).slice(0, 4000));
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
