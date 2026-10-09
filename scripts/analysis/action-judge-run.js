// Re-runs the REAL page eval (Lab quality_eval stage = production evaluateImageBatch) over a labelled
// page set and records every finding per run. Local, read-only against staging DB; paid judge calls.
// Usage: node scripts/analysis/action-judge-run.js <labels.json> <outFile.json> [--runs=2] [--only=id,id] [--conc=3]
// Keys come from .env (never printed). Output: {runs:[{id, run, findings:[{type,severity,description,sources}], cost, ms}]}
'use strict';
require('dotenv').config();
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL; // the stored story lives on staging
require('../../server/services/database').initializePool(); // pool only, no initializeDatabase (that runs DDL)
const fs = require('fs');
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const [, , labelsFile, outFile] = process.argv;
const RUNS = Number(arg('runs', 2));
const CONC = Number(arg('conc', 3));
const only = arg('only', null);

(async () => {
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
  let pages = labels.pages;
  if (only) pages = pages.filter(p => only.split(',').includes(p.id));
  const { runQualityEvalStage } = require('../../server/lib/testlab');
  // Same context loader the Lab uses
  const tl = require('../../server/lib/testlab');
  const { runStageOnTarget } = tl;
  const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: [] };
  const have = new Set(done.runs.map(r => `${r.id}#${r.run}`));
  const jobs = [];
  for (let run = 1; run <= RUNS; run++) for (const p of pages) if (!have.has(`${p.id}#${run}`)) jobs.push({ p, run });
  console.log(`${jobs.length} evals to run (${pages.length} pages x ${RUNS})`);
  let next = 0;
  const save = () => fs.writeFileSync(outFile, JSON.stringify(done));
  async function worker() {
    while (next < jobs.length) {
      const { p, run } = jobs[next++];
      const t0 = Date.now();
      try {
        const res = await runStageOnTarget('quality_eval', { storyId: p.story, pageNumber: p.pn, versionIndex: p.vi }, { experimentId: 0, params: {} });
        done.runs.push({
          id: p.id, run, ms: Date.now() - t0, score: res.scores, usage: res.totalUsage || null, modelId: res.modelId,
          findings: (res.fixableIssues || []).map(f => ({ type: f.type, severity: f.severity, description: String(f.description || '').slice(0, 300), sources: f.sources || f.source || null, name: f.name || null })),
        });
      } catch (e) {
        done.runs.push({ id: p.id, run, error: String(e.message).slice(0, 300) });
      }
      save();
      process.stdout.write('.');
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log('\nsaved', outFile);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
