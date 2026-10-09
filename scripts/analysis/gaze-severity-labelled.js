// Replays gazeSeverity over the gaze-check findings in the action-judge harness runs, on the 56 hand-labelled pages. Free, read-only.
// Usage: node scripts/analysis/gaze-severity-labelled.js <labels.json> <runs.json> [<runs2.json> ...]
// Per run file: old (MAJOR) vs new severity of every gaze finding, which pages carry a real defect (label.realPage), and
// whether any real page would LOSE its serious (MAJOR+) action_interaction flag. Finding -> declared looksAt through the
// page's stored brief (sceneImages[pn].sceneMetadata), joined on the finding's `name`.
'use strict';
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { gazeSeverity } = require('../../server/lib/gazeCheck');
const { resolveLooksAt } = require('../../server/lib/compositeCastBuilder');
const { gazeCharacters, gazeCreatures } = require('../../server/lib/vbIdGuard');
const [labelsFile, ...runFiles] = process.argv.slice(2);
const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')).pages;
const byId = Object.fromEntries(labels.map(p => [p.id, p]));
const GAZE = /is declared looking/i;
const SERIOUS = new Set(['MAJOR', 'CRITICAL']);
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ctx = {};
  for (const p of labels) {
    const r = await pool.query(`select data->'sceneImages' si, data->'visualBible' vb from stories where id=$1`, [p.story]);
    const si = (r.rows[0]?.si || []).find(s => s.pageNumber === p.pn);
    ctx[p.id] = { meta: si?.sceneMetadata || {}, vb: r.rows[0]?.vb || null };
  }
  for (const f of runFiles) {
    const runs = JSON.parse(fs.readFileSync(f, 'utf8')).runs.filter(r => !r.error);
    const dist = {}; const perRun = {}; const realCases = []; let gazeN = 0, unresolved = 0;
    for (const r of runs) {
      const c = ctx[r.id], p = byId[r.id]; if (!c || !p) continue;
      const ai = r.findings.filter(x => x.type === 'action_interaction');
      const newSev = [];
      for (const x of ai) {
        if (!GAZE.test(x.description || '')) { newSev.push({ x, sev: String(x.severity).toUpperCase() }); continue; }
        gazeN++;
        const all = [...(gazeCharacters(c.meta) || []), ...gazeCreatures(c.meta, c.vb)];
        const name = (x.name || /^(.+?) is declared looking/i.exec(x.description)[1]).trim();
        const row = all.find(a => String(a.name || '').toLowerCase() === name.toLowerCase());
        const interactions = c.meta.interactions || c.meta.fullData?.interactions || [];
        if (!row) { unresolved++; newSev.push({ x, sev: String(x.severity).toUpperCase() }); continue; }
        const sev = gazeSeverity({ name, looksAt: row.looksAt, interactions, resolveTarget: (t) => resolveLooksAt(t, c.vb) });
        const k = `${String(x.severity).toUpperCase()} -> ${sev}`; dist[k] = (dist[k] || 0) + 1;
        newSev.push({ x, sev, gaze: true });
        if (p.realPage) realCases.push({ id: r.id, run: r.run, name, looksAt: row.looksAt, desc: x.description.slice(0, 120), old: String(x.severity).toUpperCase(), next: sev });
      }
      const oldFlag = ai.some(x => SERIOUS.has(String(x.severity).toUpperCase()));
      const newFlag = newSev.some(n => SERIOUS.has(n.sev));
      const gazeFlagOld = ai.some(x => GAZE.test(x.description || '') && SERIOUS.has(String(x.severity).toUpperCase()));
      const key = `run${r.run}`; perRun[key] = perRun[key] || { pagesFlagged_old: 0, pagesFlagged_new: 0, realPagesFlagged_old: 0, realPagesFlagged_new: 0, gazeFlaggedPages_old: 0, gazeFlaggedPages_new: 0, realPagesLost: [] };
      const P = perRun[key];
      if (oldFlag) P.pagesFlagged_old++; if (newFlag) P.pagesFlagged_new++;
      if (p.realPage && oldFlag) P.realPagesFlagged_old++; if (p.realPage && newFlag) P.realPagesFlagged_new++;
      if (p.realPage && oldFlag && !newFlag) P.realPagesLost.push(r.id);
      if (gazeFlagOld) P.gazeFlaggedPages_old++;
      if (newSev.some(n => n.gaze && SERIOUS.has(n.sev))) P.gazeFlaggedPages_new++;
    }
    console.log(`\n=== ${f}: ${gazeN} gaze findings (${unresolved} without a declared looksAt row)`);
    console.log('severity change:', JSON.stringify(dist));
    console.log('per run:', JSON.stringify(perRun, null, 1));
    console.log('gaze findings on REAL-defect pages:', JSON.stringify(realCases, null, 1));
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
