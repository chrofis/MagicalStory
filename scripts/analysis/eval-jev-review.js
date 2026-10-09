#!/usr/bin/env node
/**
 * Jev as a REPLACEMENT reviewer (owner, 2026-10-09). Measures Jev question variants against reading labels on
 * stored staging data. Run folder: evals/runs/2026-10-09_jev-review/ (story text inside is gitignored/GDPR).
 *
 *   node scripts/analysis/eval-jev-review.js mismatch-run   [--reps=1] [--only=A1,A3]
 *   node scripts/analysis/eval-jev-review.js mismatch-score
 *
 * mismatch: per (page, figure absent from the page's picture cast, named in the page text) pair.
 * Variants: A1 noul "acts/speaks visibly", A2 reworded noul, A3 SCORE 3 levels (expected level), A4 per-sentence
 * decomposition (max over the sentences that name the figure), C1 noul centrality, C2 SCORE centrality.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs'); const path = require('path');
const J = require('../../server/lib/jevAudit');
const DIR = path.join(__dirname, '../../evals/runs/2026-10-09_jev-review');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const mode = process.argv[2];

async function callRetry(req) {
  for (let a = 0; ; a++) {
    try { return await J.callJev(req); } catch (e) {
      if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message) || a >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * (a + 1)));
    }
  }
}
async function pool(tasks, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) await fn(tasks[i++]); })); }

// ───────── mismatch variants ─────────
const LV_ACT = ['X is not in the scene on this page: only named, addressed, remembered, wished for or thought of',
  'X is in the scene but does nothing a reader could see: watches, stands, lies there, is carried or looked at',
  'X does or says something on this page that a reader could see in a picture'];
const LV_CENTRAL = ['X is only mentioned, or acts in a small passing way',
  'X takes part in a secondary beat of this page',
  'X is one of the main actors of the central event of the page; a picture of that event would be wrong without X'];
const sub = (s, n) => s.replace(/\bX\b/g, n);
function mismatchRequests(pair, state) {
  const n = pair.figure;
  const out = [
    { variant: 'A1', state, questions: { Q: { type: 'noul', instructions: `${n} does or says something on this page that a reader could see in a picture.` } } },
    { variant: 'A2', state, questions: { Q: { type: 'noul', instructions: `On this page ${n} is in the scene and acts: ${n} moves, handles something, speaks or reacts in front of the others. This is false if ${n} is only named, spoken to, remembered or thought of.` } } },
    { variant: 'A3', state, questions: { Q: { type: 'score', instructions: `Where is ${n} on this page?`, criteria: LV_ACT.map(s => sub(s, n)) } } },
    { variant: 'C1', state, questions: { Q: { type: 'noul', instructions: `${n} is one of the main actors of what happens on this page: the central event of the page could not be pictured correctly without ${n}.` } } },
    { variant: 'C2', state, questions: { Q: { type: 'score', instructions: `How central is ${n} to this page?`, criteria: LV_CENTRAL.map(s => sub(s, n)) } } },
  ];
  pair.sents.forEach((s, i) => out.push({ variant: `A4s${i}`, state: s, questions: { Q: { type: 'noul', instructions: `In this sentence ${n} is the one who acts or speaks (the subject of an act a reader could see), not merely named, addressed or remembered.` } } }));
  return out;
}

async function mismatchRun() {
  const pairs = JSON.parse(fs.readFileSync(path.join(DIR, 'pairs.json'), 'utf8'));
  const stories = JSON.parse(fs.readFileSync(path.join(DIR, 'stories.json'), 'utf8'));
  const file = path.join(DIR, 'mismatch_answers.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return `${a.id}|${a.variant}|${a.rep}`; }) : []);
  const reps = Number(argv.reps || 1); const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const tasks = [];
  for (const p of pairs) {
    const st = stories.find(s => s.id === p.story); const pg = st.pages.find(x => x.pageNumber === p.page);
    for (const rq of mismatchRequests(p, pg.text)) {
      if (only && !only.has(rq.variant.replace(/s\d+$/, ''))) continue;
      for (let rep = 0; rep < reps; rep++) if (!done.has(`${p.id}|${rq.variant}|${rep}`)) tasks.push({ p, rq, rep });
    }
  }
  console.log(tasks.length, 'calls');
  const out = fs.createWriteStream(file, { flags: 'a' }); let cost = 0; let ms = 0;
  await pool(tasks, 6, async ({ p, rq, rep }) => {
    const t0 = Date.now(); const r = await callRetry({ state: rq.state, questions: rq.questions }); ms += Date.now() - t0; cost += r.cost;
    const a = r.answers.Q;
    out.write(JSON.stringify({ id: p.id, variant: rq.variant, rep, noul: a.noul ?? null, probs: a.probabilities ?? null, cost: r.cost, ms: Date.now() - t0 }) + '\n');
  });
  out.end(); console.log(`done $${cost.toFixed(5)} meanLatency ${(ms / Math.max(1, tasks.length)).toFixed(0)}ms`);
}

const auc = (pos, neg) => { if (!pos.length || !neg.length) return null; let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? .5 : 0; return +(s / (pos.length * neg.length)).toFixed(3); };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
function prf(rows, thr) {
  const tp = rows.filter(r => r.p >= thr && r.y).length, fp = rows.filter(r => r.p >= thr && !r.y).length, fn = rows.filter(r => r.p < thr && r.y).length;
  return { thr, tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
}
const expScore = probs => { const ks = Object.keys(probs).map(Number); const tot = ks.reduce((s, k) => s + probs[k], 0) || 1; return ks.reduce((s, k) => s + k * probs[k], 0) / tot / Math.max(1, ks.length - 1); };

function mismatchScore() {
  const pairs = JSON.parse(fs.readFileSync(path.join(DIR, 'pairs.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(DIR, 'mismatch_labels.json'), 'utf8'));
  const ans = fs.readFileSync(path.join(DIR, 'mismatch_answers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const by = new Map();
  for (const a of ans) { const k = `${a.id}|${a.variant}`; if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
  const val = (id, v) => { const as = by.get(`${id}|${v}`); if (!as) return null; return mean(as.map(a => a.noul != null ? a.noul : expScore(a.probs))); };
  const sc = {};
  for (const p of pairs) {
    const s4 = p.sents.map((_, i) => val(p.id, `A4s${i}`)).filter(x => x != null);
    sc[p.id] = { A1: val(p.id, 'A1'), A2: val(p.id, 'A2'), A3: val(p.id, 'A3'), A4: s4.length ? Math.max(...s4) : null, C1: val(p.id, 'C1'), C2: val(p.id, 'C2') };
    sc[p.id].A3A4 = sc[p.id].A3 != null && sc[p.id].A4 != null ? (sc[p.id].A3 + sc[p.id].A4) / 2 : null;
  }
  const THR = [0.3, 0.5, 0.7, 0.8, 0.9];
  const res = { n: pairs.length, definitional: {}, vsFiled: {}, withinPositives_filedVsRest: {} };
  const pos = pairs.filter(p => labels[p.id] === 1), filed = pairs.filter(p => p.filedByAudit && labels[p.id] === 1);
  res.positives = pos.length; res.filedPositives = filed.length;
  for (const v of ['A1', 'A2', 'A3', 'A4', 'A3A4', 'C1', 'C2']) {
    const rows = pairs.map(p => ({ p: sc[p.id][v], y: labels[p.id] === 1 })).filter(r => r.p != null);
    res.definitional[v] = { auc: auc(rows.filter(r => r.y).map(r => r.p), rows.filter(r => !r.y).map(r => r.p)), byThr: THR.map(t => prf(rows, t)) };
    const inPos = pos.map(p => ({ p: sc[p.id][v], y: p.filedByAudit })).filter(r => r.p != null);
    res.withinPositives_filedVsRest[v] = { auc: auc(inPos.filter(r => r.y).map(r => r.p), inPos.filter(r => !r.y).map(r => r.p)), byThr: THR.map(t => prf(inPos, t)) };
    const all = pairs.map(p => ({ p: sc[p.id][v], y: p.filedByAudit })).filter(r => r.p != null);
    res.vsFiled[v] = { auc: auc(all.filter(r => r.y).map(r => r.p), all.filter(r => !r.y).map(r => r.p)), byThr: THR.map(t => prf(all, t)) };
  }
  const flips = {};
  for (const v of ['A1', 'A2', 'A3', 'C1', 'C2']) {
    const g = [...by.entries()].filter(([k, as]) => k.endsWith('|' + v) && as.length > 1);
    flips[v] = { groups: g.length, flipped: g.filter(([, as]) => new Set(as.map(a => (a.noul != null ? a.noul : expScore(a.probs)) >= 0.5)).size > 1).length };
  }
  res.flips = flips; res.calls = ans.length; res.cost = +ans.reduce((s, a) => s + a.cost, 0).toFixed(5);
  fs.writeFileSync(path.join(DIR, 'mismatch_metrics.json'), JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
}


// ───────── trials: text review of stored staging trial stories (no text review today) ─────────
const AGE_LV = (n) => [`${n} is with a grown-up or other children, or stays where a child of this age normally is, and does nothing risky`,
  `${n} is away from a grown-up for a short stretch, or does something a little risky, that a parent would probably still allow`,
  `${n} is out of sight of any grown-up in a place or doing a physically dangerous thing, that a parent would not allow at this age`];
async function trialsRun() {
  const trials = JSON.parse(fs.readFileSync(path.join(DIR, 'trials.json'), 'utf8'));
  const file = path.join(DIR, 'trials_answers.jsonl');
  const out = fs.createWriteStream(file, { flags: 'a' });
  let cost = 0; const timing = [];
  for (const tr of trials) {
    const t0 = Date.now();
    // 1) the wired source as it would run on a trial: slop + logic per page (no plan lines on a trial)
    const src = await J.runJevTextSource({ language: tr.lang }, tr.pages.map(p => ({ pageNumber: p.pageNumber, text: p.text })), { callImpl: callRetry });
    const t1 = Date.now();
    out.write(JSON.stringify({ trial: tr.id, kind: 'source', ok: src.ok, skipped: src.skipped || null, raw: src.raw || '', flags: src.flags || [], mechanical: src.mechanical || [], cost: src.cost || 0, calls: src.calls || 0, ms: t1 - t0 }) + '\n');
    cost += src.cost || 0;
    // 2) age-safety per page for every character aged <= 9: score + decomposed
    const tasks = [];
    for (const ch of tr.characters.filter(c => Number(c.age) <= 9)) for (const pg of tr.pages) {
      const n = ch.name; const a = Number(ch.age);
      const nameIn = pg.text.includes(n);
      if (!nameIn) continue;
      const base = { trial: tr.id, kind: 'age', page: pg.pageNumber, name: n, age: a };
      tasks.push({ ...base, variant: 'S1', state: pg.text, questions: { Q: { type: 'noul', instructions: `On this page ${n}, a ${a}-year-old child, goes off alone away from any grown-up, or does something physically dangerous, that a parent would not allow at that age.` } } });
      tasks.push({ ...base, variant: 'S2', state: pg.text, questions: { Q: { type: 'score', instructions: `How safe is it for a ${a}-year-old child that ${n} does what this page tells?`, criteria: AGE_LV(n) } } });
      tasks.push({ ...base, variant: 'D1', state: pg.text, questions: { Q: { type: 'noul', instructions: `A grown-up is with ${n} in this scene.` } } });
      tasks.push({ ...base, variant: 'D2', state: pg.text, questions: { Q: { type: 'noul', instructions: `${n} travels from one place to another outdoors on this page.` } } });
      tasks.push({ ...base, variant: 'D3', state: pg.text, questions: { Q: { type: 'noul', instructions: `${n} climbs up high, goes near deep water, a road or a fire, or handles something sharp or heavy on this page.` } } });
      tasks.push({ ...base, variant: 'D4', state: pg.text, questions: { Q: { type: 'noul', instructions: `The ideas and words on this page are too hard for a ${a}-year-old listening to it read aloud.` } } });
    }
    let i = 0; const t2 = Date.now();
    await pool(tasks, 6, async (tk) => {
      const r = await callRetry({ state: tk.state, questions: tk.questions }); cost += r.cost;
      const a = r.answers.Q;
      out.write(JSON.stringify({ trial: tk.trial, kind: tk.kind, page: tk.page, name: tk.name, age: tk.age, variant: tk.variant, noul: a.noul ?? null, probs: a.probabilities ?? null, cost: r.cost }) + '\n');
    });
    // 3) text-vs-picture-cast pairs, variant A3 (score) + A1
    const pairs = [];
    for (const pg of tr.pages) {
      const pc = tr.pictureCast[pg.pageNumber] || [];
      for (const n of tr.allCast) if (!pc.includes(n) && (() => { let i = -1; const tx = pg.text; const isL = c => !!c && c.toLowerCase() !== c.toUpperCase(); while ((i = tx.indexOf(n, i + 1)) >= 0) if (!isL(tx[i - 1]) && !isL(tx[i + n.length])) return true; return false; })()) pairs.push({ page: pg.pageNumber, figure: n, text: pg.text });
    }
    await pool(pairs, 6, async (pr) => {
      for (const [variant, q] of [['A1', { type: 'noul', instructions: `${pr.figure} does or says something on this page that a reader could see in a picture.` }], ['A3', { type: 'score', instructions: `Where is ${pr.figure} on this page?`, criteria: LV_ACT.map(s => sub(s, pr.figure)) }]]) {
        const r = await callRetry({ state: pr.text, questions: { Q: q } }); cost += r.cost; const a = r.answers.Q;
        out.write(JSON.stringify({ trial: tr.id, kind: 'pair', page: pr.page, name: pr.figure, variant, noul: a.noul ?? null, probs: a.probabilities ?? null, cost: r.cost }) + '\n');
      }
    });
    timing.push({ trial: tr.id, sourceMs: t1 - t0, sourceCalls: src.calls, extraMs: Date.now() - t2, extraCalls: tasks.length + pairs.length * 2 });
  }
  out.end();
  fs.writeFileSync(path.join(DIR, 'trials_timing.json'), JSON.stringify(timing, null, 1));
  console.log('done', cost.toFixed(5));
}

// ───────── plan check: per-page Jev questions vs the luna-pro checker's findings ─────────
const PB = require('../../server/lib/promptBuilders');
const stateOf = l => `WHO IS IN FRAME: ${l.who}\nTHE INSTANT THE PICTURE SHOWS: ${l.instant}\nWHAT IS TRUE AFTER THIS PAGE: ${l.after}`;
const lv = (...xs) => xs;
function planRequests(div, n, l, ctx) {
  const st = stateOf(l); const out = [];
  const nouls = (check, variant, text, state = st) => out.push({ check, variant, state, q: { type: 'noul', instructions: text } });
  const score = (check, variant, text, levels, state = st) => out.push({ check, variant, state, q: { type: 'score', instructions: text, criteria: levels } });
  // Q1 emotional highlight
  nouls(1, 'F1', 'The instant shows one character displaying a strong feeling (grief, joy, fear, anger, awe, shame).');
  nouls(1, 'F2', 'Besides a character showing a feeling, the instant also holds another character acting, or an event happening, or a feeling that nobody shows.');
  score(1, 'S', 'What does the instant stage?', lv('no strong feeling is staged', 'one character alone shows a strong feeling, and nothing else competes with it', 'a strong feeling is staged together with a second actor, an event or a feeling nobody shows'));
  // Q3 cast of three or more
  if (ctx.nIn >= 3) {
    nouls(3, 'T1', `The characters in frame all take part in the one action of the instant, by this rule: ${PB.THIRD_CHARACTER_DEF}`);
    nouls(3, 'T2', 'In the instant, at least one of the characters in frame only stands by or watches, or does a second action different from the rest.');
    score(3, 'S', 'How do the characters in frame relate to the action of the instant?', lv('all of them take part in the same one action', 'one of them stands by or does a different second action', 'several of them only stand by, watch or do different things'));
  }
  // Q5 instant states presence/position
  nouls(5, 'P1', 'The instant only states presence or position (stands, is together, is visible, gathered, waits) instead of an action being performed.');
  nouls(5, 'P2', 'The instant describes the state after an action, not the action itself being done.');
  score(5, 'S', 'What does the instant show?', lv('an action being performed at this moment', 'a pose, presence or position with a trace of action', 'only presence, position or the state after an action'));
  // Q9 deed and effect
  nouls(9, 'DE', `The instant shows an action and the result of that action together. ${PB.DEED_AND_EFFECT_DEF}`);
  nouls(9, 'AF', `What is true after this page states no change that the instant does not already show. ${PB.PAGE_CHANGE_DEF}`);
  score(9, 'SDE', 'How many separate actions does the instant show?', lv('one action only', 'one action with its immediate visible result', 'an action together with its result or a following action'));
  score(9, 'SAF', 'What does the field what is true after state?', lv('a new change in the story: something held, moved, opened, broken, learned, decided or agreed', 'a change that is mostly the instant told again', 'no change; it only describes the picture again'));
  // Q10 heights
  nouls(10, 'H', `In the instant, people, animals or objects stand at three or more different heights. ${PB.TWO_HEIGHTS_DEF}`);
  // Q15 opening
  if (n === ctx.first) nouls(15, 'OP', `The instant opens on an action already under way, and each character's first page shows them doing something.`);
  // Q8 ending event
  if (n === ctx.last && ctx.lastSentence) nouls(8, 'LE', 'The instant of this page stages the event told by the last sentence of the story.', `THE LAST SENTENCE OF THE STORY: ${ctx.lastSentence}\n\n${st}`);
  // Q17 whole cast
  if (ctx.whole) nouls(17, 'W', `The instant gives every character in frame one and the same action, by this rule: ${PB.WHOLE_CAST_DEF}`);
  return out.map(o => ({ ...o, id: `${div.id}#p${n}`, key: `${div.id}#p${n}|${o.check}|${o.variant}` }));
}
function lastSentenceOf(arc) { const m = [...String(arc).matchAll(/(?:^|\n)\s*(\d+)\.\s*([^\n]+)/g)]; return m.length ? m[m.length - 1][2].trim() : ''; }
function planContext(div, n) {
  const nums = Object.keys(div.lines).map(Number).sort((a, b) => a - b);
  const r = div.roster[n] || { people: [], covers: [] };
  const inFrame = new Set([...(r.people || []), ...(r.covers || [])].map(x => x.toLowerCase()));
  const whole = div.commissioned.length > 1 && div.commissioned.every(c => inFrame.has(c.toLowerCase()));
  return { first: nums[0], last: nums[nums.length - 1], nIn: inFrame.size, whole, lastSentence: lastSentenceOf(div.arc) };
}
async function planRun() {
  const divs = JSON.parse(fs.readFileSync(path.join(DIR, 'plan_divs.json'), 'utf8'));
  const file = path.join(DIR, 'plan_answers.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).key) : []);
  const tasks = [];
  for (const d of divs) for (const n of Object.keys(d.lines).map(Number)) {
    const l = d.lines[n]; if (!l.instant) continue;
    for (const rq of planRequests(d, n, l, planContext(d, n))) if (!done.has(rq.key)) tasks.push(rq);
  }
  console.log(tasks.length, 'calls');
  const out = fs.createWriteStream(file, { flags: 'a' }); let cost = 0; let ms = 0;
  await pool(tasks, 6, async rq => {
    const t0 = Date.now(); const r = await callRetry({ state: rq.state, questions: { Q: rq.q } }); ms += Date.now() - t0; cost += r.cost;
    const a = r.answers.Q; out.write(JSON.stringify({ key: rq.key, id: rq.id, check: rq.check, variant: rq.variant, v: a.noul != null ? a.noul : expScore(a.probabilities), cost: r.cost }) + '\n');
  });
  out.end(); console.log(`done $${cost.toFixed(5)} meanLatency ${(ms / Math.max(1, tasks.length)).toFixed(0)}ms`);
}

// ───────── text audit: STYLE sub-rules (sentence level), PULL / ENDING (page level), first mention (figure level) ─────────
const LV_LOOK = lv('the sentence states no size, colour or look', 'a size or look is stated and the plot turns on it (too heavy to lift, too big to hide)', 'a size, colour or look is stated that the plot does not turn on, so a picture could carry it');
const LV_EXPLAIN = lv('the sentence only tells what happens or what a character says', 'the sentence gives a physical cause of what happens', 'the narrator explains or excuses the act of a character to the reader, or says what an event meant');
function textRequests(S) {
  const out = [];
  for (const st of S.stories) {
    st.pages.forEach(pg => {
      const sents = J.splitSentences(pg.text);
      sents.forEach((s, i) => {
        const id = `${st.id.slice(4, 17)}#p${pg.pageNumber}#s${i}`;
        const prev = i ? sents[i - 1] + ' ' : '';
        const add = (variant, state, q) => out.push({ id, variant, state, q, story: st.id, page: pg.pageNumber, sentence: s });
        add('L1', s, { type: 'noul', instructions: 'The sentence states a size, colour or look of a thing or person, which the plot does not depend on.' });
        add('L3', s, { type: 'score', instructions: 'What does the sentence say about looks?', criteria: LV_LOOK });
        add('L4a', s, { type: 'noul', instructions: 'The sentence states how something looks: its size, colour, shape or texture.' });
        add('L4b', s, { type: 'noul', instructions: 'A fact of the plot turns on this look, such as a thing too heavy for one child to lift or too big to hide.' });
        add('E1', prev + s, { type: 'noul', instructions: 'The narrator explains or excuses the act of a character to the reader, or says what an event meant, instead of showing it.' });
        add('E3', prev + s, { type: 'score', instructions: 'What does the narrator do in the last sentence?', criteria: LV_EXPLAIN });
        add('E4a', s, { type: 'noul', instructions: 'The sentence contains a reason, excuse or purpose for the act of a character (a because-clause or so-that clause), told by the narrator.' });
        add('E4b', s, { type: 'noul', instructions: 'The reason in the sentence is a physical cause of what happens, such as a rope breaking because a knot slipped.' });
      });
    });
  }
  return out;
}
async function textRun() {
  const stories = JSON.parse(fs.readFileSync(path.join(DIR, 'stories.json'), 'utf8'));
  const rq = textRequests({ stories });
  const file = path.join(DIR, 'text_answers.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return a.id + '|' + a.variant; }) : []);
  const tasks = rq.filter(x => !done.has(x.id + '|' + x.variant));
  console.log(tasks.length, 'sentence calls;', new Set(rq.map(x => x.id)).size, 'sentences');
  const out = fs.createWriteStream(file, { flags: 'a' }); let cost = 0;
  await pool(tasks, 6, async tk => {
    const r = await callRetry({ state: tk.state, questions: { Q: tk.q } }); cost += r.cost; const a = r.answers.Q;
    out.write(JSON.stringify({ id: tk.id, variant: tk.variant, v: a.noul != null ? a.noul : expScore(a.probabilities), page: tk.page, story: tk.story }) + '\n');
  });
  out.end(); console.log('done $' + cost.toFixed(5));
}
async function pageRun() {
  const stories = JSON.parse(fs.readFileSync(path.join(DIR, 'stories.json'), 'utf8'));
  const file = path.join(DIR, 'page_answers.jsonl');
  const tasks = [];
  for (const st of stories) {
    const last = Math.max(...st.pages.map(p => p.pageNumber));
    for (const pg of st.pages) {
      const id = `${st.id.slice(4, 17)}#p${pg.pageNumber}`;
      tasks.push({ id, variant: 'PU1', state: pg.text, q: { type: 'noul', instructions: 'The last sentence of the page leaves a question, a threat or an action open, which the next page answers.' } });
      tasks.push({ id, variant: 'PU3', state: pg.text, q: { type: 'score', instructions: 'How does the page end?', criteria: lv('on a closed statement or a resolved action, with nothing left for the next page to answer', 'on a small open detail', 'on an open question, threat or unfinished action that the next page must answer') } });
      if (pg.pageNumber === last) {
        tasks.push({ id, variant: 'EN1', state: pg.text, q: { type: 'noul', instructions: 'The closing sentence sums up what the story meant or what the characters have become, or ends on a narrator statement instead of a concrete act or spoken line.' } });
        tasks.push({ id, variant: 'EN3', state: pg.text, q: { type: 'score', instructions: 'How does the last page end?', criteria: lv('on a concrete act or spoken line that lands one plain feeling', 'on a concrete act, but no feeling lands', 'on a narrator summary of the meaning, or a string of solemn statements') } });
      }
    }
  }
  console.log(tasks.length, 'page calls');
  const out = fs.createWriteStream(file, { flags: 'a' }); let cost = 0;
  await pool(tasks, 6, async tk => { const r = await callRetry({ state: tk.state, questions: { Q: tk.q } }); cost += r.cost; const a = r.answers.Q; out.write(JSON.stringify({ id: tk.id, variant: tk.variant, v: a.noul != null ? a.noul : expScore(a.probabilities) }) + '\n'); });
  out.end(); console.log('done $' + cost.toFixed(5));
}
async function mentionRun() {
  const stories = JSON.parse(fs.readFileSync(path.join(DIR, 'stories.json'), 'utf8'));
  const isL = c => !!c && c.toLowerCase() !== c.toUpperCase();
  const has = (tx, n) => { let i = -1; while ((i = tx.indexOf(n, i + 1)) >= 0) if (!isL(tx[i - 1]) && !isL(tx[i + n.length])) return i; return -1; };
  const tasks = [];
  for (const st of stories) for (const n of st.allCast) {
    const pgs = st.pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
    const k = pgs.findIndex(p => has(p.text, n) >= 0); if (k < 0) continue;
    const upto = pgs.slice(0, k + 1).map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
    const id = `${st.id.slice(4, 17)}#p${pgs[k].pageNumber}#${n}`;
    tasks.push({ id, story: st.id, page: pgs[k].pageNumber, name: n, variant: 'M1', state: upto, q: { type: 'noul', instructions: `By the page where ${n} first appears, the reader has been told who ${n} is, or ${n} arrives or is introduced as someone the listener can place.` } });
    tasks.push({ id, story: st.id, page: pgs[k].pageNumber, name: n, variant: 'M3', state: upto, q: { type: 'score', instructions: `On the page where ${n} first appears, how is ${n} introduced?`, criteria: lv(`${n} acts or speaks with no word telling who ${n} is`, `${n} is only named in passing`, `the text tells who ${n} is, or ${n} arrives or is introduced by someone`) } });
  }
  const file = path.join(DIR, 'mention_answers.jsonl'); console.log(tasks.length, 'mention calls');
  const out = fs.createWriteStream(file, { flags: 'a' }); let cost = 0;
  await pool(tasks, 6, async tk => { const r = await callRetry({ state: tk.state, questions: { Q: tk.q } }); cost += r.cost; const a = r.answers.Q; out.write(JSON.stringify({ id: tk.id, name: tk.name, page: tk.page, story: tk.story, variant: tk.variant, v: a.noul != null ? a.noul : expScore(a.probabilities) }) + '\n'); });
  out.end(); console.log('done $' + cost.toFixed(5));
}

const MODES = { 'text-run': textRun, 'page-run': pageRun, 'mention-run': mentionRun, 'plan-run': planRun, 'trials-run': trialsRun, 'mismatch-run': mismatchRun, 'mismatch-score': mismatchScore };
if (!MODES[mode]) { console.error('mode: ' + Object.keys(MODES).join(' | ')); process.exit(1); }
Promise.resolve().then(MODES[mode]).catch(e => { console.error(e.stack || e.message); process.exit(1); });
