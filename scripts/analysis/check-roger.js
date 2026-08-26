require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT jsonb_agg(c) AS chars
     FROM stories, jsonb_array_elements(data::jsonb->'characters') AS c
     WHERE id = $1 AND c->>'name' = 'Roger'`,
    [storyId]
  );
  await pool.end();
  const roger = r.rows[0]?.chars?.[0];
  if (!roger) { console.log('no Roger'); process.exit(0); }
  // Strip image data for readability
  const clean = JSON.parse(JSON.stringify(roger));
  const stripImgs = (obj) => {
    for (const k in obj) {
      if (typeof obj[k] === 'string' && obj[k].startsWith('data:image')) obj[k] = `<${Math.round(obj[k].length / 1024)}KB base64>`;
      else if (typeof obj[k] === 'object' && obj[k] !== null) stripImgs(obj[k]);
    }
  };
  stripImgs(clean);
  // Walk the entire object looking for any mention of brille/glasses/spectacle
  const hits = [];
  const walk = (obj, path = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && /brille|glasses|spectacle|eyewear/i.test(v)) {
        hits.push(`${p}: ${v.slice(0, 200)}`);
      } else if (typeof v === 'object') walk(v, p);
    }
  };
  walk(clean);
  console.log('=== mentions of brille/glasses/spectacle ===');
  if (hits.length === 0) console.log('(none found in Roger record)');
  else hits.forEach(h => console.log(h));
  console.log('\n=== top-level keys ===');
  console.log(Object.keys(clean).join(', '));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
