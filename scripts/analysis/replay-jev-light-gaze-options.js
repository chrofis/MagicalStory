#!/usr/bin/env node
/**
 * REPLAY the wider Jev light and gaze options (2026-10-06) over stored staging stories (rung 1 of the
 * validation ladder: stored arc + plan + decisions, Jev calls only, ~USD 0.0001 a call, no paid model call).
 *
 *   node scripts/analysis/replay-jev-light-gaze-options.js <storyId,...> [--out=<file.json>] [--dotenv=<path>]
 *
 * Per story it re-runs the PRODUCTION decideLight, decideLightSources and decideGaze on the stored
 * arc/plan and the stored decisions' rosters and cites, and writes, per page, the stored (old) decision
 * next to the new one. Reads STAGING_DATABASE_URL. Prints a per-page diff and the probability movement:
 * old high-confidence targets (a person or element at P >= 0.8) that moved to another option.
 * see docs/decisions.md 2026-10-06 "Wider Jev options: light and gaze"
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const { Pool } = require('pg');
const JD = require('../../server/lib/jevDecisions');
const JBF = require('../../server/lib/jevBriefFields');
const { isDimLight } = require('../../server/lib/sceneLight');

async function load(pool, id) {
  const r = await pool.query(`select jsonb_build_object('arc', data->'beatsReviewReport'->'arc', 'pagePlan', data->'beatsReviewReport'->'pagePlan',
    'jev', data->'jevDecisions', 'vb', data->'visualBible') d from stories where id = $1`, [id]);
  if (!r.rows.length) throw new Error(`no story ${id}`);
  return r.rows[0].d;
}

async function replay(id, d) {
  const pages = String(d.pagePlan).split(/\n+/).filter(l => /^Page \d+:/.test(l))
    .map((l) => { const m = /^Page (\d+):\s*(.*)$/.exec(l); return { pageNumber: Number(m[1]), planLine: m[2] }; });
  const vb = d.vb || {};
  const stats = { calls: 0, costUsd: 0 };
  const add = s => { stats.calls += s.calls; stats.costUsd += s.costUsd; };
  const out = { id, light: [], gaze: [] };

  const light = await JD.decideLight({ arc: d.arc, pages });
  add(light.stats);
  const oldLight = new Map(((d.jev.light || {}).pages || []).map(p => [p.pageNumber, p]));
  for (const p of light.pages) out.light.push({ page: p.pageNumber, old: (oldLight.get(p.pageNumber) || {}).timeOfDay, new: p.timeOfDay, top: p.timeTop, indoor: p.indoor });

  // What lights each dark page: the stored cites of that page.
  const gIndex = JD.gazeIndex(vb);
  const lookOf = new Map();
  const vbRows = new Map(((d.jev.vb || {}).pages || []).map(p => [p.pageNumber, p]));
  const litPerPage = light.pages.filter(p => isDimLight(p.timeOfDay)).map(p => ({ pageNumber: p.pageNumber, elements: JBF.litCandidates(vbRows.get(p.pageNumber), gIndex, lookOf) }));
  const lit = await JD.decideLightSources({ arc: d.arc, pages, perPage: litPerPage });
  add(lit.stats);
  out.lightSources = Object.fromEntries([...lit.byPage].map(([n, xs]) => [n, xs.map(x => `${x.name} ${x.p}`)]));

  // Gaze: the stored roster and cites; the old decision beside the new.
  const commissioned = [...new Set(((d.jev.gaze || {}).pages || []).flatMap(p => p.characters.map(c => c.name)))];
  const locs = d.jev.locations || {};
  const perPage = ((d.jev.gaze || {}).pages || []).map((g) => {
    const row = vbRows.get(g.pageNumber);
    const page = pages.find(p => p.pageNumber === g.pageNumber);
    const roster = g.characters.map(c => c.name);
    const objects = [...(locs[g.pageNumber] ? [locs[g.pageNumber]] : []), ...(row ? row.elements.map(e => e.cite) : [])];
    return { pageNumber: g.pageNumber, roster, offFrame: JBF.offFrameOf(commissioned, roster, page && page.planLine),
      ...JD.gazePageMaterial({ objects, interactions: [], planLine: page ? page.planLine : '', index: gIndex }) };
  });
  const gaze = await JD.decideGaze({ arc: d.arc, pages, perPage });
  add(gaze.stats);
  const oldGaze = new Map(((d.jev.gaze || {}).pages || []).map(p => [p.pageNumber, p]));
  for (const g of gaze.pages) {
    for (const c of g.characters) {
      const o = oldGaze.get(g.pageNumber).characters.find(x => x.name === c.name);
      out.gaze.push({ page: g.pageNumber, name: c.name, old: o.looksAt, oldP: o.p, new: c.looksAt, newP: c.p });
    }
  }
  out.stats = stats;
  return out;
}

(async () => {
  const ids = String(process.argv[2] || '').split(',').filter(Boolean);
  if (!ids.length) throw new Error('usage: replay-jev-light-gaze-options.js <storyId,...>');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const results = [];
  for (const id of ids) {
    const r = await replay(id, await load(pool, id));
    results.push(r);
    console.log(`\n${id}  (${r.stats.calls} calls, USD ${r.stats.costUsd})`);
    console.log('  light  ', r.light.map(x => `p${x.page}:${x.old}${x.old === x.new ? '' : `->${x.new}`}`).join(' '));
    console.log('  top3   ', r.light.map(x => `p${x.page}[${(x.top || []).join(', ')}]`).join(' '));
    console.log('  sources', JSON.stringify(r.lightSources));
    for (const g of r.gaze.filter(x => x.old !== x.new)) console.log(`  gaze p${g.page} ${g.name}: ${g.old} (${g.oldP}) -> ${g.new} (${g.newP})`);
  }
  const all = results.flatMap(r => r.gaze);
  const moved = all.filter(x => x.old !== x.new);
  const wordsNew = ['down', 'up', 'ahead', 'distance', 'away', 'closed', 'outside', 'held'];
  console.log(`\nGAZE: ${all.length} decisions, ${moved.length} changed; old high-confidence (P>=0.8) person/element targets that moved: ${moved.filter(x => x.oldP >= 0.8 && !wordsNew.includes(x.old) && !/^LOC/.test(x.old)).length}; old place picks: ${all.filter(x => /^LOC/.test(x.old)).length}`);
  const total = results.reduce((a, r) => ({ calls: a.calls + r.stats.calls, costUsd: a.costUsd + r.stats.costUsd }), { calls: 0, costUsd: 0 });
  console.log(`TOTAL ${total.calls} calls, USD ${total.costUsd.toFixed(5)}`);
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify({ results, total }, null, 1));
  await pool.end();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
