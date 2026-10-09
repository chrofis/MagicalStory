// Replays the declared-gaze severity grade (gazeCheck.gazeSeverity) over STORED staging findings. Free, read-only.
// Usage: node scripts/analysis/gaze-severity-replay.js [--days=21] [--econ=<repair-economics output json>] [--labels=<labels.json>]
// For every stored version carrying a gaze-check finding (consolidated bucket, fixed wording "<name> is declared looking"):
//   old severity (stored) vs new severity (from the version's stored sceneMetadata.interactions), the page score after
//   re-billing that one finding, and whether repairLogic.findBadPages still puts the page into repair.
// Savings: a page whose ORIGINAL render stops triggering repair saves every later version's unit cost (repair-economics UNIT).
'use strict';
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { gazeSeverity } = require('../../server/lib/gazeCheck');
const { resolveLooksAt } = require('../../server/lib/compositeCastBuilder');
const { gazeCharacters, gazeCreatures } = require('../../server/lib/vbIdGuard');
const { sumDeductionPoints } = require('../../server/lib/scoring');
const { findBadPages } = require('../../server/lib/repairLogic');
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DAYS = Number(arg('days', 21));
const UNIT = arg('econ') ? JSON.parse(fs.readFileSync(arg('econ'), 'utf8')).meta.UNIT : {};
const labelsFile = arg('labels', null);
const GAZE = /is declared looking/i;
const METHOD = /^(iterate|inpaint|char-fix|garment-recolour)-round-\d+$/;
const unitOf = (src) => { const m = METHOD.exec(src || ''); return m ? (UNIT[m[1]] || 0) : 0; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const triggers = (v) => findBadPages({ 1: v }).length > 0;

function declaredLooksAt(meta, name, vb) {
  const all = [...(gazeCharacters(meta) || []), ...gazeCreatures(meta, vb)];
  const row = all.find(c => String(c.name || '').toLowerCase() === String(name || '').toLowerCase());
  return row ? row.looksAt : null;
}

function replayVersion(v, vb, pageMeta) {
  const meta = v.sceneMetadata || pageMeta || {}; // versions store none; the page keeps the brief's metadata
  const interactions = meta.interactions || meta.fullData?.interactions || [];
  const cons = v.deductions?.consolidated || [];
  const after = clone(v);
  const rows = [];
  for (const f of cons) {
    if (!GAZE.test(f.description || '')) continue;
    const looksAt = declaredLooksAt(meta, f.name, vb);
    const sev = looksAt ? gazeSeverity({ name: f.name, looksAt, interactions, resolveTarget: (t) => resolveLooksAt(t, vb) }) : null;
    rows.push({ name: f.name, old: String(f.severity).toUpperCase(), next: sev, looksAt });
    if (sev) after.deductions.consolidated.find(g => g === g && g.description === f.description && g.name === f.name).severity = sev.toLowerCase();
  }
  if (!rows.length) return null;
  const dBefore = sumDeductionPoints(v.deductions), dAfter = sumDeductionPoints(after.deductions);
  after.finalScore = v.finalScore + dBefore - dAfter;
  return { rows, before: { score: v.finalScore, bad: triggers(v) }, after: { score: after.finalScore, bad: triggers(after) } };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const q = await pool.query(`select id, created_at::text ca, data->'sceneImages' si, data->'visualBible' vb from stories where created_at > now() - ($1 || ' days')::interval and (data->>'isPartial') is distinct from 'true'`, [String(DAYS)]);
  const dist = {}, bump = (k) => { dist[k] = (dist[k] || 0) + 1; };
  let findings = 0, pagesWithGaze = 0, noLongerRepair = 0, stillRepair = 0, newlyRepair = 0, saved = 0, storiesHit = new Set(), savedByStory = {};
  const detail = [];
  for (const row of q.rows) {
    for (const si of (row.si || [])) {
      const vers = si.imageVersions || [];
      let stopAt = -1;
      vers.forEach((v, i) => {
        const r = replayVersion(v, row.vb || null, si.sceneMetadata);
        if (!r) return;
        findings += r.rows.length; storiesHit.add(row.id);
        r.rows.forEach(x => bump(`${x.old} -> ${x.next}`));
        if (i === 0) {
          pagesWithGaze++;
          if (r.before.bad && !r.after.bad) { noLongerRepair++; stopAt = i; }
          else if (r.before.bad && r.after.bad) stillRepair++;
          else if (!r.before.bad && r.after.bad) newlyRepair++;
          detail.push({ story: row.id, pn: si.pageNumber, rows: r.rows, before: r.before, after: r.after });
        }
      });
      if (stopAt === 0) for (const v of vers.slice(1)) { const c = unitOf(v.source); saved += c; savedByStory[row.id] = (savedByStory[row.id] || 0) + c; }
    }
  }
  console.log(JSON.stringify({ days: DAYS, stories: q.rows.length, storiesWithGaze: storiesHit.size, gazeFindings: findings, severityChange: dist,
    firstRenderPagesWithGaze: pagesWithGaze, pagesNoLongerRepaired: noLongerRepair, pagesStillRepaired: stillRepair, pagesNewlyRepaired: newlyRepair,
    savedUsdTotal: +saved.toFixed(3), savedUsdPerStoryAll: +(saved / q.rows.length).toFixed(4) }, null, 1));
  for (const d of detail) console.log(JSON.stringify(d));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
