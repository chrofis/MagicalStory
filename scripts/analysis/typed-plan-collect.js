#!/usr/bin/env node
/**
 * Collect the stored shipped page plans of the staging stories into the fixed
 * input of the typed-plan Jev calibration (evals/datasets/typed-plan-jev-v1.json).
 * Read-only; one SQL pull of the JSON paths the calibration needs, never the
 * whole story row (no images). Usage:
 *   node scripts/analysis/typed-plan-collect.js [--out=evals/datasets/typed-plan-jev-v1.json]
 *
 * A story qualifies when it stores a shipped page plan (beatsReviewReport.pagePlan)
 * with a head count (luna's roster, counterStats.castPerPage) and an arc.
 * `commissioned` = the story's character names, `arcNames` = the (new) figures
 * of its STORY LOGIC; both read by the same functions the Lab stage uses.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { parsePlanResponse, parseStoryLogic } = require('../../server/lib/promptBuilders');

const outArg = process.argv.find(a => a.startsWith('--out='));
const OUT = path.resolve(outArg ? outArg.slice(6) : 'evals/datasets/typed-plan-jev-v1.json');

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT id,
             data->'beatsReviewReport'->>'pagePlan' AS plan,
             COALESCE(data->'beatsReviewReport'->'recheck'->'counterStats'->'castPerPage', data->'beatsReviewReport'->'counterStats'->'castPerPage') AS per_page,
             COALESCE(data->'arcReviewReport'->>'finalArc', data->'beatsReviewReport'->>'arc') AS arc,
             data->'arcReviewReport'->>'logic' AS logic,
             data->>'pages' AS pages,
             data->'beatsReviewReport'->'recheck'->'lines' AS recheck_lines,
             data->'beatsReviewReport'->'modelFindings' AS first_findings,
             (SELECT jsonb_agg(c->>'name') FROM jsonb_array_elements(COALESCE(data->'characters', '[]'::jsonb)) c) AS chars
        FROM stories
       WHERE data->'beatsReviewReport'->>'pagePlan' IS NOT NULL`);
    const out = [];
    for (const r of rows) {
      const pageCount = parseInt(r.pages, 10);
      if (!r.plan || !r.per_page || !r.arc || !pageCount) continue;
      const parsed = parsePlanResponse(r.plan, Array.from({ length: pageCount }, (_, i) => i + 1));
      if (parsed.missing.length) continue;
      let arcNames = [];
      if (r.logic) { try { arcNames = parseStoryLogic(`STORY LOGIC:\n${r.logic}`).invented; } catch { arcNames = []; } }
      // The plan check's findings on the SHIPPED division: the recheck's lines when a re-plan shipped,
      // else the first check's findings. [{page, check}] — the weak labels of the calibration.
      const luna = [];
      if (Array.isArray(r.recheck_lines)) {
        for (const l of r.recheck_lines) { const m = String(l).match(/^CHECK\[(\d+)\]:\s*Page (\d+)/i); if (m) luna.push({ page: Number(m[2]), check: Number(m[1]) }); }
      } else if (Array.isArray(r.first_findings)) {
        for (const f of r.first_findings) { const m = String(f.text || '').match(/Page (\d+)/i); if (m && f.check) luna.push({ page: Number(m[1]), check: Number(f.check) }); }
      }
      out.push({
        storyId: r.id,
        arc: r.arc,
        commissioned: (r.chars || []).filter(Boolean),
        arcNames,
        pages: parsed.pages.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine })),
        lunaFindings: luna,
        luna: r.per_page.map(x => ({ pageNumber: Number(x.pageNumber), names: x.names || [] })),
      });
    }
    fs.writeFileSync(OUT, `${JSON.stringify({ version: 'typed-plan-jev-v1', collectedFrom: 'staging stories.data.beatsReviewReport', plans: out }, null, 1)}\n`);
    console.log(`${out.length} of ${rows.length} stored plans with a head count and an arc -> ${OUT}`);
  } finally { await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
