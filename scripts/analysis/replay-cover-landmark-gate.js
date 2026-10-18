#!/usr/bin/env node
/**
 * REPLAY the covers' landmark gate (owner, 2026-10-18) over every stored story that has a cover-place decision.
 * Rung 1 of the validation ladder: stored arc + plan + Visual Bible + offered landmarks, Jev calls only
 * (~USD 0.0006 a story), no image, no story run.
 *
 *   node scripts/analysis/replay-cover-landmark-gate.js [--out=<file.json>] [--dry]
 *
 * Per story: BEFORE = the stored decision (its covers that stand on an offered landmark); AFTER = the production
 * decideCoverPlaces called with landmarkGuideline.coverTownInputs. A story whose premise names its own world must
 * come out with no landmark cover; a real-world story must offer the same candidates as before (--dry checks that
 * for free, no Jev call). Reads DATABASE_URL and STAGING_DATABASE_URL.
 * see docs/decisions.md 2026-10-18 "Covers obey the landmark gate"
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { Pool } = require('pg');
const JBF = require('../../server/lib/jevBriefFields');
const { coverTownInputs } = require('../../server/lib/landmarkGuideline');
const argv = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

(async () => {
  const out = [];
  for (const [env, url] of [['prod', process.env.DATABASE_URL], ['staging', process.env.STAGING_DATABASE_URL]]) {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const r = await pool.query(`select id, data->'beatsReviewReport'->'arc' arc, data->'beatsReviewReport'->'pagePlan' plan, data->'visualBible' vb,
      data->'replayInputs'->'availableLandmarks' lms, data->'userLocation'->>'city' town, (data->>'premiseNamedWorld')::boolean pw,
      data->'jevDecisions'->'coverPlaces'->'covers' covers from stories where data->'jevDecisions'->'coverPlaces' is not null`);
    await pool.end();
    for (const d of r.rows) {
      const pages = String(d.plan || '').split(/\n+/).filter(l => /^Page \d+:/.test(l)).map((l) => { const m = /^Page (\d+):\s*(.*)$/.exec(l); return { pageNumber: Number(m[1]), planLine: m[2] }; });
      const lms = Array.isArray(d.lms) ? d.lms : [];
      const input = { premiseNamedWorld: d.pw === true ? true : false, availableLandmarks: lms, userLocation: { city: d.town } };
      const pageNums = pages.map(p => p.pageNumber);
      const before = JBF.coverPlaceCandidates(d.vb, pageNums, lms).map(c => c.id);
      const after = JBF.coverPlaceCandidates(d.vb, pageNums, coverTownInputs(input).availableLandmarks).map(c => c.id);
      const row = { env, id: d.id, premiseNamedWorld: input.premiseNamedWorld, storedLandmarkCovers: (d.covers || []).filter(c => c.offered).length, covers: (d.covers || []).length,
        candidatesBefore: before.length, candidatesAfter: after.length, candidatesUnchanged: JSON.stringify(before) === JSON.stringify(after) };
      if (!argv.dry && input.premiseNamedWorld && d.arc && pages.length) {
        const keys = d.covers.map(c => c.coverKey);
        const casts = Object.fromEntries(d.covers.map(c => [c.coverKey, c.cast || []]));
        const res = await JBF.decideCoverPlaces({ arc: d.arc, pages, visualBible: d.vb, coverKeys: keys, casts, ...coverTownInputs(input) });
        row.after = res.covers.map(c => ({ key: c.coverKey, cite: c.cite, offered: !!c.offered, shared: c.shared }));
        row.afterLandmarkCovers = res.covers.filter(c => c.offered).length;
        row.unmet = res.unmet || [];
        row.costUsd = res.stats.costUsd;
      }
      out.push(row);
    }
  }
  const made = out.filter(r => r.premiseNamedWorld), real = out.filter(r => !r.premiseNamedWorld);
  const summary = {
    madeUpWorld: { stories: made.length, withLandmarkCoverBefore: made.filter(r => r.storedLandmarkCovers > 0).length, landmarkCoversBefore: made.reduce((s, r) => s + r.storedLandmarkCovers, 0), coversTotal: made.reduce((s, r) => s + r.covers, 0),
      landmarkCoversAfter: argv.dry ? null : made.reduce((s, r) => s + (r.afterLandmarkCovers || 0), 0), costUsd: +made.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(5) },
    realWorld: { stories: real.length, candidatesUnchanged: real.filter(r => r.candidatesUnchanged).length },
  };
  console.log(JSON.stringify(summary, null, 1));
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify({ summary, rows: out }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
