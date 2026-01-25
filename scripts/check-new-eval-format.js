require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = 'job_1769360030111_ufyj3zi84';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;

  console.log('Story:', story.title);
  console.log('\nChecking new evaluation format...\n');

  for (const scene of (story.sceneImages || []).slice(0, 2)) {
    console.log(`\n=== Page ${scene.pageNumber} ===`);

    if (scene.qualityReasoning) {
      const qr = JSON.parse(scene.qualityReasoning);

      if (qr.figures) {
        console.log('\nfigures:');
        console.log(JSON.stringify(qr.figures, null, 2).substring(0, 1000));
      }

      if (qr.matches) {
        console.log('\nmatches:');
        console.log(JSON.stringify(qr.matches, null, 2).substring(0, 1000));
      }

      if (qr.identity_sync) {
        console.log('\nidentity_sync:');
        console.log(JSON.stringify(qr.identity_sync, null, 2).substring(0, 500));
      }
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
