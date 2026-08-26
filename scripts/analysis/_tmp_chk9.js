require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const storyId = process.argv[3];
const want = process.argv.slice(4).map(Number);
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const t = await pool.query(`SELECT image_type, count(*) FROM story_images WHERE story_id=$1 GROUP BY 1 ORDER BY 1`, [storyId]);
  console.log(`\n${target} image_types:`, t.rows.map(r => `${r.image_type}=${r.count}`).join(' '));
  const r = await pool.query(
    `SELECT page_number, version_index, image_type, image_url FROM story_images
      WHERE story_id=$1 AND page_number = ANY($2::int[]) AND image_type='scene' ORDER BY page_number, version_index`, [storyId, want]);
  for (const row of r.rows) {
    const res = await fetch(row.image_url);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = `scripts/analysis/_tmp_chk/${target}-p${row.page_number}-v${row.version_index}.jpg`;
    fs.writeFileSync(name, buf);
    console.log('  ', name, buf.length, 'bytes');
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
