#!/usr/bin/env node
/**
 * Can Jev inform the re-plan convergence guard? (owner, 2026-09-27)
 *
 * The guard (promptBuilders.replanRoundRegressed) keeps a re-plan round only if
 * the cast/focal must-fix COUNT of its recheck does not rise. This measures
 * three ways Jev (typesafe/jev-1.13, via server/lib/jevAudit.callJev) could
 * give that decision more than a count, on every stored re-plan round:
 *
 *   (a) finding   per model finding (CHECK[n]) the round was given: "is it
 *                 resolved in the new division?" — a finding-level ledger.
 *                 Truth: the recheck (same check number on an overlapping page
 *                 = still there). $0 baseline: "was a named page's line changed?"
 *   (b) pair      old vs new division, "which better answers these must-fix
 *                 findings while keeping every character's coverage?", both
 *                 orders. Truth: the recheck's net must-fix change.
 *   (c) wholecast per whole-cast page (roster holds every commissioned name) of
 *                 every check that asked Q17: "does the instant give all of
 *                 them one shared action?" (WHOLE_CAST_DEF, the planner's own
 *                 definition). Truth: did Q17 name the page.
 *
 * Counter findings (group-page budget, coverage, shot counts, who column) are
 * NOT asked: they are arithmetic over the roster, exact in code already.
 *
 *   node scripts/analysis/eval-jev-replan-guard.js extract [--days=21]
 *   node scripts/analysis/eval-jev-replan-guard.js run   [--reps=3] [--only=finding,pair,wholecast]
 *   node scripts/analysis/eval-jev-replan-guard.js score [--adjudicated=<labels.json>|none]
 *
 * Reading labels (evals/datasets/jev-replan-guard-v1/reading_labels.json,
 * committed, hashed keys): every must-fix finding, the 23 strongest
 * Jev-vs-recheck disagreements among the rest, and every distinct whole-cast
 * plan line, labelled by reading the plan lines against WHOLE_CAST_DEF before
 * the Jev scores were looked at.
 *
 * Reads STAGING_DATABASE_URL and OPENROUTER_API_KEY (--dotenv=<path> to point
 * at a .env outside this checkout). Items and answers are gitignored (story
 * text); metrics.json is committed.
 * see docs/decisions.md 2026-09-27 "Jev for the re-plan guard"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const PB = require('../../server/lib/promptBuilders');
const J = require('../../server/lib/jevAudit');

const mode = process.argv[2];
const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-replan-guard-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-replan-guard');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');

// ───────────────────────── parsing stored text ─────────────────────────

/** Page lines ("Page N: …") of the section that starts at `heading`, up to the next heading. */
function pageLinesAfter(text, headingRe) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex(l => headingRe.test(l.trim()));
  if (at < 0) return null;
  const out = new Map();
  for (const l of lines.slice(at + 1)) {
    if (/^#/.test(l.trim())) break;
    const m = l.trim().match(/^Page\s+(\d+)\s*:\s*(.*)$/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out.size ? out : null;
}

function sectionLines(text, heading) {
  const lines = String(text || '').split('\n');
  const at = lines.findIndex(l => l.trim() === heading);
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#/.test(l.trim())) break;
    if (l.trim()) out.push(l.trim());
  }
  return out;
}

/** A finding line → the structured shape the guard reads (code or check), never its prose. */
function structured(line) {
  const s = String(line || '').trim();
  let m = s.match(/^PLAN\[([A-Z_]+)\]/);
  if (m) return { code: m[1], line: s, pages: PB.findingPages({ line: s }) };
  m = s.match(/^CHECK\[(\d+)\]\s*:?\s*(.*)$/);
  if (m) {
    if (/^no finding\.?$/i.test(m[2].trim())) return null;
    return { check: Number(m[1]), line: s, text: m[2].trim(), pages: PB.findingPages({ line: m[2] }) };
  }
  return null;
}

function parseFindings(lines) {
  return (lines || []).map(structured).filter(Boolean);
}

function divisionFromPagePlan(pagePlan) {
  const out = new Map();
  for (const l of String(pagePlan || '').split('\n')) {
    const m = l.trim().match(/^Page\s+(\d+)\s*:\s*(.*)$/);
    if (m) out.set(Number(m[1]), m[2].replace(/^PLAN:\s*/, '').trim());
  }
  return out.size ? out : null;
}

function overlay(before, replyText) {
  if (!before) return null;
  const after = new Map(before);
  const plan = String(replyText || '').split('---CHANGES---')[0];
  for (const l of plan.split('\n')) {
    const m = l.trim().match(/^Page\s+(\d+)\s*:\s*(.*)$/);
    if (m && after.has(Number(m[1]))) after.set(Number(m[1]), m[2].trim());
  }
  return after;
}

const divText = d => [...d.entries()].sort((a, b) => a[0] - b[0]).map(([n, l]) => `Page ${n}: ${l}`).join('\n');

/** Same finding still there: same code / check number, on an overlapping page (or either names none). */
function stillThere(f, recheck) {
  return recheck.some(r => {
    const same = f.code ? r.code === f.code : (r.check === f.check);
    if (!same) return false;
    if (!f.pages.length || !r.pages.length) return true;
    return r.pages.some(p => f.pages.includes(p));
  });
}

// ───────────────────────── extract ─────────────────────────

function roundsFromStory(id, b) {
  const rounds = [];
  const kept = (b.replanPrompts || []).map(p => ({ round: p.round, prompt: p.prompt, kept: true }));
  const replies = new Map((b.replanReplies || []).map(r => [r.round, r.reply]));
  const disc = (b.discardedRounds || []).map(d => ({ round: d.round, prompt: d.replanPrompt, kept: false, d }));
  const all = [...kept, ...disc].filter(r => r.prompt).sort((x, y) => x.round - y.round);
  const lastKept = Math.max(0, ...kept.map(k => k.round));
  for (const r of all) {
    const before = pageLinesAfter(r.prompt, /^## YOUR PAGE PLAN$/);
    const given = parseFindings([...sectionLines(r.prompt, '## MUST FIX'), ...sectionLines(r.prompt, '## ALSO NOTED')]);
    const mustLines = new Set(sectionLines(r.prompt, '## MUST FIX'));
    let after = null; let recheck = null; let afterSource = null; let recheckSource = null;
    if (!r.kept) {
      after = pageLinesAfter(r.d.recheck?.prompt, /^# THE PAGE PLAN$/); afterSource = 'recheck.prompt';
      if (!after) { after = overlay(before, r.d.replanReply); afterSource = 'before+reply'; }
      recheck = r.d.recheck?.lines || null; recheckSource = 'discarded.recheck';
    } else if (r.round === lastKept) {
      after = pageLinesAfter(b.recheck?.prompt, /^# THE PAGE PLAN$/); afterSource = 'recheck.prompt';
      if (!after) { after = overlay(before, replies.get(r.round)); afterSource = 'before+reply'; }
      recheck = b.recheck?.lines || null; recheckSource = 'report.recheck';
    } else {
      const next = all.find(x => x.round === r.round + 1);
      after = next ? pageLinesAfter(next.prompt, /^## YOUR PAGE PLAN$/) : null; afterSource = 'next.prompt';
      recheck = next ? [...sectionLines(next.prompt, '## MUST FIX'), ...sectionLines(next.prompt, '## ALSO NOTED')] : null;
      recheckSource = 'next.prompt';
    }
    if (!before || !after || !recheck) { console.warn(`skip ${id} r${r.round}: before=${!!before} after=${!!after} recheck=${!!recheck}`); continue; }
    rounds.push({
      roundId: `${id}#r${r.round}`, source: 'story', kept: r.kept, afterSource, recheckSource,
      before: divText(before), after: divText(after),
      changedPages: [...after.keys()].filter(n => before.get(n) !== after.get(n)),
      given: given.map(f => ({ ...f, must: mustLines.has(f.line) })),
      recheck: parseFindings(recheck),
      commissioned: b.cast?.commissioned || [],
    });
  }
  return rounds;
}

function roundFromLab(expId, res) {
  if (!res?.standingPlan || !res?.appliedPlan || !res?.replanSection) return null;
  const rep = res.report || {};
  const recheckLines = rep.recheckFindings || res.recheckFindings;
  if (!recheckLines) return null;
  const before = new Map(res.standingPlan.map(p => [p.pageNumber, p.planLine]));
  const after = new Map(res.appliedPlan.map(p => [p.pageNumber, p.planLine]));
  const mustLines = new Set(sectionLines(res.replanSection, '## MUST FIX'));
  const given = parseFindings([...mustLines, ...sectionLines(res.replanSection, '## ALSO NOTED')]);
  return {
    roundId: `lab${expId}:${res.storyId}`, source: 'lab', kept: rep.guard ? !!rep.guard.kept : null,
    before: divText(before), after: divText(after),
    changedPages: [...after.keys()].filter(n => before.get(n) !== after.get(n)),
    given: given.map(f => ({ ...f, must: mustLines.has(f.line) })),
    recheck: parseFindings(recheckLines),
    commissioned: res.cast?.commissioned || [],
  };
}

/** Whole-cast pages of one check: roster people+covers hold every commissioned name. */
function wholeCastItems(checkId, reply, division, commissioned) {
  if (!reply || !division || !commissioned.length) return [];
  // A check that predates Q17 still has rosters: its whole-cast pages enter
  // unlabelled (q17Fault null) and are labelled by reading (--adjudicated).
  const asked = String(reply).split('\n').some(l => /^\s*17(?:[.):–—-]|\s)/.test(l));
  const roster = PB.parsePlanCheckRoster(reply);
  const q17 = asked ? PB.parsePlanCheck(reply).filter(f => f.check === 17 && !/^no finding/i.test(f.text)) : [];
  const named = new Set(q17.flatMap(f => PB.findingPages({ line: f.text })));
  const want = commissioned.map(n => n.toLowerCase());
  const out = [];
  for (const [n, r] of roster) {
    const inFrame = new Set([...r.people, ...r.covers].map(x => x.toLowerCase()));
    const whole = want.every(w => inFrame.has(w));
    if (!whole && !named.has(n)) continue;
    const line = division.get(n);
    if (!line) continue;
    out.push({ kind: 'wholecast', id: `${checkId}#p${n}`, page: n, planLine: line, names: [...r.people, ...r.covers], rosterWhole: whole, q17Fault: asked ? named.has(n) : null });
  }
  return out;
}

async function extract() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const days = Number(argv.days || 21);
  const items = [];
  const rounds = [];
  const stories = await pool.query(`SELECT id, data->'beatsReviewReport' b FROM stories
    WHERE created_at > now() - ($1 || ' days')::interval AND data ? 'beatsReviewReport' ORDER BY created_at`, [String(days)]);
  for (const { id, b } of stories.rows) {
    if (!b) continue;
    rounds.push(...roundsFromStory(id, b));
    const comm = b.cast?.commissioned || [];
    const first = divisionFromPagePlan((b.briefsIn || []).map(x => `Page ${x.pageNumber}: ${x.brief}`).join('\n'));
    items.push(...wholeCastItems(`${id}:check1`, b.checkReply, first, comm));
    if (b.recheck?.reply) items.push(...wholeCastItems(`${id}:recheck`, b.recheck.reply, pageLinesAfter(b.recheck.prompt, /^# THE PAGE PLAN$/), comm));
    for (const d of b.discardedRounds || []) {
      if (d.recheck?.reply) items.push(...wholeCastItems(`${id}:disc${d.round}`, d.recheck.reply, pageLinesAfter(d.recheck.prompt, /^# THE PAGE PLAN$/), comm));
    }
  }
  const labs = await pool.query(`SELECT id, results FROM testlab_experiments
    WHERE stage = 'beats_replan' AND status = 'completed' AND created_at > now() - ($1 || ' days')::interval ORDER BY id`, [String(days)]);
  for (const { id, results } of labs.rows) {
    for (const res of results || []) {
      const r = roundFromLab(id, res);
      if (r) rounds.push(r);
      const comm = res?.cast?.commissioned || [];
      if (res?.standingPlan) items.push(...wholeCastItems(`lab${id}:${res.storyId}:check`, res.checkRawResponse, new Map(res.standingPlan.map(p => [p.pageNumber, p.planLine])), comm));
      if (res?.appliedPlan) items.push(...wholeCastItems(`lab${id}:${res.storyId}:recheck`, res.recheckRawResponse, new Map(res.appliedPlan.map(p => [p.pageNumber, p.planLine])), comm));
    }
  }
  await pool.end();

  // A round whose stored before and after divisions are identical cannot be
  // measured: older rows kept neither the reply nor the rechecked plan, so the
  // "after" is a copy of the "before" and every recheck difference is noise.
  const skipped = rounds.filter(r => !r.changedPages.length);
  for (const r of skipped) console.warn(`skip ${r.roundId}: no page differs between the stored before and after divisions`);
  for (const r of rounds.filter(x => x.changedPages.length)) {
    const changed = new Set(r.changedPages);
    for (const f of r.given) {
      if (f.check == null) continue; // counters are exact in code — never asked
      items.push({
        kind: 'finding', id: `${r.roundId}|${f.line.slice(0, 60)}`, roundId: r.roundId, check: f.check, must: f.must,
        line: f.line, text: f.text, pages: f.pages,
        beforeNamed: r.before.split('\n').filter(l => f.pages.includes(Number((l.match(/^Page (\d+)/) || [])[1]))).join('\n'),
        after: r.after,
        namedPageChanged: f.pages.some(p => changed.has(p)),
        recheckResolved: !stillThere(f, r.recheck),
      });
    }
    const must = r.given.filter(f => f.must);
    if (!must.length) continue;
    const resolved = must.filter(f => !stillThere(f, r.recheck)).length;
    const givenKeys = new Set(r.given.map(PB.replanFindingKey));
    const minted = r.recheck.filter(f => PB.replanRank(f) === 'must' && !givenKeys.has(PB.replanFindingKey(f)) && !stillThere(f, r.given)).length;
    const conv = x => PB.countsTowardConvergence(x);
    const guard = PB.replanRoundRegressed({ findings: r.given.filter(f => f.must) }, { findings: r.recheck }, r.changedPages, { round: Number((r.roundId.match(/#r(\d+)/) || [0, 1])[1]) });
    items.push({
      kind: 'pair', id: r.roundId, roundId: r.roundId, source: r.source, kept: r.kept,
      before: r.before, after: r.after, mustLines: must.map(f => f.line), commissioned: r.commissioned,
      changedPages: r.changedPages,
      gt: { mustGiven: must.length, resolved, minted, net: resolved - minted,
        convBefore: must.filter(conv).length, convAfter: r.recheck.filter(conv).length, guardDiscard: guard.discard },
    });
  }
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const count = k => items.filter(x => x.kind === k).length;
  console.log(`${rounds.length} rounds; items: finding ${count('finding')}, pair ${count('pair')}, wholecast ${count('wholecast')} → ${path.relative(ROOT, ITEMS)}`);
}

// ───────────────────────── questions ─────────────────────────
// Generic wording only — no names or plots from a test story.

function requests(it) {
  if (it.kind === 'finding') {
    const state = `THE EARLIER PLAN, the page(s) the problem names:\n${it.beforeNamed || '(the problem names no single page)'}\n\nTHE REVISED PLAN, every page:\n${it.after}`;
    return [
      { variant: 'fixed', state, questions: { Q: { type: 'noul', instructions: `A reviewer raised this problem about the earlier plan: «${it.text}» In the revised plan this problem is fixed.` } } },
      { variant: 'still', state, questions: { Q: { type: 'noul', instructions: `A reviewer raised this problem about the earlier plan: «${it.text}» The revised plan still has this problem.` } } },
    ];
  }
  if (it.kind === 'pair') {
    const q = (a, b) => ({
      state: `PLAN A:\n${a}\n\nPLAN B:\n${b}\n\nPROBLEMS THAT MUST BE FIXED (raised about one of the two plans):\n${it.mustLines.join('\n')}\n\nCHARACTERS WHO MUST EACH KEEP THEIR PAGES: ${it.commissioned.join(', ')}`,
      questions: { Q: { type: 'choice', instructions: 'Which plan has fewer of the listed problems, while every listed character keeps their pages in frame and their own action?', criteria: { A: 'Plan A', B: 'Plan B' } } },
    });
    return [{ variant: 'oldA', ...q(it.before, it.after) }, { variant: 'newA', ...q(it.after, it.before) }];
  }
  if (it.kind === 'wholecast') {
    const state = `A picture plan line (shot — who is in frame — the instant the picture shows — what is true after):\n${it.planLine}`;
    return [
      { variant: 'shared', state, questions: { Q: { type: 'noul', instructions: `The instant gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}` } } },
      { variant: 'fault', state, questions: { Q: { type: 'noul', instructions: 'In the instant, the characters in frame only stand, gather or are shown together, or one of them acts while the others look on or do something else.' } } },
    ];
  }
  throw new Error(`unknown kind ${it.kind}`);
}

async function callWithRetry(req) {
  for (let attempt = 0; ; attempt++) {
    try { return await J.callJev(req); } catch (e) {
      if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message) || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function run() {
  const items = fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse);
  const reps = Number(argv.reps || 3);
  const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const done = new Set(fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return `${a.id}|${a.variant}|${a.rep}`; }) : []);
  const tasks = [];
  for (const it of items) {
    if (only && !only.has(it.kind)) continue;
    if (argv.mustOnly && it.kind === 'finding' && !it.must) continue;
    for (const rq of requests(it)) for (let rep = 0; rep < reps; rep++) {
      if (!done.has(`${it.id}|${rq.variant}|${rep}`)) tasks.push({ it, rq, rep });
    }
  }
  console.log(`${tasks.length} calls to make`);
  const out = fs.createWriteStream(ANSWERS, { flags: 'a' });
  let next = 0; let cost = 0;
  await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, async () => {
    while (next < tasks.length) {
      const { it, rq, rep } = tasks[next++];
      const r = await callWithRetry({ state: rq.state, questions: rq.questions });
      cost += r.cost;
      const a = r.answers.Q;
      out.write(JSON.stringify({ id: it.id, kind: it.kind, variant: rq.variant, rep, noul: a.noul ?? null, choice: a.choice ?? null, probabilities: a.probabilities ?? null, cost: r.cost }) + '\n');
    }
  }));
  out.end();
  console.log(`done, $${cost.toFixed(5)}`);
}

// ───────────────────────── score ─────────────────────────

function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return +(s / (pos.length * neg.length)).toFixed(3);
}

function prf(rows, thr, positive) {
  // rows: {p, y} — predicts positive when p >= thr
  const tp = rows.filter(r => r.p >= thr && r.y === positive).length;
  const fp = rows.filter(r => r.p >= thr && r.y !== positive).length;
  const fn = rows.filter(r => r.p < thr && r.y === positive).length;
  return { thr, tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const labelKey = k => (String(k).startsWith('line:') ? `line:${hash(String(k).slice(5))}` : hash(k));

function score() {
  const items = fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse);
  const answers = fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').map(JSON.parse);
  // Reading labels, keyed by a hash of the item id (findings) or of the plan
  // line (whole-cast), so the committed file carries no story text.
  const labelsFile = argv.adjudicated === 'none' ? null : (argv.adjudicated || path.join(DATASET_DIR, 'reading_labels.json'));
  const adjRaw = labelsFile ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};
  const adj = new Proxy(adjRaw, { has: (t, k) => labelKey(k) in t, get: (t, k) => t[labelKey(k)] });
  const byKey = new Map();
  for (const a of answers) {
    const k = `${a.id}|${a.variant}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(a);
  }
  const metrics = { run: path.basename(RUN_DIR), calls: answers.length, cost: +answers.reduce((s, a) => s + (a.cost || 0), 0).toFixed(5), kinds: {} };
  const THR = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  // flip rate: an item×variant whose reps land on both sides of 0.5 (noul) or on two choices
  const flips = kind => {
    const ks = [...byKey.entries()].filter(([, as]) => as[0].kind === kind);
    const flipped = ks.filter(([, as]) => kind === 'pair'
      ? new Set(as.map(a => a.choice)).size > 1
      : new Set(as.map(a => a.noul >= 0.5)).size > 1).length;
    const spread = ks.map(([, as]) => kind === 'pair'
      ? Math.max(...as.map(a => a.probabilities?.A ?? 0)) - Math.min(...as.map(a => a.probabilities?.A ?? 0))
      : Math.max(...as.map(a => a.noul)) - Math.min(...as.map(a => a.noul)));
    return { groups: ks.length, flipped, maxSpread: +Math.max(0, ...spread).toFixed(3), meanSpread: ks.length ? +mean(spread).toFixed(4) : null };
  };
  const pOf = (id, variant) => { const as = byKey.get(`${id}|${variant}`); return as ? mean(as.map(a => a.noul)) : null; };

  // (a) finding
  {
    const its = items.filter(i => i.kind === 'finding' && byKey.has(`${i.id}|fixed`));
    // Three truths, all reported. `recheck`: the recheck's verdict as stored.
    // `rule`: a finding of a PAGE-LOCAL check (it judges the named page's own
    // line) whose named pages are byte-identical before and after is still
    // there — a recheck calling it resolved is the checker disagreeing with
    // itself (replanRoundRegressed's own noise rule); otherwise the recheck.
    // `corrected`: `rule` plus the reading labels in --adjudicated. The reading
    // covered every must-fix finding and the strongest Jev-vs-recheck
    // disagreements, so `corrected` leans toward Jev; `rule` does not.
    const PAGE_LOCAL = new Set([1, 3, 5, 9, 10, 14, 15, 16, 17]);
    const byRule = i => ((PAGE_LOCAL.has(i.check) && i.pages.length && !i.namedPageChanged) ? false : i.recheckResolved);
    const truths = { recheck: i => i.recheckResolved, rule: byRule, corrected: i => (i.id in adj ? adj[i.id] : byRule(i)) };
    metrics.kinds.finding = { flips: { fixed: flips('finding') }, adjudicated: its.filter(i => i.id in adj).length };
    for (const [truthName, truth] of Object.entries(truths)) {
    const rows = its.map(i => ({ id: i.id, must: i.must, y: truth(i), fixed: pOf(i.id, 'fixed'), still: pOf(i.id, 'still'), changed: i.namedPageChanged }));
    rows.forEach(r => { r.comb = (r.fixed + (1 - r.still)) / 2; });
    const part = sub => {
      const pos = sub.filter(r => r.y), neg = sub.filter(r => !r.y);
      const base = { tp: pos.filter(r => r.changed).length, fp: neg.filter(r => r.changed).length, fn: pos.filter(r => !r.changed).length };
      return {
        n: sub.length, resolved: pos.length, unresolved: neg.length,
        auc: { fixed: auc(pos.map(r => r.fixed), neg.map(r => r.fixed)), still_inverted: auc(pos.map(r => 1 - r.still), neg.map(r => 1 - r.still)), combined: auc(pos.map(r => r.comb), neg.map(r => r.comb)) },
        // positive class = RESOLVED (what a guard would accept on)
        byThreshold: THR.map(t => prf(sub.map(r => ({ p: r.comb, y: r.y })), t, true)),
        changedPageBaseline: { ...base, precision: base.tp + base.fp ? +(base.tp / (base.tp + base.fp)).toFixed(3) : null, recall: base.tp + base.fn ? +(base.tp / (base.tp + base.fn)).toFixed(3) : null },
        // does Jev add anything beyond "the page changed"? AUC inside the changed-page subset
        withinChanged: (() => {
          const ch = sub.filter(r => r.changed);
          const cp = ch.filter(r => r.y), cn = ch.filter(r => !r.y);
          return { n: ch.length, resolved: cp.length, auc: auc(cp.map(r => r.comb), cn.map(r => r.comb)), byThreshold: THR.map(t => prf(ch.map(r => ({ p: r.comb, y: r.y })), t, true)) };
        })(),
      };
    };
    metrics.kinds.finding[truthName] = { all: part(rows), mustFix: part(rows.filter(r => r.must)) };
    // A finding id carries the finding's text, so the committed rows carry its hash.
    if (truthName === 'corrected') metrics.kinds.finding.rows = rows.map(r => ({ id: hash(r.id), y: r.y, must: r.must, changed: r.changed, fixed: +r.fixed.toFixed(3), still: +r.still.toFixed(3) }));
    }
  }
  // (b) pair
  {
    const its = items.filter(i => i.kind === 'pair' && byKey.has(`${i.id}|oldA`));
    const rows = its.map(i => {
      const pNewOldA = mean(byKey.get(`${i.id}|oldA`).map(a => a.probabilities?.B ?? (a.choice === 'B' ? 1 : 0)));
      const pNewNewA = mean(byKey.get(`${i.id}|newA`).map(a => a.probabilities?.A ?? (a.choice === 'A' ? 1 : 0)));
      const truth = i.id in adj ? adj[i.id] : (i.gt.net > 0 ? 'new' : i.gt.net < 0 ? 'old' : 'tie');
      return { id: i.id, truth, net: i.gt.net, guardDiscard: i.gt.guardDiscard, pNewOldA: +pNewOldA.toFixed(3), pNewNewA: +pNewNewA.toFixed(3), pNew: +((pNewOldA + pNewNewA) / 2).toFixed(3), orderAgree: (pNewOldA >= 0.5) === (pNewNewA >= 0.5) };
    });
    const decided = rows.filter(r => r.truth !== 'tie');
    metrics.kinds.pair = {
      n: rows.length, decided: decided.length,
      accuracy: decided.length ? +(decided.filter(r => (r.pNew >= 0.5) === (r.truth === 'new')).length / decided.length).toFixed(3) : null,
      guardAccuracy: decided.length ? +(decided.filter(r => (!r.guardDiscard) === (r.truth === 'new')).length / decided.length).toFixed(3) : null,
      auc: auc(decided.filter(r => r.truth === 'new').map(r => r.pNew), decided.filter(r => r.truth === 'old').map(r => r.pNew)),
      orderConsistent: rows.filter(r => r.orderAgree).length,
      positionBias: { meanPA_whenOldIsA: +mean(rows.map(r => 1 - r.pNewOldA)).toFixed(3), meanPA_whenNewIsA: +mean(rows.map(r => r.pNewNewA)).toFixed(3) },
      flips: flips('pair'),
      rows,
    };
  }
  // (c) wholecast — positive class = FAULT (Q17 named the page)
  {
    const its = items.filter(i => i.kind === 'wholecast' && byKey.has(`${i.id}|shared`));
    // One row per distinct plan line: the same line is judged by several checks.
    const byLine = new Map();
    for (const i of its) { if (!byLine.has(i.planLine)) byLine.set(i.planLine, []); byLine.get(i.planLine).push(i); }
    const lines = [...byLine.entries()].map(([line, is]) => {
      const checkerLabels = is.map(i => i.q17Fault).filter(v => v != null);
      const first = is[0];
      return {
        id: first.id, line, checks: checkerLabels.length,
        checker: checkerLabels.length ? checkerLabels.filter(Boolean).length * 2 > checkerLabels.length : null,
        checkerDisagrees: new Set(checkerLabels).size > 1,
        reading: `line:${line}` in adj ? adj[`line:${line}`] : null,
        faultP: +(((1 - pOf(first.id, 'shared')) + pOf(first.id, 'fault')) / 2).toFixed(3),
        shared: +pOf(first.id, 'shared').toFixed(3), fault: +pOf(first.id, 'fault').toFixed(3),
      };
    });
    const view = key => {
      const ls = lines.filter(r => r[key] != null);
      const pos = ls.filter(r => r[key]), neg = ls.filter(r => !r[key]);
      return {
        n: ls.length, faults: pos.length, clean: neg.length,
        auc: { combined: auc(pos.map(r => r.faultP), neg.map(r => r.faultP)), shared_inverted: auc(pos.map(r => 1 - r.shared), neg.map(r => 1 - r.shared)), fault: auc(pos.map(r => r.fault), neg.map(r => r.fault)) },
        byThreshold: THR.map(t => prf(ls.map(r => ({ p: r.faultP, y: r[key] })), t, true)),
      };
    };
    metrics.kinds.wholecast = {
      judgements: its.length, distinctLines: lines.length,
      checkerDisagreesWithItself: lines.filter(r => r.checkerDisagrees).length,
      vsChecker: view('checker'),
      vsReading: view('reading'),
      readingVsChecker: (() => { const both = lines.filter(r => r.checker != null && r.reading != null); return { n: both.length, agree: both.filter(r => r.checker === r.reading).length }; })(),
      flips: { shared: flips('wholecast') },
      rows: lines.map(r => ({ id: r.id, checker: r.checker, checks: r.checks, checkerDisagrees: r.checkerDisagrees, reading: r.reading, faultP: r.faultP, shared: r.shared, fault: r.fault })),
    };
  }
  fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), JSON.stringify(metrics, null, 1));
  const brief = JSON.parse(JSON.stringify(metrics));
  for (const k of Object.values(brief.kinds)) delete k.rows;
  console.log(JSON.stringify(brief, null, 1));
}

const MODES = { extract, run, score };
if (!MODES[mode]) { console.error('mode: extract | run | score'); process.exit(1); }
Promise.resolve().then(() => MODES[mode]()).catch(e => { console.error(e.stack || e.message); process.exit(1); });
