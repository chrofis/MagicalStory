/**
 * Replay round 1 of the repair loop from STORED data: build roundEvalPages from
 * each page's ORIGINAL version (version index 0) and run findBadPages +
 * applyRoundCap exactly as repairPipeline does.
 */
require('dotenv').config();
const { Pool } = require('pg');
const { findBadPages, applyRoundCap, collectCriticalFindings } = require('../../server/lib/repairLogic');
const { computeFinalScore } = require('../../server/lib/scoring');

const jobId = process.argv[2] || 'job_1789759147125_p08djwhbl';

(async () => {
  const pool = new Pool({
    connectionString: process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const { rows } = await pool.query('SELECT id, data FROM stories WHERE id = $1', [jobId]);
  const data = rows[0].data;
  const evalPages = {};
  for (const si of data.sceneImages || []) {
    const v0 = (si.imageVersions || [])[0] || si;
    const ev = {
      ...(v0.evaluation || {}),
      scoreBreakdown: v0.scoreBreakdown || v0.evaluation?.scoreBreakdown || null,
      consolidatedPlan: v0.consolidatedPlan || v0.evaluation?.consolidatedPlan || null,
      entityPenalty: v0.entityPenalty || 0,
      evaluated: true,
      finalScore: v0.finalScore,
    };
    evalPages[si.pageNumber] = ev;
    const crits = collectCriticalFindings(ev);
    console.log(`p${si.pageNumber}`.padEnd(5), 'v0 finalScore=', String(v0.finalScore).padEnd(5),
      'recomputed=', String(computeFinalScore(ev)).padEnd(5), 'crit=', crits.length,
      'versions=', (si.imageVersions || []).length);
  }
  const bad = findBadPages(evalPages, { scoreThreshold: 60 });
  console.log('\nround-1 findBadPages:', bad.join(', '));
  const crit = Object.keys(evalPages).map(n => parseInt(n, 10))
    .filter(n => require('../../server/lib/repairLogic').hasCriticalSeverityFinding(evalPages[n]));
  const capped = applyRoundCap(bad, {
    round: 1, totalPages: Object.keys(evalPages).length,
    lastRound: true, criticalPageNums: crit,
  });
  console.log('cap', capped.cap);
  console.log('admitted:', capped.admitted.join(', '));
  console.log('deferred:', capped.deferred.join(', '));
  const repaired = (data.sceneImages || []).filter(s => (s.imageVersions || []).length > 1).map(s => s.pageNumber);
  console.log('actually got a 2nd version:', repaired.join(', '));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
