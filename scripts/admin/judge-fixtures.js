#!/usr/bin/env node
/**
 * Judge regression fixtures — sync, run and score. Doc: docs/judge-fixtures.md.
 *
 * The fixtures (tests/judge-fixtures/fixtures.json) are mirrored into the Test
 * Lab as one stage-typed set per judge ("Judge fixtures · <judge>", stage
 * `judge_fixture`), so every run is an ordinary Lab experiment the owner can
 * open. This script fires the sets, waits, and prints recall / precision / flip
 * rate per judge with each fixture's verdict in the judge's own words.
 *
 *   node scripts/admin/judge-fixtures.js validate                 # $0, no network
 *   node scripts/admin/judge-fixtures.js sync                     # $0, file → Lab sets
 *   node scripts/admin/judge-fixtures.js run [--judge=semantic,plate_qc] [--repeats=2] [--save=<file>] [--params='{"arm":"AB"}']
 *   node scripts/admin/judge-fixtures.js score --experiments=1601,1602 [--save=<file>]   # $0, re-score stored runs
 *   [--base=https://staging.magicalstory.ch]  [--list]  (list = print the fixtures and exit)
 *
 * `--params` (JSON) rides on every member of the run — a Lab-only variant of
 * the judge such as the sheet_style arms (server/lib/sheetJudgeArms.js); the
 * label carries it, so the Sets tab says which variant each run measured.
 *
 * `run` syncs first. `score` re-reads finished experiments and scores their
 * stored findings against the CURRENT fixture file, so an expectation edited
 * after a run is re-scored without paying for the judges again.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const JF = require('../../server/lib/judgeFixtures');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_FILE = path.join(ROOT, 'tests', 'judge-fixtures', 'fixtures.json');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('base', 'https://staging.magicalstory.ch').replace(/\/$/, '');
const API = `${BASE}/api/admin/testlab`;
const cmd = process.argv[2];

function loadFixtures() {
  const doc = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
  const fixtures = doc.fixtures || [];
  const problems = JF.validateFixtures(fixtures);
  if (problems.length) {
    console.error(`${FIXTURE_FILE}: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  return fixtures;
}

let token = null;
function auth() {
  if (!token) {
    token = execFileSync(process.execPath, [path.join(__dirname, 'get-admin-token.js'), `--base=${BASE}`], { encoding: 'utf8' }).trim();
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function api(method, url, body) {
  const res = await fetch(`${API}${url}`, { method, headers: auth(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) { const e = new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`); e.status = res.status; throw e; }
  return json;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The Lab set member a fixture becomes: target = identity, params = judge + expectation + input. */
function memberFor(f) {
  const target = { storyId: f.target.storyId, fixture: f.id };
  for (const k of ['pageNumber', 'versionIndex', 'character']) if (f.target[k] != null) target[k] = f.target[k];
  // note: why the expected verdict is what it is — shown on the Lab card.
  const params = { judge: f.judge, expect: f.expect, note: f.source };
  const { imageUrl, ...more } = f.input || {};
  if (imageUrl) params.imageUrl = imageUrl;
  if (Object.keys(more).length) params.input = more;
  return { target, params, label: f.id };
}

async function sync(fixtures, judges) {
  const { sets } = await api('GET', '/sets');
  const out = {};
  for (const judge of judges) {
    const mine = fixtures.filter(f => f.judge === judge);
    if (!mine.length) continue;
    const name = JF.setNameFor(judge);
    let set = sets.find(s => s.name === name && s.stage === 'judge_fixture');
    if (!set) set = await api('POST', '/sets', { name, stage: 'judge_fixture', params: { judge } });
    const detail = await api('GET', `/sets/${set.id}`);
    const want = new Set(mine.map(f => f.id));
    for (const m of detail.members || []) {
      if (!want.has(m.target?.fixture)) await api('DELETE', `/sets/${set.id}/members/${m.id}`);
    }
    for (const f of mine) await api('POST', `/sets/${set.id}/members`, memberFor(f));
    out[judge] = { setId: set.id, members: mine.length };
    console.log(`synced ${name} (set #${set.id}): ${mine.length} fixture(s)`);
  }
  return out;
}

async function runSet(setId, label, params) {
  for (let attempt = 0; ; attempt++) {
    try { return (await api('POST', `/sets/${setId}/run`, { label, ...(params ? { params } : {}) })).id; }
    catch (e) {
      if (e.status !== 409 || attempt >= 30) throw e;
      console.log(`  Lab at capacity — waiting 20 s (${label})`);
      await sleep(20000);
    }
  }
}

async function waitFor(expId) {
  for (;;) {
    const e = await api('GET', `/experiments/${expId}`);
    const exp = e.experiment || e;
    if (exp.status !== 'running') return exp;
    await sleep(15000);
  }
}

/** One scored entry per result: the fixture's CURRENT expectation over the stored findings. */
function scoreExperiment(exp, byId) {
  const entries = [];
  for (const r of exp.results || []) {
    const id = r.fixtureId || r.fixture;
    const f = byId.get(id);
    if (!f) { entries.push({ fixtureId: id, judge: r.judge || '?', error: 'fixture no longer in the file' }); continue; }
    if (!r.ok) { entries.push({ fixtureId: id, judge: f.judge, experimentId: exp.id, error: r.error || 'failed' }); continue; }
    const expect = (f.target.pageNumber != null && ['book_audit', 'entity'].includes(f.judge))
      ? { page: Number(f.target.pageNumber), ...f.expect } : f.expect;
    const v = JF.scoreFixture(expect, r.findings || []);
    entries.push({
      fixtureId: id, judge: f.judge, experimentId: exp.id, outcome: v.outcome, expected: v.expected,
      said: v.matched.length ? v.matched.map(m => `[${m.severity || '-'}|${m.type}] ${m.text}`).slice(0, 3)
        : (r.findings || []).slice(0, 4).map(m => `[${m.severity || '-'}|${m.type}] ${m.text}`),
      costUsd: r.cost?.usd ?? null, costBasis: r.cost?.basis ?? null,
    });
  }
  return entries;
}

const pct = (x) => (x == null ? '  —  ' : `${(x * 100).toFixed(0).padStart(3)}%`);
function printReport(entries, meta) {
  const s = JF.summarize(entries);
  console.log('\nPER FIXTURE');
  for (const e of entries) {
    const mark = e.error ? 'ERR' : e.outcome;
    console.log(`  ${mark.padEnd(3)} ${e.judge.padEnd(10)} ${e.fixtureId}${e.experimentId ? `  (Lab #${e.experimentId})` : ''}`);
    if (e.error) console.log(`        error: ${e.error}`);
    else for (const w of e.said) console.log(`        ${w.slice(0, 220)}`);
    if (!e.error && !e.said.length) console.log('        (no findings)');
  }
  console.log('\nPER JUDGE             fixt runs  TP  FN  TN  FP err  recall precision falseAlarm flips');
  const row = (name, j) => console.log(`  ${name.padEnd(18)} ${String(j.fixtures).padStart(4)} ${String(j.runs).padStart(4)} ${[j.tp, j.fn, j.tn, j.fp, j.errors].map(n => String(n).padStart(3)).join(' ')}  ${pct(j.recall)}    ${pct(j.precision)}      ${pct(j.falseAlarmRate)}  ${j.repeated ? `${j.flipped}/${j.repeated}` : '—'}`);
  for (const [name, j] of Object.entries(s.judges)) row(name, j);
  row('ALL', s.overall);
  const cost = entries.reduce((a, e) => a + (e.costUsd || 0), 0);
  console.log(`\ncost ≈ $${cost.toFixed(3)} (per-entry basis in the saved report)`);
  const save = arg('save');
  if (save) {
    fs.mkdirSync(path.dirname(path.resolve(save)), { recursive: true });
    fs.writeFileSync(path.resolve(save), JSON.stringify({ ...meta, costUsd: Number(cost.toFixed(4)), summary: s, entries }, null, 2));
    console.log(`saved ${save}`);
  }
}

(async () => {
  const fixtures = loadFixtures();
  const byId = new Map(fixtures.map(f => [f.id, f]));
  const judgesArg = arg('judge');
  const judges = judgesArg ? judgesArg.split(',').map(s => s.trim()) : JF.JUDGES.filter(j => fixtures.some(f => f.judge === j));
  for (const j of judges) if (!JF.JUDGES.includes(j)) { console.error(`unknown judge ${j}`); process.exit(1); }

  if (cmd === 'validate' || process.argv.includes('--list')) {
    const count = {};
    for (const f of fixtures) count[f.judge] = (count[f.judge] || 0) + 1;
    console.log(`${fixtures.length} fixtures valid:`, JSON.stringify(count));
    if (process.argv.includes('--list')) for (const f of fixtures) console.log(`  ${f.judge.padEnd(10)} ${f.expect.verdict.padEnd(4)} ${f.id}`);
    return;
  }
  if (cmd === 'sync') { await sync(fixtures, judges); return; }
  if (cmd === 'score') {
    const ids = String(arg('experiments', '')).split(',').map(Number).filter(Boolean);
    if (!ids.length) { console.error('--experiments=<id,id> required'); process.exit(1); }
    const entries = [];
    for (const id of ids) entries.push(...scoreExperiment(await waitFor(id), byId));
    printReport(entries, { base: BASE, experiments: ids, scoredAt: new Date().toISOString() });
    return;
  }
  if (cmd === 'run') {
    const repeats = Math.max(1, Math.min(5, parseInt(arg('repeats', '1'), 10) || 1));
    let runParams = null;
    if (arg('params')) {
      try { runParams = JSON.parse(arg('params')); } catch (e) { console.error(`--params is not JSON: ${e.message}`); process.exit(1); }
    }
    const tag = runParams ? ` · ${Object.entries(runParams).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
    const sets = await sync(fixtures, judges);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const jobs = [];
    for (const [judge, s] of Object.entries(sets)) {
      for (let r = 1; r <= repeats; r++) jobs.push({ judge, setId: s.setId, label: `Judge fixtures · ${judge}${tag} · r${r}/${repeats} · ${stamp}` });
    }
    // At most two experiments in flight: the Lab's slots are shared with every
    // other agent's work, and a fixture run is never urgent.
    const expIds = [];
    const queue = [...jobs];
    const worker = async () => {
      while (queue.length) {
        const job = queue.shift();
        const id = await runSet(job.setId, job.label, runParams);
        console.log(`started Lab #${id}: ${job.label}`);
        const exp = await waitFor(id);
        console.log(`finished Lab #${id} (${exp.status}, ${(exp.results || []).length} result(s))`);
        expIds.push(id);
      }
    };
    await Promise.all([worker(), worker()]);
    const entries = [];
    for (const id of expIds.sort((a, b) => a - b)) entries.push(...scoreExperiment(await waitFor(id), byId));
    printReport(entries, { base: BASE, experiments: expIds, repeats, params: runParams, ranAt: new Date().toISOString() });
    return;
  }
  console.error('usage: judge-fixtures.js validate | sync | run [--judge=a,b] [--repeats=N] [--save=f] | score --experiments=a,b [--save=f]');
  process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
