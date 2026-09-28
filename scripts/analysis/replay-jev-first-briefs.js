#!/usr/bin/env node
/**
 * RUNG 1 OF "JEV FIRST, THEN REMOVE THE SCENE REVIEW" (owner, 2026-09-28;
 * tasks/jev-first-briefs-2026-09-28.md). Replays the production functions over
 * STORED staging stories — no paid text-model call; the `jev` mode spends Jev
 * calls only (~$0.0001 a call).
 *
 *   node scripts/analysis/replay-jev-first-briefs.js checks  [--limit=15]
 *       the code checks (briefChecks.collectBriefFindings, the new
 *       vb_id_label_mismatch among them) over every story's pre-review briefs:
 *       how many pages a re-ask would carry, and which types
 *   node scripts/analysis/replay-jev-first-briefs.js outfit  [--limit=15]
 *       clothingCheck's `outfit_missing` over the same briefs, with the text
 *       each finding reads — the precision measurement Q7 asks for
 *   node scripts/analysis/replay-jev-first-briefs.js q9      [--limit=15]
 *       the scene review's own checks: per tag, the pages it named, how many of
 *       those it rewrote, how many of those only that tag named; its bible
 *       corrections and cast removals — the table the owner decides Q9 from
 *   node scripts/analysis/replay-jev-first-briefs.js jev     [--only=<story ids>]
 *       the decision step BEFORE the briefs (jevBriefFields.decideBriefFields,
 *       on the Art Director's own bible from the stored raw reply and the
 *       stored head count) against the decisions the run made AFTER the briefs
 *       (stories.data.jevDecisions): cites, looks, population, gaze
 *   [--dotenv=<path>] [--out=<file.json>]
 *
 * Reads with a pg Pool and closes it; exits explicitly (image libraries keep
 * handles open). Loads leaf modules only — never beatsPipeline/storyHelpers.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const { Pool } = require('pg');

const mode = process.argv[2];
const LIMIT = Number(argv.limit) || 15;

async function loadStories(pool, where = "data ? 'sceneReviewReport'") {
  const only = argv.only ? String(argv.only).split(',') : null;
  const q = only
    ? await pool.query('select id, created_at, data from stories where id = any($1)', [only])
    : await pool.query(`select id, created_at, data from stories where ${where} and data->>'pipelineMode' is distinct from 'unified' order by created_at desc limit $1`, [LIMIT]);
  return q.rows;
}

/** The locked beats the run held: story pages from their stored plan lines, then the cover beats. */
function briefBeatsOf(d) {
  const { parsePagePlan } = require('../../server/lib/promptBuilders');
  const { buildCoverBeats } = require('../../server/lib/coverBeats');
  const { coverTypesFor } = require('../../server/lib/coverKeys');
  const plan = parsePagePlan(d.beatsReviewReport && d.beatsReviewReport.pagePlan);
  const story = (d.sceneImages || []).filter(s => s.pageNumber > 0).map(s => ({
    pageNumber: s.pageNumber,
    planLine: String(s.outlineExtract || '').replace(/^\s*PLAN:\s*/i, '') || plan.get(s.pageNumber) || '',
  }));
  let covers = [];
  try {
    covers = buildCoverBeats(d, { coverTypes: coverTypesFor(d), clothingRequirements: d.clothingRequirements || null, centralFigure: (d.arcReviewReport && d.arcReviewReport.centralFigure) || null });
  } catch { covers = []; }
  return [...story, ...covers];
}

async function checks(pool) {
  const { collectBriefFindings } = require('../../server/lib/briefChecks');
  const rows = [];
  const byType = {};
  for (const r of await loadStories(pool)) {
    const d = r.data;
    const briefs = ((d.sceneReviewReport && d.sceneReviewReport.briefsIn) || []).map(b => ({ pageNumber: b.pageNumber, brief: b.brief }));
    if (!briefs.length) continue;
    const vb = (d.sceneReviewReport && d.sceneReviewReport.visualBibleIn) || d.visualBible || null;
    const res = collectBriefFindings(briefs, { inputData: d, clothingRequirements: d.clothingRequirements || null, visualBible: vb, briefBeats: briefBeatsOf(d) });
    const pages = [...new Set(res.findings.map(f => f.pageNumber))].sort((a, b) => a - b);
    for (const f of res.findings) byType[f.type] = (byType[f.type] || 0) + 1;
    rows.push({ id: r.id, briefs: briefs.length, findings: res.findings.length, flaggedPages: pages, types: [...new Set(res.findings.map(f => f.type))] });
    console.log(`${r.id}  ${briefs.length} briefs, ${res.findings.length} finding(s) on ${pages.length} page(s) [${pages.join(',')}]  ${[...new Set(res.findings.map(f => f.type))].join(' ')}`);
  }
  const n = rows.length;
  const flagged = rows.reduce((a, x) => a + x.flaggedPages.length, 0);
  const briefs = rows.reduce((a, x) => a + x.briefs, 0);
  console.log(`\n${n} stories, ${briefs} briefs: a re-ask would carry ${flagged} page(s) (${(flagged / Math.max(1, n)).toFixed(1)} per story); stories with no re-ask: ${rows.filter(x => !x.flaggedPages.length).length}`);
  console.log('by type:', JSON.stringify(byType));
  return { rows, byType };
}

async function outfit(pool) {
  const { checkScenes } = require('../../server/lib/clothingCheck');
  const { extractSceneMetadata, splitBrief } = require('../../server/lib/sceneMetadata');
  const hits = [];
  let pages = 0;
  for (const r of await loadStories(pool)) {
    const d = r.data;
    const briefs = (d.sceneReviewReport && d.sceneReviewReport.briefsIn) || [];
    const res = checkScenes(briefs.map((x) => {
      const m = extractSceneMetadata(x.brief) || {};
      return { pageNumber: x.pageNumber, prose: splitBrief(x.brief).prose, cast: (m.characters || []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean), perCharClothing: m.characterClothing || {}, wornItems: m.wornItems || [] };
    }), d.clothingRequirements || null, { artifacts: (d.visualBible || {}).artifacts, visualBible: d.visualBible });
    pages += briefs.length;
    for (const f of res.findings.filter(x => x.type === 'outfit_missing')) {
      const b = briefs.find(x => x.pageNumber === f.pageNumber);
      const prose = b ? splitBrief(b.brief).prose : '';
      const i = prose.indexOf(f.character || '');
      hits.push({ id: r.id, pageNumber: f.pageNumber, character: f.character, detail: f.detail, window: i >= 0 ? prose.slice(i, i + 320) : prose.slice(0, 200) });
    }
  }
  for (const h of hits) console.log(`\n${h.id} p${h.pageNumber} ${h.character}: ${String(h.detail || '').slice(0, 160)}\n   PROSE: ${h.window.replace(/\s+/g, ' ')}`);
  console.log(`\n${hits.length} outfit_missing finding(s) over ${pages} pre-review briefs`);
  return { hits, pages };
}

/** "[tag] pages 4, 9" / "[tag] none" lines of a stored review analysis. */
function tagLines(analysis) {
  const out = {};
  for (const line of String(analysis || '').split('\n')) {
    const m = line.match(/^\s*(?:\d+[a-z]*\.\s*)?\*{0,2}\[([a-z_]+)\]\*{0,2}\s*(.*)$/i);
    if (!m) continue;
    const rest = m[2];
    const pages = /^\s*none\b/i.test(rest) ? [] : [...new Set((rest.match(/-?\d+/g) || []).map(Number))];
    out[m[1]] = pages;
  }
  return out;
}

async function q9(pool) {
  const tags = {};
  const stories = [];
  let bibleCorr = 0; const corrKinds = {}; let removals = 0;
  for (const r of await loadStories(pool)) {
    const sr = r.data.sceneReviewReport;
    if (!sr || !sr.analysis) continue;
    const briefPages = new Set((sr.briefsIn || []).map(b => b.pageNumber));
    const rewritten = new Set((sr.changedPages || (sr.pages || []).map(p => p.pageNumber)));
    const t = tagLines(sr.analysis);
    const namedBy = {};
    for (const [tag, pages] of Object.entries(t)) for (const p of pages.filter(x => briefPages.has(x))) (namedBy[p] = namedBy[p] || []).push(tag);
    for (const [tag, pages] of Object.entries(t)) {
      const row = tags[tag] = tags[tag] || { stories: 0, storiesNaming: 0, named: 0, rewritten: 0, onlyTag: 0, onlyTagRewritten: 0, examples: [] };
      row.stories++;
      const own = pages.filter(x => briefPages.has(x));
      if (own.length) row.storiesNaming++;
      for (const p of own) {
        row.named++;
        const rw = rewritten.has(p);
        if (rw) row.rewritten++;
        if ((namedBy[p] || []).length === 1) { row.onlyTag++; if (rw) { row.onlyTagRewritten++; if (row.examples.length < 3) row.examples.push(`${r.id.slice(-9)} p${p}`); } }
      }
    }
    const applied = (sr.bibleCorrections && sr.bibleCorrections.applied) || [];
    bibleCorr += applied.length;
    for (const a of applied) { const k = a.newPhoto !== undefined ? 'landmarkPhoto' : a.newText !== undefined ? 'text' : a.newPages ? 'statePages' : 'other'; corrKinds[k] = (corrKinds[k] || 0) + 1; }
    removals += ((sr.castRemovals && sr.castRemovals.pages) || []).length;
    stories.push({ id: r.id, rewritten: [...rewritten], jev: !!(r.data.jevDecisions && r.data.jevDecisions.vb) });
  }
  const order = Object.entries(tags).sort((a, b) => b[1].onlyTagRewritten - a[1].onlyTagRewritten || b[1].rewritten - a[1].rewritten);
  console.log(`${stories.length} stories with a stored review (${stories.filter(s => s.jev).length} on the Jev path)\n`);
  console.log('tag | stories answering | stories naming pages | pages named | named & rewritten | named by this tag alone | …and rewritten | examples');
  for (const [tag, x] of order) console.log(`${tag} | ${x.stories} | ${x.storiesNaming} | ${x.named} | ${x.rewritten} | ${x.onlyTag} | ${x.onlyTagRewritten} | ${x.examples.join(', ')}`);
  console.log(`\nbible corrections applied: ${bibleCorr} ${JSON.stringify(corrKinds)}; declared cast removals: ${removals}`);
  return { stories, tags, bibleCorr, corrKinds, removals };
}

async function jev(pool) {
  const { decideBriefFields } = require('../../server/lib/jevBriefFields');
  const { resolveReplayPresent } = require('../../server/lib/beatsReplayInputs');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  const rows = await loadStories(pool, "data ? 'jevDecisions' and data->'jevDecisions' ? 'vb'");
  const out = [];
  const agg = { citePages: 0, citeSame: 0, lookSame: 0, lookN: 0, popPages: 0, popSame: 0, gazeN: 0, gazeSame: 0, calls: 0 };
  for (const r of rows) {
    const d = r.data;
    const jd = d.jevDecisions;
    // The Art Director's own bible, as its reply wrote it (before any decision rewrote its page tables).
    const reply = ((d.sceneExpansionReport && d.sceneExpansionReport.replies) || []).map(x => x.text).find(t => /---VISUAL BIBLE---/.test(t || ''));
    if (!reply) { console.log(`${r.id}: no stored Art Director reply — skipped`); continue; }
    const section = reply.slice(reply.indexOf('---VISUAL BIBLE---')).split(/\n#{1,4}\s*Page\s*-?\d+/)[0];
    const vb = new UnifiedStoryParser(section).extractVisualBible();
    const present = resolveReplayPresent(d);
    if (!vb || !present) { console.log(`${r.id}: no bible or no stored head count — skipped`); continue; }
    const beats = (d.sceneImages || []).filter(s => s.pageNumber > 0).map(s => ({ pageNumber: s.pageNumber, planLine: String(s.outlineExtract || '').replace(/^\s*PLAN:\s*/i, '') }));
    // The light the run decided rides as each page's FIXED line (b.fixed).
    const light = new Map(((jd.light && jd.light.pages) || []).map(p => [p.pageNumber, p]));
    for (const b of beats) { const l = light.get(b.pageNumber); if (l) b.fixed = { timeOfDay: l.timeOfDay, indoor: l.indoor }; }
    const gl = { info() {}, warn() {}, error: (k, m) => console.log(`  [error] ${k}: ${m}`) };
    const res = await decideBriefFields({ beats, visualBible: JSON.parse(JSON.stringify(vb)), bibleSections: null, approvedArc: (d.arcReviewReport && d.arcReviewReport.finalArc) || '', inputData: d, present, gl });
    const st = res.report;
    agg.calls += st.vb.stats.calls + st.population.stats.calls + st.gaze.stats.calls;
    // Compare with the run's after-the-brief decisions.
    const runVb = new Map(((jd.vb && jd.vb.pages) || []).map(p => [p.pageNumber, (p.elements || []).map(e => e.cite)]));
    const runGaze = new Map(((jd.gaze && jd.gaze.pages) || []).map(p => [p.pageNumber, Object.fromEntries((p.characters || []).map(c => [c.name, c.looksAt]))]));
    const runPop = (jd.population && jd.population.byLocation) || {};
    const pageRows = [];
    for (const b of beats) {
      const f = b.jevFixed || {};
      const mine = (f.cites || []).slice().sort();
      const theirs = (runVb.get(b.pageNumber) || []).slice().sort();
      const base = x => String(x).split('.')[0];
      agg.citePages++;
      const sameBase = JSON.stringify(mine.map(base)) === JSON.stringify(theirs.map(base));
      if (sameBase) agg.citeSame++;
      for (const c of mine) { const t = theirs.find(x => base(x) === base(c)); if (t && (c.includes('.') || t.includes('.'))) { agg.lookN++; if (t === c) agg.lookSame++; } }
      const runPopOf = Object.values(runPop).find(v => (v.pages || []).includes(b.pageNumber));
      if (runPopOf && f.population) { agg.popPages++; if (runPopOf.population === f.population) agg.popSame++; }
      const g = runGaze.get(b.pageNumber) || {};
      for (const [name, t] of Object.entries(f.looksAt || {})) {
        if (!(name in g)) continue;
        agg.gazeN++;
        if (base(g[name]) === base(t)) agg.gazeSame++;
      }
      pageRows.push({ pageNumber: b.pageNumber, location: f.location, citesBefore: mine, citesAfter: theirs, population: f.population, populationAfter: runPopOf && runPopOf.population, looksAt: f.looksAt, looksAtAfter: g });
    }
    out.push({ id: r.id, pages: pageRows, stats: { vb: st.vb.stats, population: st.population.stats, gaze: st.gaze.stats }, unlocated: st.unlocated });
    console.log(`${r.id}: ${beats.length} pages, unlocated ${JSON.stringify(st.unlocated)}`);
    for (const p of pageRows) console.log(`  p${p.pageNumber} ${p.location || '-'} cites before [${p.citesBefore}] after [${p.citesAfter}] pop ${p.population}/${p.populationAfter} gaze ${JSON.stringify(p.looksAt)} vs ${JSON.stringify(p.looksAtAfter)}`);
  }
  const pct = (a, b) => (b ? `${a}/${b} (${Math.round(100 * a / b)}%)` : 'n/a');
  console.log(`\nAGREEMENT, before-the-brief vs the run's after-the-brief decisions (both Jev; Jev's own flip rate is ~12% per single call):`);
  console.log(`  cited elements (same set, looks aside): ${pct(agg.citeSame, agg.citePages)} pages`);
  console.log(`  the look, where both cite the element with looks: ${pct(agg.lookSame, agg.lookN)}`);
  console.log(`  population: ${pct(agg.popSame, agg.popPages)} pages`);
  console.log(`  gaze target per character: ${pct(agg.gazeSame, agg.gazeN)}`);
  console.log(`  Jev calls: ${agg.calls}`);
  return { stories: out, agg };
}

(async () => {
  const pool = new Pool({ connectionString: argv.prod ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let result;
  try {
    if (mode === 'checks') result = await checks(pool);
    else if (mode === 'outfit') result = await outfit(pool);
    else if (mode === 'q9') result = await q9(pool);
    else if (mode === 'jev') result = await jev(pool);
    else { console.error('mode: checks | outfit | q9 | jev'); process.exitCode = 2; }
    if (argv.out && result) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
