#!/usr/bin/env node
/**
 * Test two eval-pipeline fixes against a real story page:
 *  A) Eval prompt exemption for left/right mirror differences.
 *  B) Consolidator keeping CRITICAL/MAJOR issues in the plan (doesn't drop).
 *
 * Target: job_1776601005131_7dxzq9184 P1 v0 — Lukas with Eli under the WRONG arm
 * (declared left, drawn right). Current eval flags CRITICAL interaction_placement.
 * Expected with Fix A: NO CRITICAL on elephant arm (mirror-symmetric).
 * Expected with Fix B: even if CRITICAL fires, consolidator keeps it in plan.
 *
 * Runs read-only — doesn't modify committed prompts. Patches them in-memory,
 * restores after each run. Writes outputs to tests/eval-fix-test/.
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const STORY_ID = 'job_1776601005131_7dxzq9184';
const PAGE = 1;
const OUT_DIR = path.join(ROOT, 'tests', 'eval-fix-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

// Inline patches — replace the exact rule lines where they live, so the
// exemption sits next to the rule it modifies instead of buried at the end.
const SEMANTIC_PATCHES = [
  {
    find: `If a declared interaction is missing or in the wrong place, flag it as a \`wrong_interaction\` issue. This overrides the "ignore spatial arrangement" rule below — declared interactions are spatial requirements that DO matter.`,
    replace: `If a declared interaction is missing or in the wrong place, flag it as a \`wrong_interaction\` issue. Left/right mirror differences (left arm vs right arm, left hand vs right hand, left pocket vs right pocket, left shoulder vs right shoulder) are EQUIVALENT — do NOT flag a wrong_interaction for a mirror-symmetric difference. Only flag when the interaction category itself is different (held vs worn vs in-pocket vs climbing vs standing-on) or the object is at a substantively different location (e.g. "on head" drawn "in hand"). This overrides the "ignore spatial arrangement" rule below — declared interactions are spatial requirements that DO matter.`,
  },
  {
    find: `- Declared interaction missing or at completely wrong location (e.g. object in pocket drawn as large held plush): -3`,
    replace: `- Declared interaction missing or at completely wrong location (e.g. object in pocket drawn as large held plush): -3. Left/right mirror differences (left arm vs right arm, etc.) are equivalent and do NOT deduct.`,
  },
];

const COMPLIANCE_PATCHES = [
  {
    find: `- Is it at the correct location relative to the character (in hand, on head, under arm)?
- Missing or wrong placement = CRITICAL`,
    replace: `- Is it at the correct location relative to the character (in hand, on head, under arm)?
- Missing or wrong placement = CRITICAL. Left/right mirror differences (left arm vs right arm, left hand vs right hand, left pocket vs right pocket) are EQUIVALENT — do NOT flag these as wrong placement.`,
  },
  {
    find: `- CRITICAL (-3): Missing character, clothing completely wrong TYPE (modern vs medieval/costume), declared interaction object missing or wrong location, extra limbs, floating figure`,
    replace: `- CRITICAL (-3): Missing character, clothing completely wrong TYPE (modern vs medieval/costume), declared interaction object missing or in a genuinely wrong location (held-vs-pocket, on-head-vs-in-hand — NOT left arm vs right arm), extra limbs, floating figure`,
  },
];

const EVAL_PATCHES = [
  {
    find: `- Any interaction where the object is in the wrong place or missing = CRITICAL, set \`physics_ok: false\`, and add a \`fixable_issues\` entry with \`type: physics\` describing the mismatch (e.g., "Eli is drawn as a large plush held in Lukas's hand, but should be a tiny silhouette in his jacket pocket").`,
    replace: `- Any interaction where the object is in the wrong place or missing = CRITICAL, set \`physics_ok: false\`, and add a \`fixable_issues\` entry with \`type: physics\` describing the mismatch (e.g., "Eli is drawn as a large plush held in Lukas's hand, but should be a tiny silhouette in his jacket pocket"). Left/right mirror differences (left arm vs right arm, left hand vs right hand, left pocket vs right pocket) are EQUIVALENT and do NOT count as wrong place.`,
  },
  {
    find: `- CRITICAL (-3): Missing/wrong character, duplicate character, extra limbs (3 arms/hands), figure floating in air, declared interaction object missing OR in completely wrong location (e.g. declared "in pocket" but drawn floating beside the character)`,
    replace: `- CRITICAL (-3): Missing/wrong character, duplicate character, extra limbs (3 arms/hands), figure floating in air, declared interaction object missing OR in completely wrong location (e.g. declared "in pocket" but drawn floating beside the character). Mirror differences (left vs right arm/hand/pocket) are equivalent and do NOT trigger CRITICAL.`,
  },
];

function applyPatches(filePath, patches) {
  const orig = fs.readFileSync(filePath, 'utf8');
  let patched = orig;
  for (const p of patches) {
    if (!patched.includes(p.find)) {
      console.warn(`⚠ patch target not found in ${path.basename(filePath)}: "${p.find.slice(0, 60)}..."`);
      continue;
    }
    patched = patched.replace(p.find, p.replace);
  }
  fs.writeFileSync(filePath, patched);
  return () => fs.writeFileSync(filePath, orig);
}

async function loadTemplates() {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  return PROMPT_TEMPLATES;
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────
(async () => {
  // 1. Pull scene description + v0 image
  console.log(`Pulling ${STORY_ID} P${PAGE} v0...`);
  const pool = new Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const sceneRow = await pool.query(`
    SELECT scene->>'sceneDescription' as desc, scene->'fixableIssues' as orig_issues,
           scene->'imageVersions' as versions, scene->'semanticResult' as semres
    FROM stories, jsonb_array_elements(data->'sceneImages') scene
    WHERE stories.id=$1 AND (scene->>'pageNumber')::int=$2
  `, [STORY_ID, PAGE]);
  const sceneDescription = sceneRow.rows[0].desc;
  const origIssues = sceneRow.rows[0].orig_issues || [];
  const versions = sceneRow.rows[0].versions || [];

  const imgRow = await pool.query(
    `SELECT image_data FROM story_images WHERE story_id=$1 AND image_type='scene' AND page_number=$2 AND version_index=0`,
    [STORY_ID, PAGE]
  );
  const v0ImageData = imgRow.rows[0].image_data;
  await pool.end();

  fs.writeFileSync(path.join(OUT_DIR, 'scene_description.txt'), sceneDescription);
  const b64 = v0ImageData.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(OUT_DIR, 'v0_input.jpg'), Buffer.from(b64, 'base64'));
  console.log(`saved scene_description.txt, v0_input.jpg`);

  // V0 as stored — we use this as the "truth" baseline for comparison
  const v0Stored = versions.find(v => v.type === 'original');
  const v0FixableIssues = v0Stored?.fixableIssues || origIssues;
  const v0SemanticIssues = v0Stored?.semanticResult?.issues || [];
  fs.writeFileSync(path.join(OUT_DIR, 'v0_stored_evaluation.json'), JSON.stringify({
    qualityScore: v0Stored?.qualityScore,
    semanticScore: v0Stored?.semanticScore || v0Stored?.semanticResult?.score,
    issuesSummary: v0Stored?.issuesSummary,
    fixableIssues: v0FixableIssues,
    semanticIssues: v0SemanticIssues,
  }, null, 2));

  // ─────────── Fix A: eval prompts with mirror exemption ───────────
  console.log('\n════ FIX A: re-evaluate with mirror exemption ════');
  const semPath = path.join(ROOT, 'prompts/image-semantic.txt');
  const evalPath = path.join(ROOT, 'prompts/image-evaluation.txt');
  const complPath = path.join(ROOT, 'prompts/image-prompt-compliance.txt');
  const restoreSem = applyPatches(semPath, SEMANTIC_PATCHES);
  const restoreEval = applyPatches(evalPath, EVAL_PATCHES);
  const restoreCompl = applyPatches(complPath, COMPLIANCE_PATCHES);

  try {
    // Force templates to reload from the patched files
    delete require.cache[require.resolve(path.join(ROOT, 'server/services/prompts'))];
    const templates = await loadTemplates();
    // Sanity: prompt now contains our exemption
    console.log('patched image-semantic.txt:', templates.imageSemantic?.includes('Left/right mirror') ? 'YES' : 'NO');
    console.log('patched image-evaluation.txt:', templates.imageEvaluation?.includes('Left/right mirror') ? 'YES' : 'NO');

    const { evaluateImageQuality } = require(path.join(ROOT, 'server/lib/images'));
    console.log('\nRe-running evaluation with patched prompts...');
    const result = await evaluateImageQuality(
      v0ImageData,
      sceneDescription,
      [],      // referenceImages
      'scene', // evaluationType
      null,    // qualityModelOverride
      `P${PAGE}-TEST`,
    );
    fs.writeFileSync(path.join(OUT_DIR, 'fix_a_evaluation.json'), JSON.stringify({
      qualityScore: result.qualityScore,
      semanticScore: result.semanticResult?.score,
      issuesSummary: result.issuesSummary,
      fixableIssues: result.fixableIssues,
      semanticIssues: result.semanticResult?.issues,
    }, null, 2));

    console.log('\n── v0 STORED (baseline) ──');
    console.log(`quality: ${v0Stored?.qualityScore}  semantic: ${v0Stored?.semanticResult?.score}`);
    (v0FixableIssues || []).forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0,120)}`));
    console.log('\n── FIX A (mirror exemption) ──');
    console.log(`quality: ${result.qualityScore}  semantic: ${result.semanticResult?.score}`);
    (result.fixableIssues || []).forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0,120)}`));

    // Check: is there still a CRITICAL elephant/arm issue?
    const armIssue = (result.fixableIssues || []).find(f =>
      /elephant|eli|arm|hand/i.test(`${f.description || ''} ${f.fix || ''} ${f.type || ''}`)
    );
    console.log(`\n→ elephant/arm issue in new eval: ${armIssue ? armIssue.severity : 'NONE'}`);
  } finally {
    restoreSem();
    restoreEval();
    restoreCompl();
    console.log('\n(prompts restored)');
  }

  // ─────────── Fix B: test the consolidator with the original issues ───────────
  console.log('\n════ FIX B: consolidator with v0 original issues ════');
  delete require.cache[require.resolve(path.join(ROOT, 'server/services/prompts'))];
  await loadTemplates();
  const { consolidateFeedback } = require(path.join(ROOT, 'server/lib/feedbackConsolidator'));

  const consolidationInput = {
    imageDataUri: v0ImageData,
    sceneDescription,
    evaluation: {
      qualityScore: v0Stored?.qualityScore,
      fixableIssues: v0FixableIssues,
      semanticResult: v0Stored?.semanticResult || { issues: v0SemanticIssues },
    },
    pageNumber: PAGE,
    characters: [],
  };

  console.log('\ninput issues:');
  v0FixableIssues.forEach(f => console.log(`  [${f.severity}/${f.type}] ${(f.description || f.fix || '').slice(0, 100)}`));

  const consolResult = await consolidateFeedback(consolidationInput);
  fs.writeFileSync(path.join(OUT_DIR, 'fix_b_consolidator.json'), JSON.stringify(consolResult, null, 2));

  if (consolResult.plan) {
    console.log('\n── plan ──');
    console.log(`scene_fix: ${consolResult.plan.scene_fix?.severity || 'NONE'} ${consolResult.plan.scene_fix?.instruction ? '— ' + consolResult.plan.scene_fix.instruction.slice(0,120) : ''}`);
    (consolResult.plan.per_character_fixes || []).forEach(pcf => {
      console.log(`per_char ${pcf.character_name || '?'}: ${pcf.severity} — ${(pcf.instruction || '').slice(0,120)}`);
    });
    const dropped = consolResult.plan.dropped_issues || [];
    console.log(`\ndropped: ${dropped.length}`);
    dropped.forEach(d => console.log(`  — ${(d.issue || d.description || '').slice(0, 120)}  reason=${d.reason || ''}`));

    // Did the consolidator drop any CRITICAL?
    const droppedCriticals = dropped.filter(d => {
      const text = (d.issue || d.description || '').toLowerCase();
      return v0FixableIssues.some(f => (f.severity === 'CRITICAL' || f.severity === 'MAJOR') &&
        text.includes((f.description || '').toLowerCase().slice(0, 20)));
    });
    console.log(`\n→ CRITICAL/MAJOR dropped: ${droppedCriticals.length}`);
  } else {
    console.log('consolidator error:', consolResult.error);
  }

  console.log(`\nAll outputs in: ${OUT_DIR}`);
  process.exit(0);
})().catch(e => {
  console.error('ERR:', e.stack || e.message);
  process.exit(1);
});
