require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Check a story with evaluation data
  const storyId = process.argv[2] || 'job_1769285688015_idstty79v';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;

  console.log('Story:', story.title);
  console.log('\nChecking sceneImages fields...\n');

  for (const scene of (story.sceneImages || []).slice(0, 3)) {
    console.log(`Page ${scene.pageNumber}:`);
    console.log('  Keys:', Object.keys(scene).join(', '));

    // Check for different evaluation fields
    if (scene.qualityReasoning) {
      console.log('  qualityReasoning: YES');
      try {
        const qr = JSON.parse(scene.qualityReasoning);
        console.log('    Keys:', Object.keys(qr).join(', '));
        if (qr.identity_sync) {
          console.log('    identity_sync count:', qr.identity_sync.length);
          if (qr.identity_sync[0]) {
            console.log('    identity_sync[0] keys:', Object.keys(qr.identity_sync[0]).join(', '));
          }
        }
      } catch (e) {}
    } else {
      console.log('  qualityReasoning: NO');
    }

    if (scene.boxEvaluation) console.log('  boxEvaluation: YES');
    if (scene.faceBoxes) console.log('  faceBoxes: YES');
    if (scene.characterBoxes) console.log('  characterBoxes: YES');
    if (scene.evaluation) console.log('  evaluation: YES');
    if (scene.fixTargets) console.log('  fixTargets:', scene.fixTargets.length, 'targets');

    console.log('');
  }

  // Also check if there's a separate evaluation in finalChecksReport
  if (story.finalChecksReport) {
    console.log('finalChecksReport keys:', Object.keys(story.finalChecksReport).join(', '));
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
