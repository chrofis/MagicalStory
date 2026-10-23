#!/usr/bin/env node
/**
 * Free replay (USD 0, no model call): the REAL plate grouping and page grid
 * selection over STORED stories, before vs after the 2026-10-23 change
 * "A plate is split where an element it draws changes state"
 * (docs/decisions.md; bug trial-plated-vehicle-gets-no-reference).
 *
 *   old grouping = the same real groupers with the state split undone
 *                  (sub-groups merged back by vantage / by background entry)
 *   new grouping = groupPagesByVantage (full stories) / groupTrialPlatePagesByVantage (trials)
 *
 * Reports: how many stories split, how many groups gained, and that every story
 * with no stateful plate-drawn element produces IDENTICAL groups. With --story
 * it also prints the new groups and per-page grid cells for that story
 * (old = plate-borne cells dropped on every plated page; new = the trial keeps
 * the cell its plate did not carry).
 *
 * Usage: node scripts/analysis/replay-plate-element-state.js [--limit 80] [--story <id>]
 * Needs .env with DATABASE_PUBLIC_URL (prod) and STAGING_DATABASE_URL.
 */
require('dotenv').config();
const { Pool } = require('pg');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(opt('limit', '80'), 10);
const ONE = opt('story', null);

const { groupPagesByVantage, groupTrialPlatePagesByVantage } = require('../../server/lib/sceneMetadata');
const { plateElementStates, isLargeScaleClass } = require('../../server/lib/visualBible');
const pageRender = require('../../server/lib/pageRenderCall');

const SQL = `
  select id, (data->>'trialMode') as trial, data->'visualBible' as vb,
    (select coalesce(jsonb_agg(jsonb_build_object(
        'pageNumber', e->'pageNumber', 'sceneMetadata', e->'sceneMetadata',
        'emptyScenePrompt', e->'emptyScenePrompt') order by (e->>'pageNumber')::int), '[]'::jsonb)
       from jsonb_array_elements(case when jsonb_typeof(data->'sceneImages')='array' then data->'sceneImages' else '[]'::jsonb end) e) as pages
  from stories
  where data->'visualBible' is not null and jsonb_typeof(data->'visualBible')='object'
  order by created_at desc nulls last
  limit $1`;

const sig = (arr) => JSON.stringify(arr.map(p => p.join(',')).sort());

async function load(label, url) {
  if (!url) { console.log(`[skip] ${label}: no connection string`); return []; }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query(SQL, [LIMIT]);
    return r.rows.map(x => ({ ...x, env: label }));
  } finally { await pool.end(); }
}

(async () => {
  const rows = [
    ...(ONE ? [] : await load('staging', process.env.STAGING_DATABASE_URL)),
    ...await load('prod', process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL),
  ];
  let counted = 0, withState = 0, splitStories = 0, extraPlates = 0, identicalNoState = 0, noState = 0, noGroups = 0;
  const splitList = [];
  for (const row of rows) {
    if (ONE && row.id !== ONE) continue;
    const vb = row.vb;
    const pages = (row.pages || []).filter(p => p.pageNumber != null);
    const trial = row.trial === 'true';
    let oldG, newG;
    if (trial) {
      // A trial hint carries no brief here: replay on the VB page lists, as the trial does.
      newG = groupTrialPlatePagesByVantage(vb).map(g => g.pages);
      oldG = Object.values(groupTrialPlatePagesByVantage(vb).reduce((acc, g) => {
        const k = `${g.description}|${g.landmarkPhoto}`; (acc[k] = acc[k] || []).push(...g.pages); return acc;
      }, {})).map(p => p.sort((a, b) => a - b));
    } else {
      const pdArr = pages.map(p => ({ pageNumber: p.pageNumber, sceneMetadata: p.sceneMetadata, emptyScenePrompt: p.emptyScenePrompt }));
      const groups = groupPagesByVantage(pdArr, vb);
      newG = [...groups.values()].map(g => g.pageNumbers);
      const byVantage = new Map();
      for (const g of groups.values()) {
        const k = g.vantage ? g.vantage.vantageId : '__u__';
        byVantage.set(k, [...(byVantage.get(k) || []), ...g.pageNumbers].sort((a, b) => a - b));
      }
      oldG = [...byVantage.values()];
    }
    if (newG.length === 0) { noGroups++; continue; }
    counted++;
    // "stateful": some page's plate draws an element that has >1 state row
    const stateful = (vb.vehicles || []).concat((vb.artifacts || []).filter(e => isLargeScaleClass(e.scaleClass))).some(e => (e.states || []).length > 1);
    if (stateful) withState++; else noState++;
    const same = sig(oldG) === sig(newG);
    if (!stateful) { if (same) identicalNoState++; else console.log(`!! ${row.env} ${row.id}: groups differ without any stateful element`); }
    if (!same) { splitStories++; extraPlates += newG.length - oldG.length; splitList.push(`${row.env} ${row.id} ${trial ? 'trial' : 'full'}: old ${sig(oldG)} -> new ${sig(newG)}`); }

    if (ONE) {
      console.log(`\n${row.env} ${row.id} (${trial ? 'trial' : 'full'})`);
      console.log('old groups', sig(oldG)); console.log('new groups', sig(newG));
      for (const p of pages) {
        const sm = p.sceneMetadata || { objects: [], fullData: { objects: [] } };
        const sel = pageRender.selectPageElementRefs(vb, p.pageNumber, sm);
        const hasPlate = true;
        const oldKept = pageRender.keepPageGridElements(sel, { hasPlate, sceneMetadata: sm });
        const newKept = pageRender.keepPageGridElements(sel, { hasPlate, sceneMetadata: sm, plateCarriesElements: !trial });
        const drawn = plateElementStates(vb, p.pageNumber, { aboardId: sm.aboard || null, sceneObjects: trial ? null : (sm.objects || null) })
          .map(x => `${x.entry.id}:${x.state ? x.state.id : '-'}`);
        console.log(`p${p.pageNumber} selected=[${sel.map(e => e.stateId || e.id)}] oldGrid=[${oldKept.map(e => e.stateId || e.id)}] newGrid=[${newKept.map(e => e.stateId || e.id)}] plateDraws=[${drawn}]`);
      }
    }
  }
  console.log(`\nstories read: ${rows.length}; with plate groups: ${counted} (no sceneImages/backgrounds: ${noGroups})`);
  console.log(`stateful (a plate-drawable vehicle / large artifact with >1 state): ${withState}; stateless: ${noState}`);
  console.log(`stateless stories with IDENTICAL old/new groups: ${identicalNoState}/${noState} (${noState ? (100 * identicalNoState / noState).toFixed(1) : 'n/a'}%)`);
  console.log(`stories whose grouping changed: ${splitStories}/${counted}; extra plates in total: ${extraPlates}`);
  splitList.slice(0, 30).forEach(l => console.log('  ' + l));
})().catch(e => { console.error(e); process.exit(1); });
