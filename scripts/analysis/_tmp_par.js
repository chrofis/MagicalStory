require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const u = await pool.query("SELECT id FROM users WHERE email='demo-m-hq0f7@magicalstory.ch'");
  const s = await pool.query("SELECT id, data FROM stories WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [u.rows[0].id]);
  const d = s.rows[0].data;
  const log = d.generationLog || [];
  const imgs = log.filter(e => e.stage === 'images' || /image|page|repair|round/i.test(e.event || ''));
  console.log(`=== ${imgs.length} image-stage events ===`);
  const t0 = new Date(imgs[0]?.timestamp || 0).getTime();
  for (const e of imgs) {
    const off = ((new Date(e.timestamp).getTime() - t0) / 1000).toFixed(0);
    console.log(`+${String(off).padStart(5)}s ${e.event}${e.details?.pageNumber != null ? ' p' + e.details.pageNumber : ''} ${String(e.message || '').slice(0, 95)}`);
  }
  // Actual per-image creation timestamps from story_images = the real concurrency signal
  const rows = await pool.query("SELECT page_number, version_index, created_at FROM story_images WHERE story_id=$1 AND image_type='scene' ORDER BY created_at", [s.rows[0].id]);
  console.log(`\n=== ${rows.rows.length} scene images by creation time ===`);
  const b0 = new Date(rows.rows[0].created_at).getTime();
  for (const r of rows.rows) {
    const off = ((new Date(r.created_at).getTime() - b0) / 1000).toFixed(0);
    console.log(`+${String(off).padStart(5)}s  p${String(r.page_number).padStart(2)} v${r.version_index}`);
  }
  await pool.end(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
