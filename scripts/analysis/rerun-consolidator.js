// Re-run the feedback consolidator on a page with the SAME inputs the original
// story used (image data, eval results, entity report, character profiles).
// Now uses Sonnet (as switched in the source) plus the new brevity rule.
//
// Usage: node scripts/analysis/rerun-consolidator.js <storyId> <pageNum> [versionIndex]
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const storyId = process.argv[2];
  const pageNumber = parseInt(process.argv[3] || '12', 10);
  const versionIndex = parseInt(process.argv[4] || '0', 10);
  if (!storyId) { console.error('Usage: <storyId> <pageNum> [versionIndex]'); process.exit(1); }

  const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // 1. Pull image
  const imgR = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' AND version_index=$3`,
    [storyId, pageNumber, versionIndex]
  );
  if (!imgR.rows[0]) { console.error('image not found'); await pool.end(); process.exit(1); }
  const imageDataUri = imgR.rows[0].image_data;

  // 2. Pull scene + evaluation data
  const sceneR = await pool.query(
    `SELECT scene->>'sceneDescription' AS sd,
            scene->'fixableIssues' AS fi,
            scene->'semanticResult' AS sr,
            scene->'bboxDetection' AS bd,
            scene->'entityReport' AS er,
            data::jsonb->'characters' AS chars
     FROM stories, jsonb_array_elements(data::jsonb->'sceneImages') AS scene
     WHERE id=$1 AND (scene->>'pageNumber')::int=$2`,
    [storyId, pageNumber]
  );
  await pool.end();
  if (!sceneR.rows[0]) { console.error('scene not found'); process.exit(1); }
  const s = sceneR.rows[0];

  // Build characters array (just name + physical desc to keep payload small)
  const characters = (s.chars || []).map(c => ({
    name: c.name,
    physicalDescription: c.physical?.description || c.description || ''
  }));

  console.log(`Re-running consolidator on story=${storyId} P${pageNumber} v${versionIndex}`);
  console.log(`Image bytes: ${Math.round(imageDataUri.length / 1024)}KB`);
  console.log(`fixableIssues: ${s.fi?.length || 0}`);
  console.log(`semanticIssues: ${s.sr?.semanticIssues?.length || s.sr?.issues?.length || 0}`);
  console.log(`bboxFigures: ${s.bd?.figures?.length || 0}`);
  console.log(`characters: ${characters.length}`);
  console.log('');

  const { loadPromptTemplates } = require(path.resolve(__dirname, '..', '..', 'server', 'services', 'prompts'));
  await loadPromptTemplates();
  const { consolidateFeedback } = require(path.resolve(__dirname, '..', '..', 'server', 'lib', 'feedbackConsolidator'));

  const t = Date.now();
  const result = await consolidateFeedback({
    imageDataUri,
    sceneDescription: s.sd || '',
    evaluation: {
      fixableIssues: s.fi || [],
      semanticResult: s.sr || {},
      bboxDetection: s.bd || {}
    },
    entityReport: s.er || null,
    pageNumber,
    characters
  });
  const elapsed = Date.now() - t;

  console.log(`\n=== RESULT (${(elapsed/1000).toFixed(1)}s, tokens: ${result.usage?.input_tokens}/${result.usage?.output_tokens}) ===\n`);
  if (result.error) { console.log('ERROR:', result.error); process.exit(1); }
  console.log(JSON.stringify(result.plan, null, 2));
})().catch(e => { console.error(e.message); console.error(e.stack); process.exit(1); });
