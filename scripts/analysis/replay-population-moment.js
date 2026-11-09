#!/usr/bin/env node
/**
 * REPLAY the per-page population moment question (jevDecisions.decidePopulationMoment) over STORED stories.
 * Rung 1 of the validation ladder: stored arc, plan lines, decided light and place population; Jev calls only
 * (fractions of a cent each), no image, no story run. Both DBs are only READ (SELECT).
 *
 *   node scripts/analysis/replay-population-moment.js --count            (free: how many pages each story would ask)
 *   node scripts/analysis/replay-population-moment.js --out=<dir> [--max-stories=N] [--cap-usd=0.30]
 *
 * Old = the stored page's jevFixed.population (the place answer copied to the page). New = the moment answer.
 * see docs/decisions.md 2026-11-09 "Population follows the page's moment"
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { Pool } = require('pg');
const JD = require('../../server/lib/jevDecisions');
const argv = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const baseOf = id => String(id || '').trim().toUpperCase().split('.')[0];

async function loadAll() {
  const seen = new Map();
  for (const [env, url] of [['staging', process.env.STAGING_DATABASE_URL], ['prod', process.env.DATABASE_URL]]) {
    if (!url) continue;
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const r = await pool.query(`select id, data->'beatsReviewReport'->'arc' arc, data->'beatsReviewReport'->>'pagePlan' plan,
      (select jsonb_agg(jsonb_build_object('n', coalesce((s->>'pageNumber')::int, 0), 'jf', s->'jevFixed')) from jsonb_array_elements(data->'sceneImages') s where s->'jevFixed' is not null) scenes
      from stories where data->'jevDecisions'->'population' is not null and data->'sceneImages' is not null order by created_at desc`);
    for (const row of r.rows) if (!seen.has(row.id) && row.scenes && row.plan) seen.set(row.id, { env, ...row });
    await pool.end();
  }
  return [...seen.values()];
}

(async () => {
  const stories = await loadAll();
  const rows = stories.map((s) => {
    const plan = new Map(String(s.plan).split(/\n+/).map(l => /^Page (\d+):\s*(.*)$/.exec(l)).filter(Boolean).map(m => [Number(m[1]), m[2]]));
    const pages = (s.scenes || []).filter(x => x.n > 0 && plan.has(x.n)).map(x => ({ n: x.n, jf: x.jf, planLine: plan.get(x.n) }));
    const arc = typeof s.arc === 'string' ? s.arc : (s.arc && (s.arc.text || JSON.stringify(s.arc))) || '';
    return { id: s.id, env: s.env, arc, pages };
  }).filter(s => s.pages.length);
  const counts = rows.map(s => ({ id: s.id, env: s.env, pages: s.pages.length, ambient: s.pages.filter(p => p.jf.population === 'ambient').length, crowd: s.pages.filter(p => p.jf.population === 'crowd').length, other: s.pages.filter(p => !['ambient', 'crowd'].includes(p.jf.population)).length }));
  if (argv.count) { console.table(counts); console.log('asked pages total:', counts.reduce((a, c) => a + c.ambient + c.crowd, 0)); return; }
  const out = argv.out; fs.mkdirSync(out, { recursive: true });
  const cap = Number(argv['cap-usd'] || 0.3);
  let spent = 0; const results = [];
  for (const s of rows.filter(r => !/_edittest$/.test(r.id) && r.pages.some(p => ['ambient','crowd'].includes(p.jf.population))).slice(0, Number(argv['max-stories'] || 999))) {
    if (spent >= cap) { console.log('cap reached, stopping'); break; }
    const pagesIn = s.pages.map(p => ({ pageNumber: p.n, planLine: p.planLine }));
    const byLocation = {}; const locOf = new Map(); const lightOf = new Map();
    for (const p of s.pages) {
      const loc = baseOf(p.jf.location); if (!loc) continue;
      locOf.set(p.n, loc);
      byLocation[loc] = { population: p.jf.population };      // the stored page value stands for its place (all pages of a place carried one value)
      lightOf.set(p.n, { timeOfDay: p.jf.timeOfDay, indoor: !!p.jf.indoor });
    }
    const d = await JD.decidePopulationMoment({ arc: s.arc, pages: pagesIn, byLocation, locOf, lightOf });
    spent += d.stats.costUsd;
    const rowsOut = s.pages.map(p => { const r = d.byPage.get(p.n); return { page: p.n, plan: p.planLine, timeOfDay: p.jf.timeOfDay, indoor: !!p.jf.indoor, old: p.jf.population, new: r ? r.population : p.jf.population, momentP: r ? r.momentP : null }; });
    results.push({ id: s.id, env: s.env, calls: d.stats.calls, costUsd: d.stats.costUsd, pages: rowsOut });
    console.log(`${s.id} (${s.env}) ${d.stats.calls} calls USD ${d.stats.costUsd}; lowered: ${rowsOut.filter(r => r.old !== r.new).map(r => `p${r.page}`).join(' ') || 'none'}`);
  }
  fs.writeFileSync(path.join(out, 'raw.json'), JSON.stringify({ results, spentUsd: +spent.toFixed(5) }, null, 1));
  console.log('spent USD', spent.toFixed(5));
})().catch(e => { console.error(e.stack); process.exit(1); });
