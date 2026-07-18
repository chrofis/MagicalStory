#!/usr/bin/env node
/**
 * Local repro loop for the consolidator spec-conflict check: runs
 * consolidateFeedback directly against the stored boat-page eval and prints
 * spec_conflicts + the raw model text — iterate template wording without
 * staging deploys.
 *
 * Usage: node scripts/analysis/test-spec-conflict-local.js [runs]
 */
'use strict';
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const runs = parseInt(process.argv[2] || '1', 10);
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT data FROM stories WHERE id=$1', ['job_1784317200231_iup4y520e']);
  await pool.end();
  let d = r.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  const s = (d.sceneImages || [])[2]; // page 3

  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { consolidateFeedback } = require('../../server/lib/feedbackConsolidator');

  const evalResult = {
    fixableIssues: s.fixableIssues || [],
    semanticResult: s.semanticResult || null,
    threeStageResult: s.threeStageResult || null,
    bboxDetection: s.bboxDetection || null,
    issuesSummary: s.issuesSummary || null,
  };

  for (let i = 0; i < runs; i++) {
    const { plan, error } = await consolidateFeedback({
      sceneDescription: s.sceneDescription || '',
      evaluation: evalResult,
      entityIssues: [],
      pageNumber: 3,
      characters: d.characters || [],
      storyId: 'local-test',
      round: 0,
    });
    if (error) { console.log(`run ${i + 1}: ERROR ${error}`); continue; }
    console.log(`run ${i + 1}: spec_conflicts=${JSON.stringify(plan?.spec_conflicts ?? '(field missing)')}`);
    console.log(`   scene_fix: ${JSON.stringify(plan?.scene_fix?.instruction || null)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
