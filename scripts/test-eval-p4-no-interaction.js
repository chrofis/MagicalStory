#!/usr/bin/env node
/**
 * Test whether removing the "hand on stall" entry from interactions[] stops
 * the evaluator from flagging it as CRITICAL. Uses CURRENT unpatched prompts
 * so we isolate the effect of the upstream change.
 *
 * Same P4 v0 image, but send a scene description with interactions: [].
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776601005131_7dxzq9184';
const PAGE = 4;
const OUT_DIR = path.join(ROOT, 'tests', 'eval-p4-no-interaction');
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const r = await pool.query(`
    SELECT scene->>'sceneDescription' as desc
    FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const origDesc = r.rows[0].desc;

  const imgRow = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  const v0ImageData = imgRow.rows[0].image_data;
  await pool.end();

  // Strip the Sophie+stall interaction from the metadata JSON.
  // Keep the prose unchanged — the only difference is the interactions[] array.
  const metaIdx = origDesc.indexOf('---METADATA---');
  const prose = origDesc.slice(0, metaIdx);
  const metaBlock = origDesc.slice(metaIdx);
  const jsonMatch = metaBlock.match(/\{[\s\S]*\}/);
  const metaObj = JSON.parse(jsonMatch[0]);

  console.log('── original interactions[] ──');
  console.log(JSON.stringify(metaObj.interactions, null, 2));

  // Test variant: empty interactions array
  const modifiedMeta = { ...metaObj, interactions: [] };
  const modifiedDesc = prose + '---METADATA---\n\n' + JSON.stringify(modifiedMeta);

  fs.writeFileSync(path.join(OUT_DIR, 'original_desc.txt'), origDesc);
  fs.writeFileSync(path.join(OUT_DIR, 'modified_desc.txt'), modifiedDesc);
  const b64 = v0ImageData.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, 'v0_input.jpg'), Buffer.from(b64, 'base64'));

  // Run the evaluator with the modified scene description
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { evaluateImageQuality } = require(path.join(ROOT, 'server/lib/images'));

  console.log('\n── running evaluator with interactions=[] ──');
  const result = await evaluateImageQuality(
    v0ImageData,
    modifiedDesc,
    [],
    'scene',
    null,
    `P${PAGE}-NOINTERACT`,
  );

  console.log(`\nquality: ${result.qualityScore}  semantic: ${result.semanticResult?.score}`);
  console.log(`verdict: ${result.verdict}`);
  console.log('fixableIssues:');
  (result.fixableIssues || []).forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0, 130)}`));
  if (result.issuesSummary) console.log(`\nissuesSummary: ${result.issuesSummary.slice(0, 400)}`);

  fs.writeFileSync(path.join(OUT_DIR, 'evaluation.json'), JSON.stringify({
    qualityScore: result.qualityScore,
    semanticScore: result.semanticResult?.score,
    verdict: result.verdict,
    issuesSummary: result.issuesSummary,
    fixableIssues: result.fixableIssues,
  }, null, 2));

  const handIssue = (result.fixableIssues || []).find(f =>
    /hand|finger|grip|touch|interact|stall.*press/i.test(`${f.description || ''} ${f.fix || ''} ${f.type || ''}`)
  );
  console.log(`\n→ hand/interaction issue: ${handIssue ? handIssue.severity : 'NONE'}  (was CRITICAL with interaction declared)`);

  process.exit(0);
})().catch(e => {
  console.error('ERR:', e.stack || e.message);
  process.exit(1);
});
