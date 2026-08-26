require('dotenv').config();
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(
    `SELECT id, status, progress, progress_message, error_message, result_data,
            EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_s,
            EXTRACT(EPOCH FROM (COALESCE(completed_at, updated_at, NOW()) - created_at)) AS dur_s
       FROM story_jobs WHERE id = $1`, [jobId]);
  console.log(`\n=== ${target.toUpperCase()} ${jobId}`);
  if (!j.rows.length) { console.log('NO JOB ROW'); await pool.end(); return; }
  const r = j.rows[0];
  console.log('status:', r.status, '| progress:', r.progress, '| msg:', r.progress_message);
  console.log('age:', Math.round(r.age_s / 60), 'min | duration:', Math.round(r.dur_s / 60), 'min');
  if (r.error_message) console.log('ERROR:', String(r.error_message).slice(0, 600));
  const rd = r.result_data || {};
  const storyId = rd.storyId || rd.story_id || rd.id;
  console.log('storyId:', storyId, '| result_data keys:', Object.keys(rd).join(','));
  if (storyId) {
    const s = await pool.query(`SELECT id, title, data FROM stories WHERE id = $1`, [String(storyId)]);
    if (!s.rows.length) { console.log('no story row'); await pool.end(); return; }
    const d = s.rows[0].data || {};
    const imgs = d.sceneImages || [];
    console.log('title:', s.rows[0].title, '| pages:', imgs.length);
    for (const p of imgs) {
      if (p.compositeOutcome) console.log(`  p${p.pageNumber}: ` + JSON.stringify(p.compositeOutcome).slice(0, 400));
    }
    console.log('pages with compositeOutcome:', imgs.filter(p => p.compositeOutcome).length);
    console.log('pages with preScaleRepairImage:', imgs.filter(p => p.preScaleRepairImage).map(p => p.pageNumber).join(',') || 'none');
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
