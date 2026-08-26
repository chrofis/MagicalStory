require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const storyId = process.argv[2] || 'job_1776601005131_7dxzq9184';
  const pageNumber = parseInt(process.argv[3] || '8', 10);
  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const r = await pool.query(
    `SELECT version_index, length(image_data) AS bytes, image_data
     FROM story_images
     WHERE story_id = $1 AND page_number = $2 AND image_type = 'scene'
     ORDER BY version_index ASC`,
    [storyId, pageNumber]
  );

  if (!r.rows.length) { console.log('no images'); await pool.end(); return; }

  const sharp = require('sharp');
  for (const row of r.rows) {
    const b64 = row.image_data.replace(/^data:image\/[a-z]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    try {
      const meta = await sharp(buf).metadata();
      console.log(`v${row.version_index}: ${meta.width}x${meta.height} (${meta.format}), aspect ${(meta.width/meta.height).toFixed(3)}, ${Math.round(row.bytes/1024)}KB`);
    } catch (e) {
      console.log(`v${row.version_index}: decode error ${e.message}`);
    }
  }

  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
