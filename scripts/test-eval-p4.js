#!/usr/bin/env node
/**
 * Test the evaluator severity changes on P4 v0 of job_1776601005131_7dxzq9184.
 *
 * Baseline (stored):
 *   - CRITICAL/interaction_missing: hands not visible → -3
 *   - MAJOR/composition: extra vendor figures in market → -2
 *   - total score: 40
 *
 * New patches:
 *   - Declared interaction mismatch only CRITICAL when FOCAL to the story beat.
 *     Supporting interactions (hand on prop, foot on step) = MODERATE (-1).
 *   - Extra background figures in scenes with populated-background description
 *     (crowd, vendors, villagers) do NOT deduct — they're scene-appropriate.
 *
 * Expected with patches: hand flag moves to MODERATE (-1), vendor flag drops
 * entirely. Score should move from ~40 to ~70-80.
 *
 * Not committed. Patches applied in-memory, restored after.
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776601005131_7dxzq9184';
const PAGE = 4;
const OUT_DIR = path.join(ROOT, 'tests', 'eval-p4-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────────────
// Patches
// ──────────────────────────────────────────────────────────────────────

const EVAL_PATCHES = [
  {
    find: `- CRITICAL (-3): Missing/wrong character, duplicate character, extra limbs (3 arms/hands), figure floating in air, declared interaction object missing OR in completely wrong location (e.g. declared "in pocket" but drawn floating beside the character)`,
    replace: `- CRITICAL (-3): Missing/wrong character, duplicate character, extra limbs (3 arms/hands), figure floating in air, figure merged with objects. Declared-interaction mismatches are CRITICAL ONLY when the interaction is in the DECLARED INTERACTIONS block above. Pose details from the scene prose that are NOT in the DECLARED INTERACTIONS block (e.g. 'hands drawn in tight', 'chin tucked', 'jaw set', 'fingers curled') are descriptive context only and do NOT trigger any deduction. Mirror differences (left vs right arm/hand/pocket) are equivalent and do NOT deduct. Extra background figures in scenes whose scene hint describes a populated setting (crowd, vendors, villagers, marketgoers, passersby) are scene-appropriate and do NOT deduct`,
  },
];

const COMPLIANCE_PATCHES = [
  {
    find: `- CRITICAL (-3): Missing character, clothing completely wrong TYPE (modern vs medieval/costume), declared interaction object missing or wrong location, extra limbs, floating figure`,
    replace: `- CRITICAL (-3): Missing character, clothing completely wrong TYPE (modern vs medieval/costume), extra limbs, floating figure, figure merged into objects. Declared-interaction mismatches are CRITICAL ONLY when the interaction is in the DECLARED INTERACTIONS block. Pose details from the scene prose that are NOT in DECLARED INTERACTIONS (e.g. 'hands drawn in tight', 'fingers curled', 'chin tucked') are descriptive only — do NOT deduct. Mirror differences (left vs right arm/hand/pocket) do NOT trigger CRITICAL. Extra background figures in scenes whose background describes a populated setting (crowd, vendors, villagers, marketgoers, passersby) are scene-appropriate and do NOT deduct`,
  },
];

const SEMANTIC_PATCHES = [
  {
    find: `- Declared interaction missing or at completely wrong location (e.g. object in pocket drawn as large held plush): -3`,
    replace: `- Declared interaction (from DECLARED INTERACTIONS block ONLY) missing or at a genuinely different location (object in pocket drawn as large held plush, on-head drawn in-hand): -3. Pose details that appear in the scene prose but NOT in DECLARED INTERACTIONS (e.g. 'hands drawn in tight', 'fingers curled') are descriptive only — do NOT deduct. Left/right mirror differences (left arm vs right arm, etc.) are equivalent and do NOT deduct. Extra background figures in scenes with populated-background descriptions (crowd, vendors) do NOT deduct`,
  },
];

function applyPatches(filePath, patches) {
  const orig = fs.readFileSync(filePath, 'utf8');
  let patched = orig;
  let hits = 0;
  for (const p of patches) {
    if (!patched.includes(p.find)) {
      console.warn(`⚠ patch target not found in ${path.basename(filePath)}`);
      continue;
    }
    patched = patched.replace(p.find, p.replace);
    hits++;
  }
  fs.writeFileSync(filePath, patched);
  console.log(`  patched ${path.basename(filePath)}: ${hits}/${patches.length} patches applied`);
  return () => fs.writeFileSync(filePath, orig);
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Pulling ${STORY_ID} P${PAGE} v0...`);
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const sceneRow = await pool.query(`
    SELECT scene->>'sceneDescription' as desc, scene->'imageVersions'->0 as v0
    FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const sceneDescription = sceneRow.rows[0].desc;
  const v0Stored = sceneRow.rows[0].v0;

  const imgRow = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  const v0ImageData = imgRow.rows[0].image_data;
  await pool.end();

  fs.writeFileSync(path.join(OUT_DIR, 'scene_description.txt'), sceneDescription);
  const b64 = v0ImageData.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, 'v0_input.jpg'), Buffer.from(b64, 'base64'));

  console.log(`\n── BASELINE (stored v0) ──`);
  console.log(`quality: ${v0Stored.qualityScore}  semantic: ${v0Stored.semanticResult?.score}`);
  console.log('fixableIssues:');
  (v0Stored.fixableIssues || []).forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0, 130)}`));

  // Apply patches and re-evaluate
  console.log('\n── applying patches ──');
  const evalPath = path.join(ROOT, 'prompts/image-evaluation.txt');
  const complPath = path.join(ROOT, 'prompts/image-prompt-compliance.txt');
  const semPath = path.join(ROOT, 'prompts/image-semantic.txt');
  const restoreEval = applyPatches(evalPath, EVAL_PATCHES);
  const restoreCompl = applyPatches(complPath, COMPLIANCE_PATCHES);
  const restoreSem = applyPatches(semPath, SEMANTIC_PATCHES);

  try {
    delete require.cache[require.resolve(path.join(ROOT, 'server/services/prompts'))];
    const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
    await loadPromptTemplates();
    const { evaluateImageQuality } = require(path.join(ROOT, 'server/lib/images'));

    console.log('\n── running evaluation with patches ──');
    const result = await evaluateImageQuality(
      v0ImageData,
      sceneDescription,
      [],
      'scene',
      null,
      `P${PAGE}-TEST`,
    );

    console.log(`\n── PATCHED eval ──`);
    console.log(`quality: ${result.qualityScore}  semantic: ${result.semanticResult?.score}`);
    console.log(`verdict: ${result.verdict}`);
    console.log('fixableIssues:');
    (result.fixableIssues || []).forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0, 130)}`));
    if (result.issuesSummary) console.log(`\nissuesSummary: ${result.issuesSummary.slice(0, 300)}`);

    fs.writeFileSync(path.join(OUT_DIR, 'patched_evaluation.json'), JSON.stringify({
      qualityScore: result.qualityScore,
      semanticScore: result.semanticResult?.score,
      verdict: result.verdict,
      issuesSummary: result.issuesSummary,
      fixableIssues: result.fixableIssues,
    }, null, 2));

    // Check whether the hand issue got demoted and whether vendor flag disappeared
    const handIssue = (result.fixableIssues || []).find(f =>
      /hand|finger|grip|touch|interact/i.test(`${f.description || ''} ${f.fix || ''} ${f.type || ''}`)
    );
    const extraIssue = (result.fixableIssues || []).find(f =>
      /vendor|extra.*figure|extra.*character|background.*figure|crowd/i.test(`${f.description || ''} ${f.fix || ''}`)
    );
    console.log(`\n→ hand/interaction issue: ${handIssue ? handIssue.severity : 'NONE'}  (was CRITICAL in stored)`);
    console.log(`→ extra-vendor issue: ${extraIssue ? extraIssue.severity : 'NONE'}  (was MAJOR in stored)`);
  } finally {
    restoreEval();
    restoreCompl();
    restoreSem();
    console.log('\n(prompts restored)');
  }
  process.exit(0);
})().catch(e => {
  console.error('ERR:', e.stack || e.message);
  process.exit(1);
});
