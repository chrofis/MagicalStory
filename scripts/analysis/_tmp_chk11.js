require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const target = process.argv[2], storyId = process.argv[3];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const want = process.argv.slice(4).map(Number);
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT page_number, image_url FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=ANY($2::int[])`, [storyId, want]);
  for (const row of r.rows) {
    const buf = Buffer.from(await (await fetch(row.image_url)).arrayBuffer());
    const f = `scripts/analysis/_tmp_chk/${target}-p${row.page_number}-emptyscene.jpg`;
    fs.writeFileSync(f, buf); console.log(f, buf.length);
  }
  await pool.end();
})().catch(e => console.error('FAIL', e.message));
