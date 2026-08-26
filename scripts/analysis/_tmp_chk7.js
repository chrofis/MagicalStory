require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const storyId = process.argv[3];
const want = process.argv.slice(4).map(Number);
const OUT = 'scripts/analysis/_tmp_chk/';
const save = (name, buf) => {
  const ext = buf[0] === 0x89 ? 'png' : 'jpg';
  fs.writeFileSync(OUT + name + '.' + ext, buf);
  console.log('  wrote', name + '.' + ext, buf.length, 'bytes');
};
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(
    `SELECT page_number, version_index, image_data FROM story_images
      WHERE story_id=$1 AND page_number = ANY($2::int[]) ORDER BY page_number, version_index`,
    [storyId, want]);
  console.log(`${target}: ${r.rows.length} rows`);
  let i = 0;
  for (const row of r.rows) {
    let d = row.image_data;
    let buf;
    if (Buffer.isBuffer(d)) d = d.toString('utf8');
    d = String(d);
    if (d.startsWith('data:')) buf = Buffer.from(d.split(',')[1], 'base64');
    else if (d.startsWith('http')) { const res = await fetch(d); buf = Buffer.from(await res.arrayBuffer()); }
    else buf = Buffer.from(d, 'base64');
    save(`${target}-p${row.page_number}-v${row.version_index}-${i++}`, buf);
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
