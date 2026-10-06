#!/usr/bin/env node
/**
 * REPLAY the wider Jev options of 2026-10-06 round 2 (weather, new-day clock, aboard creatures, population
 * levels, one-scale cover places) over stored staging stories. Rung 1 of the validation ladder: stored
 * arc + plan + Visual Bible, Jev calls only (cents), no paid model call, no image.
 *
 *   node scripts/analysis/replay-jev-options-2.js <storyIdOrSuffix,...> [--out=<file.json>] [--dotenv=<path>] [--only=weather,aboard,population,cover]
 *
 * Per story it re-runs the PRODUCTION decideLight, decideVbAndAboard, decidePopulation and decideCoverPlaces
 * on the stored inputs and prints the stored (old) decision beside the new one, and the probability
 * movement: old high-confidence picks (P >= 0.8) that moved. Reads STAGING_DATABASE_URL.
 * see docs/decisions.md 2026-10-06 "Wider Jev options: weather, aboard, population, clock"
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const { Pool } = require('pg');
const JD = require('../../server/lib/jevDecisions');
const JBF = require('../../server/lib/jevBriefFields');
const only = argv.only ? String(argv.only).split(',') : ['weather', 'aboard', 'population', 'cover'];

async function load(pool, idOrSuffix) {
  const r = await pool.query(`select id, jsonb_build_object('arc', data->'beatsReviewReport'->'arc', 'pagePlan', data->'beatsReviewReport'->'pagePlan',
    'jev', data->'jevDecisions', 'vb', data->'visualBible', 'landmarks', data->'replayInputs'->'availableLandmarks', 'town', data->'userLocation'->>'city') d
    from stories where id = $1 or id like $2 limit 1`, [idOrSuffix, `%${idOrSuffix}`]);
  if (!r.rows.length) throw new Error(`no story ${idOrSuffix}`);
  return { id: r.rows[0].id, ...r.rows[0].d };
}

const baseOf = id => String(id || '').trim().toUpperCase().split('.')[0];

async function replay(d) {
  const pages = String(d.pagePlan).split(/\n+/).filter(l => /^Page \d+:/.test(l))
    .map((l) => { const m = /^Page (\d+):\s*(.*)$/.exec(l); return { pageNumber: Number(m[1]), planLine: m[2] }; });
  const stats = { calls: 0, costUsd: 0 };
  const add = s => { stats.calls += s.calls; stats.costUsd += s.costUsd; };
  const out = { id: d.id, stats };
  const jev = d.jev || {};

  if (only.includes('weather')) {
    const light = await JD.decideLight({ arc: d.arc, pages });
    add(light.stats);
    const old = new Map(((jev.light || {}).pages || []).map(p => [p.pageNumber, p]));
    out.weather = light.pages.map(p => ({ page: p.pageNumber, oldAdvice: (old.get(p.pageNumber) || {}).weatherAdvice, newAdvice: p.weatherAdvice, oldTime: (old.get(p.pageNumber) || {}).timeOfDay, time: p.timeOfDay, jevTime: p.jevTime, newDayP: p.newDayP, indoor: p.indoor }));
    out.clockHeld = light.clockHeld;
  }
  if (only.includes('aboard')) {
    const commissioned = [...new Set(((jev.gaze || {}).pages || []).flatMap(p => p.characters.map(c => c.name)))];
    const vb = await JD.decideVbAndAboard({ arc: d.arc, pages, visualBible: d.vb, commissionedNames: commissioned });
    add(vb.stats);
    const old = new Map(((jev.vb || {}).pages || []).map(p => [p.pageNumber, p]));
    out.aboard = vb.pages.map(p => ({ page: p.pageNumber, old: (old.get(p.pageNumber) || {}).aboard || null, new: p.aboard, scores: p.aboardScores,
      oldCites: ((old.get(p.pageNumber) || {}).elements || []).map(e => e.id).sort().join(','), newCites: p.elements.map(e => e.id).sort().join(',') }));
  }
  if (only.includes('population')) {
    const locOf = new Map();
    for (const [n, cite] of Object.entries(jev.locations || {})) if (cite) locOf.set(Number(n), baseOf(cite));
    const pop = await JD.decidePopulation({ arc: d.arc, pages, visualBible: d.vb, locOf });
    add(pop.stats);
    out.population = Object.entries(pop.byLocation).map(([id, v]) => ({ loc: id, old: ((jev.population || {}).byLocation || jev.population || {})[id]?.population, new: v.population, publicP: v.publicP, crowdP: v.crowdP, creatureCrowdP: v.creatureCrowdP, wildlifeP: v.wildlifeP, sparseP: v.sparseP, pages: v.pages }));
  }
  if (only.includes('cover') && jev.coverPlaces) {
    const old = jev.coverPlaces.covers || [];
    const coverKeys = old.map(c => c.coverKey);
    const casts = Object.fromEntries(old.map(c => [c.coverKey, c.cast || []]));
    const cov = await JBF.decideCoverPlaces({ arc: d.arc, pages, visualBible: d.vb, coverKeys, casts, availableLandmarks: d.landmarks || [], town: d.town || null });
    add(cov.stats);
    out.cover = { old: old.map(c => ({ key: c.coverKey, cite: c.cite, label: c.label, p: c.p, offered: !!c.offered })), new: cov.covers.map(c => ({ key: c.coverKey, cite: c.cite, label: c.label, p: c.p, offered: !!c.offered, candidates: c.candidates })), unmet: cov.unmet };
  }
  return out;
}

(async () => {
  const ids = String(process.argv[2] || '').split(',').filter(Boolean);
  if (!ids.length) throw new Error('usage: replay-jev-options-2.js <storyId,...>');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const results = [];
  for (const id of ids) {
    const r = await replay(await load(pool, id));
    results.push(r);
    console.log(`\n${r.id}  (${r.stats.calls} calls, USD ${r.stats.costUsd.toFixed(5)})`);
    if (r.weather) {
      const dist = {}; for (const w of r.weather) dist[w.newAdvice] = (dist[w.newAdvice] || 0) + 1;
      console.log('  weather new:', JSON.stringify(dist), ' moved vs old advice:', r.weather.filter(w => w.oldAdvice && w.oldAdvice !== w.newAdvice).map(w => `p${w.page}:${w.oldAdvice}->${w.newAdvice}`).join(' ') || 'none');
      console.log('  new-day P>=0.5:', r.weather.filter(w => w.newDayP >= 0.5).map(w => `p${w.page}(${w.newDayP})${w.jevTime !== w.time ? ' held' : ''}`).join(' ') || 'none', '| clock held:', (r.clockHeld || []).map(h => `p${h.pageNumber}:${h.jev}->${h.held}`).join(' ') || 'none');
      console.log('  light vs stored:', r.weather.filter(w => w.oldTime && w.oldTime !== w.time).map(w => `p${w.page}:${w.oldTime}->${w.time}`).join(' ') || 'same');
    }
    if (r.aboard) {
      console.log('  aboard old:', r.aboard.filter(a => a.old).map(a => `p${a.page}:${a.old}`).join(' ') || 'none', '| new:', r.aboard.filter(a => a.new).map(a => `p${a.page}:${a.new}`).join(' ') || 'none');
      console.log('  aboard top scores:', r.aboard.map(a => [a.page, Object.entries(a.scores || {}).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k, v]) => `${k} ${v}`).join('/')]).filter(x => x[1]).map(x => `p${x[0]}[${x[1]}]`).join(' '));
    }
    if (r.population) for (const p of r.population) console.log(`  population ${p.loc}: ${p.old} -> ${p.new}  (public ${p.publicP}, crowd ${p.crowdP}, creatureCrowd ${p.creatureCrowdP}, wildlife ${p.wildlifeP}, sparse ${p.sparseP}) pages ${p.pages.join(',')}`);
    if (r.cover) {
      console.log('  cover old:', r.cover.old.map(c => `${c.key} ${c.cite}${c.offered ? '*' : ''} ${c.p}`).join(' | '));
      console.log('  cover new:', r.cover.new.map(c => `${c.key} ${c.cite}${c.offered ? '*' : ''} ${c.p}`).join(' | '), r.cover.unmet.length ? `UNMET ${r.cover.unmet.join('; ')}` : '');
      for (const c of r.cover.new) console.log(`    ${c.key} candidates:`, JSON.stringify(c.candidates));
    }
  }
  const total = results.reduce((a, r) => ({ calls: a.calls + r.stats.calls, costUsd: a.costUsd + r.stats.costUsd }), { calls: 0, costUsd: 0 });
  console.log(`\nTOTAL ${total.calls} calls, USD ${total.costUsd.toFixed(5)}`);
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify({ results, total }, null, 1));
  await pool.end();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
