require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.visualBible.secondaryCharacters[*]') AS sc
     FROM stories WHERE id = $1`,
    [storyId]
  );
  console.log(`secondaryCharacters: ${r.rows.length}`);
  for (const row of r.rows) {
    const sc = row.sc;
    const clean = JSON.parse(JSON.stringify(sc));
    const stripImgs = (obj) => {
      for (const k in obj) {
        if (typeof obj[k] === 'string' && obj[k].length > 500) obj[k] = `<${Math.round(obj[k].length / 1024)}KB>`;
        else if (typeof obj[k] === 'object' && obj[k] !== null) stripImgs(obj[k]);
      }
    };
    stripImgs(clean);
    console.log(JSON.stringify(clean, null, 2));
  }

  const m = await pool.query(
    `SELECT jsonb_path_query(data::jsonb, '$.visualBible.mainCharacters[*]') AS mc
     FROM stories WHERE id = $1`,
    [storyId]
  );
  console.log(`\nmainCharacters: ${m.rows.length}`);
  for (const row of m.rows) {
    const mc = row.mc;
    console.log(` - ${mc.id || '?'} ${mc.name || mc.displayName || '?'}  keys: ${Object.keys(mc).join(',')}`);
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
