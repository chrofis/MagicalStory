'use strict';
// Does the post-audit text round (runPostAuditTextRound, the real step the pipeline calls with the book audit's
// TEXT faults) apply D3's TEXT fixes, or close them as "not owed"? Stored book + the D3 TEXT lines from exps 1844/1845.
// Paid: one text-refine call per book (~USD 0.15). Writes nothing to the DB. Usage: node replay.js
require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const R = p => require(path.resolve(__dirname, '../../..', p));
const { runPostAuditTextRound, extractRefinablePages } = R('server/lib/textRefine');
const CASES = { job_1793959308869_fre2mb4d0: 1845, job_1793964466256_1tmyzh1do: 1844 };
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let total = 0;
  for (const [id, exp] of Object.entries(CASES)) {
    const d = (await pool.query('SELECT data FROM stories WHERE id=$1', [id])).rows[0].data; if (d.textForm == null && id === 'job_1793964466256_1tmyzh1do') d.textForm = 'prose'; // in memory only: the staging backfill is not run yet
    const e = require(path.resolve(__dirname, `../2026-11-08_quality-tests-I/real/exp${exp}.json`));
    const rr = (e.results || e.experiment.results)[0]; const raw = String((rr.output || rr.result || rr).raw);
    const faults = raw.split('\n').filter(l => /^FAULT\[TEXT/.test(l)).map(line => ({ line }));
    const pages = extractRefinablePages(d.sceneImages || [], { visualBible: d.visualBible, clothingRequirements: d.clothingRequirements });
    const ar = d.arcReviewReport || {};
    const r = await runPostAuditTextRound({ ...d, visualBible: d.visualBible }, pages, faults,
      { arc: ar.finalArc || d.beatsReviewReport?.arc || '', arcHints: ar.arcHints || '', storyLogic: ar.logic || '', usageLabel: 'replay_post_audit' });
    const en = r?.entry || {};
    total += en.cost || 0;
    const out = { id, faults: faults.map(f => f.line), ok: en.ok, error: en.error, changedPages: en.changedPages, outcomes: en.findingOutcomes,
      before: Object.fromEntries(pages.filter(p => (en.changedPages || []).includes(p.pageNumber)).map(p => [p.pageNumber, p.text])),
      after: Object.fromEntries((r?.pages || []).filter(p => (en.changedPages || []).includes(p.pageNumber)).map(p => [p.pageNumber, p.text])),
      retest: en.retest, majorChangePages: en.majorChangePages, analysis: en.rawResponse ? String(en.rawResponse).slice(0, 4000) : null, cost: en.cost, usage: en.usage };
    fs.writeFileSync(path.join(__dirname, 'v3-' + id + '.json'), JSON.stringify(out, null, 1));
    console.log(id, 'ok', en.ok, 'changed', en.changedPages, 'cost', en.cost, 'keys', Object.keys(en).join(','));
  }
  console.log('total cost', total); await pool.end(); process.exit(0);
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
