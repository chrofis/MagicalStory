require('dotenv').config();
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const storyId = process.argv[3];
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='story_images'`);
  const names = cols.rows.map(r => r.column_name);
  const sel = names.filter(n => n !== 'image_data').join(', ');
  const r = await pool.query(`SELECT ${sel}, length(image_data) AS bytes FROM story_images WHERE story_id=$1 ORDER BY page_number, version_index`, [storyId]);
  console.log(`\n=== ${target.toUpperCase()} story_images rows: ${r.rows.length}`);
  const byPage = {};
  for (const row of r.rows) (byPage[row.page_number] ||= []).push(row);
  for (const [pg, rows] of Object.entries(byPage)) {
    console.log(`  p${pg}: ${rows.length} versions -> ${rows.map(x => `v${x.version_index}(${x.source || x.method || x.label || '?'})`).join(' ')}`);
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
