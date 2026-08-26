require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT result_data FROM story_jobs WHERE id=$1`, ['job_1787514666616_yw9qsv1vf']);
  const rd = j.rows[0].result_data;
  console.log('vehicles:', JSON.stringify((rd.visualBible.vehicles || []).map(v => ({ id: v.id, name: v.name, pages: v.appearsInPages }))));
  const p4 = rd.sceneImages.find(p => p.pageNumber === 4);
  const cs = p4.sceneMetadata.fullData.characters;
  console.log('\np4 positions:');
  cs.forEach(c => console.log(`  ${c.name.padEnd(9)} depth=${(c.depth||'').padEnd(11)} position="${c.position}"`));
  console.log('\np4 shot:', p4.sceneMetadata.fullData.shot, '| objects:', p4.sceneMetadata.objects.join(','));
  await pool.end();
})().catch(e => console.error('FAIL', e.message));
