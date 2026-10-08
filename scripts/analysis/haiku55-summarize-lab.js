#!/usr/bin/env node
/**
 * Summarise Haiku 5.5 bake-off Lab experiments from the staging DB
 * (docs/decisions.md 2026-10-08). The raw rows stay in testlab_experiments; this
 * prints the numbers that go to evals/results/results.jsonl and writes the raw
 * result JSON to evals/runs/2026-10-08_haiku55/lab/<id>.json.
 *
 *   node scripts/analysis/haiku55-summarize-lab.js <planner|audit|panel> <experimentId>...
 */
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const kind = process.argv[2];
const ids = process.argv.slice(3).map(Number);
const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

// A plan-check line back into the finding shape the convergence count reads.
const asFinding = (line) => {
  const s = String(line);
  let m = s.match(/^PLAN\[([A-Z_0-9]+)\]/);
  if (m) return { code: m[1], line: s };
  m = s.match(/^CHECK\[(\d+)\]/);
  if (m) return { check: Number(m[1]), line: s };
  return { line: s };
};

(async () => {
  const { convergenceMustFixCount } = require('../../server/lib/promptBuilders');
  const outDir = path.resolve(__dirname, '..', '..', 'evals', 'runs', '2026-10-08_haiku55', 'lab');
  fs.mkdirSync(outDir, { recursive: true });
  for (const id of ids) {
    const row = (await pool.query('select label, params, status, results from testlab_experiments where id=$1', [id])).rows[0];
    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(row, null, 1));
    console.log(`#${id} ${row.status} ${row.label} ${JSON.stringify(row.params)}`);
    for (const r of row.results || []) {
      if (kind === 'planner') {
        const findings = (r.findings || []).map(asFinding);
        console.log(`  ${r.storyId}: planModel=${r.models?.planModel} planModelId=${r.firstPlan?.modelId} checkModelId=${r.models?.checkModelId} must-fix=${convergenceMustFixCount({ findings })} findings=${findings.length} planMs=${r.firstPlan?.elapsedMs} cost=${(r.cost || 0).toFixed(4)} usage=${JSON.stringify(r.usage)}`);
      } else if (kind === 'audit') {
        for (const run of r.runs || []) {
          console.log(`  ${r.storyId}: ${run.model}/${run.modelId} ok=${run.ok} faults=${run.faults} ${JSON.stringify(run.byCategory)} ms=${run.elapsedMs} out=${run.usage?.output_tokens} $${(run.cost || 0).toFixed(4)} ${run.error || ''}`);
        }
      } else if (kind === 'panel') {
        for (const run of r.runs || []) {
          console.log(`  ${r.storyId}: ${run.model}/${run.modelId} ok=${run.ok} kept=${run.keptFindings} dropped=${run.droppedFindings} malformed=${run.malformedFindings} ms=${run.elapsedMs} out=${run.usage?.output_tokens} $${(run.cost || 0).toFixed(4)} ${run.error || ''}`);
        }
      }
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
