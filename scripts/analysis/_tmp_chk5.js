require('dotenv').config();
const { Pool } = require('pg');
const target = process.argv[2];
const cs = target === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
const jobId = process.argv[3];
const want = process.argv.slice(4).map(Number);
(async () => {
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT result_data FROM story_jobs WHERE id = $1`, [jobId]);
  const rd = j.rows[0].result_data || {};
  const imgs = rd.sceneImages || [];
  console.log(`\n=== ${target.toUpperCase()} "${rd.title}"`);
  const vb = rd.visualBible || {};
  console.log('animals:', JSON.stringify((vb.animals || []).map(a => ({ id: a.id, name: a.name, ref: !!a.referenceImageUrl, pages: a.appearsInPages }))));
  console.log('secondary:', JSON.stringify((vb.secondaryCharacters || []).map(a => ({ id: a.id, name: a.name, ref: !!a.referenceImageUrl, pages: a.appearsInPages }))));
  for (const p of imgs) {
    if (!want.includes(p.pageNumber)) continue;
    console.log(`\n--- p${p.pageNumber} ---`);
    console.log('sceneMetadata:', JSON.stringify(p.sceneMetadata).slice(0, 1800));
    console.log('bestSource:', p.bestSource, '| finalScore:', p.finalScore, '| wasCharacterFixed:', p.wasCharacterFixed);
    console.log('versions:', JSON.stringify((p.imageVersions || []).map(v => ({ src: v.source || v.method || v.label, score: v.score || v.finalScore }))));
    console.log('retryHistory:', JSON.stringify((p.retryHistory || []).map(r => r.reason || r.source || r.method)).slice(0, 400));
  }
  await pool.end();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
