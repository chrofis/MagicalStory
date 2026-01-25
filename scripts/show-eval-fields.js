require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = process.argv[2] || 'job_1769360030111_ufyj3zi84';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;
  const scene = story.sceneImages[0];
  const qr = typeof scene.qualityReasoning === 'string'
    ? JSON.parse(scene.qualityReasoning)
    : scene.qualityReasoning;

  console.log('=== ALL TOP-LEVEL KEYS ===');
  console.log(Object.keys(qr).join(', '));

  console.log('\n=== FIGURES ===');
  console.log(JSON.stringify(qr.figures, null, 2));

  console.log('\n=== MATCHES ===');
  console.log(JSON.stringify(qr.matches, null, 2));

  console.log('\n=== IDENTITY_SYNC (old format) ===');
  console.log(JSON.stringify(qr.identity_sync, null, 2));

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
