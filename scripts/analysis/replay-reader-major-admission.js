/**
 * Free replay (owner 2026-10-15): over the last N prod stories, which SHIPPED page
 * versions carry a MAJOR-or-worse reader finding, would the OLD findBadPages have
 * admitted them, does the NEW one, and which route does decideRepairMethod pick?
 * Read-only. Usage: node scripts/analysis/replay-reader-major-admission.js [N=40]
 */
require('dotenv').config();
const { Pool } = require('pg');
const rl = require('../../server/lib/repairLogic');
const N = parseInt(process.argv[2] || '40', 10);
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = (await pool.query(`SELECT id FROM stories WHERE data->'sceneImages' IS NOT NULL AND jsonb_typeof(data->'sceneImages')='array' AND jsonb_array_length(data->'sceneImages')>3 ORDER BY created_at DESC LIMIT $1`, [N])).rows.map(r => r.id);
  let pages = 0, withReader = 0, newlyAdmitted = 0, storiesHit = new Set();
  const routes = {}; const rows = [];
  for (const id of ids) {
    const data = (await pool.query('SELECT data FROM stories WHERE id=$1', [id])).rows[0].data;
    for (const si of data.sceneImages || []) {
      pages++;
      const vers = si.imageVersions || [];
      const v = vers.length ? require('../../server/lib/repairPipeline').selectBestVersion(vers) : si;
      const ev = { ...(v.evaluation || {}), consolidatedPlan: v.consolidatedPlan || v.evaluation?.consolidatedPlan || null,
        scoreBreakdown: v.scoreBreakdown || v.evaluation?.scoreBreakdown || null, entityPenalty: v.entityPenalty || 0,
        evaluated: true, finalScore: v.finalScore };
      const rf = rl.findReaderMajorFinding(ev);
      if (!rf) continue;
      withReader++;
      const before = rl.findBadPages({ 1: ev }, { }).length === 1 && !(rl.findReaderMajorFinding && false);
      // OLD behaviour = new gate minus reader rescue: emulate by stripping reader-only findings.
      const stripped = JSON.parse(JSON.stringify(ev));
      if (stripped.consolidatedPlan?.deduped_issues) stripped.consolidatedPlan.deduped_issues = stripped.consolidatedPlan.deduped_issues.filter(i => !(i.sources || []).includes('reader'));
      const oldAdmit = rl.findBadPages({ 1: stripped }).length === 1;
      const newAdmit = rl.findBadPages({ 1: ev }).length === 1;
      if (newAdmit && !oldAdmit) { newlyAdmitted++; storiesHit.add(id); }
      const d = rl.decideRepairMethod(si.pageNumber, ev, null, {});
      const key = `${newAdmit && !oldAdmit ? 'NEW ' : 'old '}${d.method}`;
      routes[key] = (routes[key] || 0) + 1;
      rows.push({ id, page: si.pageNumber, score: v.finalScore, type: rf.type, sev: rf.severity, newAdmit: newAdmit && !oldAdmit, route: d.method });
    }
  }
  console.log(JSON.stringify({ stories: ids.length, pages, pagesWithReaderMajor: withReader, newlyAdmitted, storiesAffected: storiesHit.size, routes }, null, 1));
  for (const r of rows) console.log(r.id.slice(-9), 'p' + r.page, r.score, r.sev, r.type, r.newAdmit ? 'NEW' : 'old', r.route);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
