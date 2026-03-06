require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const r = await pool.query(`
    SELECT id, data->>'title' as title,
           length(data->'coverImages'->'frontCover'->>'imageData') as front_len,
           length(data->'coverImages'->'frontCover'->>'bboxOverlayImage') as front_overlay,
           data->'coverImages'->'frontCover'->'bboxDetection'->'figures' as front_figs,
           length(data->'coverImages'->'initialPage'->>'bboxOverlayImage') as initial_overlay,
           data->'coverImages'->'initialPage'->'bboxDetection'->'figures' as initial_figs,
           length(data->'coverImages'->'backCover'->>'bboxOverlayImage') as back_overlay,
           data->'coverImages'->'backCover'->'bboxDetection'->'figures' as back_figs
    FROM stories ORDER BY created_at DESC LIMIT 1
  `);
  const s = r.rows[0];
  console.log('Story:', s.id);
  console.log('Title:', s.title);
  console.log('\nfrontCover:');
  console.log('  imageData:', s.front_len || 0, 'chars');
  console.log('  bboxOverlay:', s.front_overlay || 0, 'chars');
  console.log('  figures:', s.front_figs?.length || 0);
  if (s.front_figs) s.front_figs.forEach((f,i) => console.log(`    [${i}] ${f.name} bodyBox:`, f.bodyBox));

  console.log('\ninitialPage:');
  console.log('  bboxOverlay:', s.initial_overlay || 0, 'chars');
  console.log('  figures:', s.initial_figs?.length || 0);
  if (s.initial_figs) s.initial_figs.forEach((f,i) => console.log(`    [${i}] ${f.name} bodyBox:`, f.bodyBox));

  console.log('\nbackCover:');
  console.log('  bboxOverlay:', s.back_overlay || 0, 'chars');
  console.log('  figures:', s.back_figs?.length || 0);
  if (s.back_figs) s.back_figs.forEach((f,i) => console.log(`    [${i}] ${f.name} bodyBox:`, f.bodyBox));

  await pool.end();
})();
