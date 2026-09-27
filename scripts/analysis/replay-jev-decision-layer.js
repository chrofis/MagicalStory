#!/usr/bin/env node
/**
 * REPLAY the Jev decision layer's PRODUCTION functions (server/lib/jevDecisions.js)
 * on the stored eval datasets and score them against the committed reading
 * labels (rung 1 of the validation ladder: stored data, Jev calls only,
 * ~$0.00012 a call, no paid model call).
 *
 * Why this exists: the evals measured each decision with the STORY TEXT in the
 * state where the text existed. In production the decisions run before the
 * text is written (arc + plan only, the page marked), and they run through the
 * production module — this measures exactly what ships.
 *
 *   node scripts/analysis/replay-jev-decision-layer.js shots --items=<jev-shot-budget-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js cuts  --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js light --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js vb    --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js pop   --items=<jev-shot-budget-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js gaze  --items=<jev-extra-fields-v1 items.jsonl>
 *   [--dotenv=<path>] [--only=<story id,…>] [--out=<file.json>]
 *
 * Items are gitignored (story text); the reading labels are committed.
 * see docs/decisions.md 2026-09-27 "Jev decision layer wired"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const JD = require('../../server/lib/jevDecisions');
const SV = require('../../server/lib/shotVocabulary');

const mode = process.argv[2];
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const loadItems = () => fs.readFileSync(argv.items, 'utf8').trim().split('\n').map(JSON.parse);
const labelsOf = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const only = argv.only ? new Set(String(argv.only).split(',')) : null;
const P = SV.PLAN_SHOT_PLACEHOLDER;
const totals = { calls: 0, costUsd: 0, retries: 0, failed: 0, errors: [] };
const addStats = s => { totals.calls += s.calls; totals.costUsd += s.costUsd; totals.retries += s.retries; totals.failed += s.failed; totals.errors.push(...s.errors); };

async function shots() {
  const L = labelsOf('evals/datasets/jev-shot-budget-v1/reading_labels.json');
  const stories = loadItems().filter(i => i.kind === 'story' && (!only || only.has(i.id)));
  let n = 0; let ok = 0; let best = 0; let viol = 0; let groupNotWider = 0; let groupN = 0;
  const rows = [];
  for (const st of stories) {
    const pages = st.pages.map(p => ({ pageNumber: p.page, planLine: `${P} — ${p.line}` }));
    // Head count: the reading's group flag stands in for planCounters' `present`
    // (the eval's --readingGroup); the state never sees these names.
    const present = new Map(st.pages.map(p => {
      const l = L[hash(`shot:${st.id}:${p.page}`)];
      const count = l && l.group ? Math.max(4, p.roster.length) : Math.min(p.roster.length, 3);
      return [p.page, Array.from({ length: count }, (_, k) => p.roster[k] || `figure${k}`)];
    }));
    const d = await JD.decideShots({ arc: st.arc, pages, present });
    addStats(d.stats);
    viol += d.violations.length;
    d.shots.forEach((s, i) => {
      const l = L[hash(`shot:${st.id}:${st.pages[i].page}`)];
      if (!l) return;
      n++; if (l.ok.includes(s)) ok++; if (l.best === s) best++;
      if (l.group) { groupN++; if (!SV.GROUP_WIDER_SHOTS.includes(s)) groupNotWider++; }
    });
    rows.push({ story: st.id, shots: d.shots.join(' '), violations: d.violations, unmet: d.unmet });
    console.log(`${st.id}: ${d.violations.length ? d.violations.join(',') : 'clean'} ${d.shots.map((s, i) => `p${st.pages[i].page}:${s}`).join(' ')}`);
  }
  return { mode: 'shots', books: stories.length, pages: n, acceptable: +(ok / n).toFixed(3), best: +(best / n).toFixed(3), ruleViolations: viol, groupPagesNotWider: `${groupNotWider}/${groupN}`,
    measuredEval: { acceptable: 0.918, readingGroupAcceptable: 0.938, best: 0.615, violations: 0 }, rows };
}

/**
 * The group-page cut on the over-budget books of the decision-layer eval.
 * Present per page: the group items' rosters for the group pages; the other
 * pages' who columns matched against the book's commissioned names (the
 * replay has no plan-check roster). No obstacle / focal / main data is stored
 * with the items, so those constraints are not exercised here — the coverage
 * floor is.
 */
async function cuts() {
  const L = labelsOf('evals/datasets/jev-decision-layer-v1/reading_labels.json');
  const { castCoverage } = require('../../server/lib/castCoverage');
  const { parsePlanLine, rosterOf } = require('./eval-jev-decision-layer');
  const gp = loadItems().filter(i => i.kind === 'grouppage' && i.overBudget && (!only || only.has(i.story)));
  const stories = [...new Set(gp.map(i => i.story))];
  const out = []; let pagesCut = 0; let pagesCutReadingCut = 0; let removed = 0; let removedNotNeeded = 0; let removedUnlabelled = 0;
  for (const sid of stories) {
    const its = gp.filter(i => i.story === sid);
    const names = [...new Set(its.flatMap(i => i.roster))];
    const pages = its[0].planText.split('\n').map(l => { const m = l.match(/^Page (\d+): (.*)$/); return m && { pageNumber: Number(m[1]), planLine: `${P} — ${parsePlanLine(m[2]).who} — ${parsePlanLine(m[2]).instant} — ${parsePlanLine(m[2]).after}` }; }).filter(Boolean);
    const present = new Map(pages.map(p => [p.pageNumber, rosterOf(parsePlanLine(its[0].planText.split('\n').find(l => l.startsWith(`Page ${p.pageNumber}:`)).replace(/^Page \d+: /, '')).who, names)]));
    for (const i of its) present.set(i.page, i.roster);
    const cov = castCoverage({ pageCount: pages.length, castCount: names.length });
    const d = await JD.decideGroupCuts({ arc: its[0].arc, pages, present, groupPages: its[0].groupPages, budget: its[0].budget,
      listed: names, floor: cov ? cov.appearances.min : 0 });
    addStats(d.stats);
    const rows = d.decisions.map(x => {
      const readKeep = L[hash(`gp:${sid}:${x.pageNumber}`)];
      if (!x.keepsGroup && x.remove && x.remove.length) {
        pagesCut++; if (readKeep === false) pagesCutReadingCut++;
        for (const n of x.remove) { removed++; const r = L[hash(`cd:${sid}:${x.pageNumber}:${n}`)]; if (r === false) removedNotNeeded++; if (r == null) removedUnlabelled++; }
      }
      return { page: x.pageNumber, together: x.together, keepsGroup: x.keepsGroup, readingKeep: readKeep ?? null, keep: x.keep || null, remove: x.remove || null, scores: x.scores || null, required: x.required || null, unsatisfiable: x.unsatisfiable || null };
    });
    const after = new Map(present); for (const x of d.decisions) if (x.keep) after.set(x.pageNumber, x.keep);
    const groupAfter = [...after.values()].filter(v => v.length > SV.GROUP_STAGING_MAX).length;
    const coverageAfter = Object.fromEntries(names.map(n => [n, [...after.values()].filter(v => v.includes(n)).length]));
    console.log(`${sid}: budget ${d.budget}, group pages ${d.groupPages.join(',')} → keep ${d.keepGroup.join(',')}; ${rows.filter(r => r.remove).map(r => `p${r.page} −${r.remove.join('/')} (reading ${r.readingKeep === false ? 'cut' : r.readingKeep === true ? 'KEEP' : '?'})`).join('; ')} | group pages after ${groupAfter} | coverage ${JSON.stringify(coverageAfter)} floor ${cov && cov.appearances.min}`);
    out.push({ story: sid, budget: d.budget, groupAfter, budgetMet: groupAfter <= d.budget, coverageAfter, floor: cov && cov.appearances.min, rows });
  }
  return { mode: 'cuts', stories: stories.length, pagesCut, pagesCutThatReadingCuts: pagesCutReadingCut, charactersRemoved: removed, removedReadingNotNeeded: removedNotNeeded, removedUnlabelled,
    budgetMet: `${out.filter(o => o.budgetMet).length}/${out.length}`,
    measuredEval: { togetherInBudget: '7/7 reading-cut pages', neededBelow05: '51 cuts, 0 wrong' }, rows: out };
}

/** Stored eval answers (the text-state run), for "did dropping the text change Jev's answer". */
function evalAnswers() {
  if (!argv.answers) return null;
  const by = new Map();
  for (const a of fs.readFileSync(argv.answers, 'utf8').trim().split('\n').map(JSON.parse)) {
    const k = `${a.id}|${a.variant}`; if (!by.has(k)) by.set(k, []); by.get(k).push(a.answers);
  }
  return by;
}
const modal = xs => { const c = {}; for (const x of xs) if (x != null) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };

/** The page plans of a story, from its per-page items (final plan lines, field 0 → placeholder). */
function storyPages(its) {
  const { parsePlanLine } = require('./eval-jev-decision-layer');
  return its.map(i => { const p = parsePlanLine(i.planLine); return { pageNumber: i.page, planLine: `${P} — ${p.who} — ${p.instant} — ${p.after}` }; })
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

/** timeOfDay / indoor / weather on the four books whose briefs carry the fields. */
async function light() {
  const L = labelsOf('evals/datasets/jev-decision-layer-v1/reading_labels.json');
  const EA = evalAnswers();
  const meta = loadItems().filter(i => i.kind === 'meta' && (!only || only.has(i.story)));
  const T = { time: { n: 0, agreeAd: 0, read: 0, jevRight: 0, adRight: 0, agreeEvalJev: 0, evalN: 0 }, indoor: { n: 0, agreeAd: 0, agreeEvalJev: 0, evalN: 0 }, weather: { n: 0, agreeAd: 0, agreeEvalJev: 0, evalN: 0 } };
  const rows = [];
  for (const sid of [...new Set(meta.map(i => i.story))]) {
    const its = meta.filter(i => i.story === sid);
    const pages = storyPages(its);
    const d = await JD.decideLight({ arc: its[0].arc, pages });
    addStats(d.stats);
    for (const r of d.pages) {
      const it = its.find(i => i.page === r.pageNumber);
      const ad = it.ad; const adIndoor = ad.weather ? ad.weather === 'none' : null;
      const readT = L[hash(`md:${it.id}:timeOfDay`)];
      T.time.n++; if (r.timeOfDay === ad.timeOfDay) T.time.agreeAd++;
      if (readT != null) { T.time.read++; const ok = v => (Array.isArray(readT) ? readT.includes(v) : readT === v); if (ok(r.timeOfDay)) T.time.jevRight++; if (ok(ad.timeOfDay)) T.time.adRight++; }
      if (adIndoor != null) { T.indoor.n++; if (r.indoor === adIndoor) T.indoor.agreeAd++; }
      T.weather.n++; if (r.weatherAdvice === ad.weather) T.weather.agreeAd++;
      const e = EA && EA.get(`${it.id}|q`);
      if (e) {
        const et = modal(e.map(a => a.TIME?.choice)); T.time.evalN++; if (et === r.jevTime) T.time.agreeEvalJev++;
        const ew = modal(e.map(a => a.WEATHER?.choice)); T.weather.evalN++; if (ew === r.weatherAdvice) T.weather.agreeEvalJev++;
        const ei = e.reduce((s, a) => s + a.INDOOR.noul, 0) / e.length >= 0.5; T.indoor.evalN++; if (ei === r.indoor) T.indoor.agreeEvalJev++;
      }
      rows.push({ story: sid, page: r.pageNumber, jev: r.jevTime, time: r.timeOfDay, ad: ad.timeOfDay, indoor: r.indoor, adWeather: ad.weather, weatherAdvice: r.weatherAdvice });
    }
    console.log(`${sid}: ${d.pages.map(r => `p${r.pageNumber}:${r.timeOfDay}${r.indoor ? '/in' : ''}/${r.weatherAdvice}`).join(' ')} | held ${d.clockHeld.length}`);
    console.log(`   AD: ${its.sort((a, b) => a.page - b.page).map(i => `p${i.page}:${i.ad.timeOfDay}/${i.ad.weather}`).join(' ')}`);
  }
  return { mode: 'light', pages: T.time.n, tally: T, measuredEval: { timeAgreeAd: 0.83, indoorAgreeAd: '69/70', weatherAgreeAd: 0.70 }, rows };
}

/** VB membership + aboard on the four books (arc + plan state, no text). */
async function vb() {
  const L = labelsOf('evals/datasets/jev-decision-layer-v1/reading_labels.json');
  const all = loadItems().filter(i => i.kind === 'vbentity' && (!only || only.has(i.story)));
  const T = {}; const rows = [];
  const tally = (type) => (T[type] = T[type] || { n: 0, tp: 0, fp: 0, fn: 0, tn: 0, adTp: 0, adFp: 0, adFn: 0 });
  for (const sid of [...new Set(all.map(i => i.story))]) {
    const its = all.filter(i => i.story === sid).sort((a, b) => a.page - b.page);
    const pages = storyPages(its);
    const coll = { creature: 'animals', secondary: 'secondaryCharacters', object: 'artifacts', vehicle: 'vehicles' };
    const visualBible = { animals: [], secondaryCharacters: [], artifacts: [], vehicles: [] };
    for (const e of its[0].ents) if (coll[e.type]) visualBible[coll[e.type]].push({ id: e.id, name: e.name, label: e.label, species: e.species, description: e.desc });
    const adCited = new Map(its.map(i => [i.page, new Set(i.ents.filter(e => e.adCited).map(e => e.id))]));
    const d = await JD.decideVbAndAboard({ arc: its[0].arc, pages, visualBible, adCited });
    addStats(d.stats);
    for (const r of d.pages) {
      const it = its.find(i => i.page === r.pageNumber);
      const chosen = new Set([...r.elements.map(e => e.id), ...r.overBudget]);
      for (const e of it.ents.filter(x => coll[x.type])) {
        const read = L[hash(`vb:${it.id}:${e.id}`)];
        if (typeof read !== 'boolean') continue;
        const t = tally(e.type); t.n++;
        const j = chosen.has(e.id);
        if (j && read) t.tp++; else if (j && !read) t.fp++; else if (!j && read) t.fn++; else t.tn++;
        if (e.adCited && read) t.adTp++; else if (e.adCited && !read) t.adFp++; else if (!e.adCited && read) t.adFn++;
        if (j !== read) rows.push({ story: sid, page: r.pageNumber, id: e.id, name: e.name, type: e.type, read, jev: j, p: r.scores[e.id], ad: e.adCited });
      }
    }
    console.log(`${sid}: ${d.pages.map(r => `p${r.pageNumber}:[${r.elements.map(e => e.cite).join(',')}]${r.aboard ? `@${r.aboard}` : ''}`).join(' ')}`);
  }
  return { mode: 'vb', tally: T, measuredEval: 'creatures 31/31 at 0.7, vehicles 10/10 at 0.5, secondaries 7/9 at 0.5, objects precision 0.97 recall 0.72 at 0.7 (text state)', misses: rows };
}

/** aboard (per page × vehicle) and population per LOCATION, on the shot eval's field items. */
async function place() {
  const L = labelsOf('evals/datasets/jev-shot-budget-v1/reading_labels.json');
  const items = loadItems();
  const fields = items.filter(i => i.kind === 'fields' && (!only || only.has(i.story)));
  const locs = items.filter(i => i.kind === 'location' && (!only || only.has(i.story)));
  const out = { aboard: { n: 0, jevRight: 0, adRight: 0 }, population: { n: 0, jevRight: 0, adModalRight: 0 }, rows: [] };
  for (const sid of [...new Set([...fields, ...locs].map(i => i.story))]) {
    const its = fields.filter(i => i.story === sid).sort((a, b) => a.page - b.page);
    if (!its.length) continue;
    const { parsePlanLine } = require('./eval-jev-decision-layer');
    const pages = its.map(i => { const p = parsePlanLine(i.planLine); return { pageNumber: i.page, planLine: `${P} — ${p.who} — ${p.instant} — ${p.after}` }; });
    const arc = (locs.find(l => l.story === sid) || {}).arc || '';
    if (its[0].vehicles.length) {
      const visualBible = { vehicles: its[0].vehicles.map(v => ({ id: v.id, name: v.name, description: v.desc })) };
      const d = await JD.decideVbAndAboard({ arc, pages, visualBible });
      addStats(d.stats);
      for (const r of d.pages) {
        const it = its.find(i => i.page === r.pageNumber);
        for (const v of it.vehicles) {
          const read = L[hash(`fld:${it.id}:aboard:${v.id}`)];
          if (typeof read !== 'boolean') continue;
          out.aboard.n++; if ((r.aboard === v.id) === read) out.aboard.jevRight++; if ((it.ad.aboard === v.id) === read) out.aboard.adRight++;
          out.rows.push({ kind: 'aboard', story: sid, page: r.pageNumber, v: v.id, read, jev: r.aboard, p: r.aboardScores[v.id], ad: it.ad.aboard });
        }
      }
    }
    const storyLocs = locs.filter(l => l.story === sid);
    if (storyLocs.length) {
      const allPages = pages.length ? pages : [];
      const locOf = new Map();
      for (const l of storyLocs) for (const n of l.loc.pages) locOf.set(n, l.loc.id);
      const visualBible = { locations: storyLocs.map(l => ({ id: l.loc.id, name: l.loc.name, description: l.loc.desc, setting: l.loc.setting })) };
      const d = await JD.decidePopulation({ arc: storyLocs[0].arc, pages: allPages, visualBible, locOf });
      addStats(d.stats);
      for (const l of storyLocs) {
        const got = d.byLocation[l.loc.id];
        const read = L[hash(`loc:${l.id}`)];
        if (!got || !Array.isArray(read)) continue;
        out.population.n++; if (read.includes(got.population)) out.population.jevRight++;
        const adModal = modal(l.adPop.map(x => x.pop)); if (read.includes(adModal)) out.population.adModalRight++;
        out.rows.push({ kind: 'population', story: sid, loc: l.loc.id, name: l.loc.name, read, jev: got.population, publicP: got.publicP, crowdP: got.crowdP, adModal });
      }
    }
  }
  return { mode: 'place', ...out, measuredEval: { aboard: '9/10', populationPerLocation: '13/13' } };
}

/** looksAt on the extra-fields items (the AD's roster and cited elements, arc + plan state). */
async function gaze() {
  const L = labelsOf('evals/datasets/jev-extra-fields-v1/reading_labels.json');
  const all = loadItems().filter(i => (!only || only.has(i.story)));
  const t = { n: 0, jevRight: 0, adRight: 0 }; const rows = [];
  const adGaze = (it, v) => {
    if (v == null) return null; const s = String(v).trim();
    if (it.ad.characters.some(c => c.name === s)) return s;
    if (/^(away|ahead|down|forward|off|nothing|distance|into the)/i.test(s)) return JD.GAZE_AWAY;
    if (/viewer|camera|reader/i.test(s)) return 'viewer';
    return s.split('.')[0];
  };
  for (const sid of [...new Set(all.map(i => i.story))]) {
    const its = all.filter(i => i.story === sid).sort((a, b) => a.page - b.page);
    const pages = storyPages(its);
    const perPage = its.map(i => ({ pageNumber: i.page, roster: i.ad.characters.map(c => c.name), elements: i.elements, named: i.named || [] }));
    const d = await JD.decideGaze({ arc: its[0].arc, pages, perPage });
    addStats(d.stats);
    for (const r of d.pages) {
      const it = its.find(i => i.page === r.pageNumber);
      for (const c of r.characters) {
        const truth = L[hash(`gaze:${it.id}:${c.name}`)]; if (!truth) continue;
        const ad = adGaze(it, (it.ad.characters.find(x => x.name === c.name) || {}).looksAt);
        t.n++; if (truth.includes(c.looksAt)) t.jevRight++; if (truth.includes(ad)) t.adRight++;
        if (!truth.includes(c.looksAt)) rows.push({ id: it.id, name: c.name, truth, jev: c.looksAt, p: c.p, ad });
      }
    }
    console.log(`${sid}: ${t.jevRight}/${t.n} so far`);
  }
  return { mode: 'gaze', ...t, measuredEval: { G2: '128/139 (text state)', AD: '111/139' }, misses: rows };
}

async function main() {
  const fn = { shots, cuts, light, vb, place, gaze }[mode];
  if (!fn) { console.log('usage: shots | cuts | light | vb | pop | gaze  --items=<items.jsonl>'); return; }
  const t0 = Date.now();
  const res = await fn();
  res.jev = { ...totals, costUsd: +totals.costUsd.toFixed(5), errors: totals.errors.slice(0, 20), failureRate: totals.calls ? +(totals.errors.length / (totals.calls + totals.errors.length)).toFixed(4) : null };
  res.elapsedMs = Date.now() - t0;
  const { rows, ...summary } = res;
  console.log(JSON.stringify(summary, null, 2));
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(res, null, 2));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
