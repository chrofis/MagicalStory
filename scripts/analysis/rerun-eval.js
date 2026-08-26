// Re-run the three-stage compliance eval on a specific stored image,
// using the CURRENT prompt templates (live edits to image-prompt-compliance.txt
// take effect immediately).
//
// Usage: node scripts/analysis/rerun-eval.js <storyId> <pageNumber> [versionIndex]
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const path = require('path');

(async () => {
  const storyId = process.argv[2];
  const pageNumber = parseInt(process.argv[3] || '4', 10);
  const versionIndex = parseInt(process.argv[4] || '0', 10);
  if (!storyId) { console.error('Usage: <storyId> <pageNum> [versionIndex]'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const imgR = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' AND version_index=$3`,
    [storyId, pageNumber, versionIndex]
  );
  if (!imgR.rows[0]) { console.error('image not found'); await pool.end(); process.exit(1); }
  const imageData = imgR.rows[0].image_data;

  const sceneR = await pool.query(
    `SELECT scene->>'sceneDescription' AS sd, scene->>'prompt' AS p
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id=$1 AND (scene->>'pageNumber')::int=$2`,
    [storyId, pageNumber]
  );
  await pool.end();
  if (!sceneR.rows[0]) { console.error('scene not found'); process.exit(1); }
  const sceneDescription = sceneR.rows[0].sd;
  const storedPrompt = sceneR.rows[0].p || sceneDescription;

  const { loadPromptTemplates } = require(path.resolve(__dirname, '..', '..', 'server', 'services', 'prompts'));
  await loadPromptTemplates();
  const { evaluateThreeStage } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'images'));

  console.log(`Re-running compliance eval on story=${storyId} P${pageNumber} v${versionIndex}`);
  console.log(`Image bytes: ${Math.round(imageData.length / 1024)}KB`);
  console.log(`Prompt chars: ${storedPrompt.length}`);
  console.log('');

  const result = await evaluateThreeStage(imageData, storedPrompt, sceneDescription, {
    pageContext: `PAGE ${pageNumber} v${versionIndex}`
  });

  if (!result) { console.error('eval returned null'); process.exit(1); }

  console.log('=== RESULT ===');
  console.log(`score: ${result.score}/100  (raw stage2: ${result.stage2?.score}/10)`);
  console.log(`verdict: ${result.verdict}`);
  console.log(`fixable_issues: ${result.fixableIssues?.length || 0}`);
  if (result.fixableIssues?.length) {
    for (const f of result.fixableIssues) {
      console.log(`  [${f.severity}] (${f.type}) ${f.description}`);
      console.log(`    fix: ${f.fix}`);
    }
  }
  console.log('\n=== Stage 1 vision inventory ===');
  console.log(result.stage1?.vision?.slice(0, 1500));
  console.log('\n=== Stage 2 compliance JSON ===');
  console.log(JSON.stringify(result.stage2, null, 2));
})().catch(e => { console.error(e.message); console.error(e.stack); process.exit(1); });
