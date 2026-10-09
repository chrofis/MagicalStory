#!/usr/bin/env node
/**
 * Can Jev do the arc panel's job? (owner, 2026-10-09) Measurement harness.
 *   node scripts/analysis/eval-jev-arc-panel.js show <from> <to>   print arcs (no critique, no panel) for reading labels
 *   node scripts/analysis/eval-jev-arc-panel.js panel <from> <to>  print panel findings per model
 * Stored story text lives in the gitignored run folder. see docs/decisions.md (arc panel / Jev)
 */
const fs = require('fs'), path = require('path');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-arc-panel');
const books = JSON.parse(fs.readFileSync(path.join(RUN, 'books.json'))).filter(b => b.report.rounds[0]?.panel?.[0]?.findings).slice(0, 16);
function arcState(b) { return b.report.committed.split(/\n\s*CRITIQUE:/)[0].trim(); }
function figures(b) {
  const logic = arcState(b), out = [];
  for (const m of logic.matchAll(/^\s*-\s*([^\n(]+?) \((commissioned|new)\)\s*(?:—|:|-)/gm)) out.push({ name: m[1].trim(), kind: m[2] });
  return out;
}
module.exports = { books, arcState, figures, RUN };
if (require.main === module) {
  const [mode, a, z] = [process.argv[2], +process.argv[3] || 0, +process.argv[4] || 99];
  books.forEach((b, i) => {
    if (i < a || i >= z) return;
    if (mode === 'show') console.log(`\n===== [${i}] ${b.id.slice(-9)} figures: ${figures(b).map(f => f.name + (f.kind === 'new' ? '*' : '')).join(', ')}\n${arcState(b)}`);
    if (mode === 'panel') { console.log(`\n===== [${i}] ${b.id.slice(-9)}`); b.report.rounds[0].panel.forEach(p => p.findings.forEach(f => console.log(`${p.model.split('/').pop()} #${f.rank} ${f.text}`))); }
  });
}

// ───────────────────────── Jev side ─────────────────────────
// Appended below the extract helpers; modes: run | score (see usage in the header of the run folder notes).
const J = require('../../server/lib/jevAudit');
function splitArc(b) {
  const st = arcState(b), at = st.search(/\n\s*(?:\*\*)?ARC(?:\*\*)?:?\s*\n/);
  const head = st.slice(0, at).trim(), arcText = st.slice(at).replace(/^\s*(?:\*\*)?ARC(?:\*\*)?:?\s*\n/, '');
  const sents = [...arcText.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map(m => ({ n: +m[1], text: m[2].trim() }));
  return { head: head.replace(/\n{2,}/g, '\n'), sents };
}
const stateFor = (b, mark) => { const { head, sents } = splitArc(b); return `${head}\n\nARC:\n${sents.map(s => (s.n === mark ? `>>> ${s.n}. ${s.text} <<<` : `${s.n}. ${s.text}`)).join('\n')}`; };
// V1: coarse lenses (the panel's own lens names, one noul each)
const V1 = {
  ASSUMED: 'The marked sentence relies on a person, object, ability or fact that nothing earlier in the story logic or the arc has given.',
  ENTRANCE: 'In the marked sentence a figure or object turns up exactly where it is needed, and nothing earlier says what brought it there.',
  WHYNOT: 'A child reading the marked sentence would ask why the characters do not simply do something easier (go round, use another way, ask for help, do it themselves).',
  SENSE: 'The marked sentence cannot happen as written: it breaks a limit, a place or a physical fact that the story logic or an earlier sentence stated.',
  CONTRA: 'The marked sentence contradicts something stated earlier in the story logic or in the arc.',
  ORPHAN: 'The marked sentence sets up something (a promise, an object, a rule, a plan) that no later sentence uses or pays off.',
  GIVEWAY: 'In the marked sentence the opposition gives way, or the deadline is met or missed, without a cause the story gave.',
};
// V2: the same checks cut into narrow one-fact questions
const V2 = {
  OBJ_NEW: 'The marked sentence uses a physical object that no earlier sentence and no line of the story logic mentions.',
  FIG_NEW: 'The marked sentence has a character act who has not been mentioned in any earlier sentence.',
  LIMIT_BREAK: 'In the marked sentence a character does something that the Facts list says that character cannot do.',
  PLACE_JUMP: 'In the marked sentence a character is somewhere the earlier sentences did not put them, and no movement is stated.',
  BLOCK_GONE: 'The marked sentence makes possible something that was blocked or impossible earlier, and states no cause for the change.',
  PLAN_SWAP: 'The marked sentence replaces something a character promised or planned earlier with a different action, and the promise is never kept.',
  TIME_BREAK: 'The marked sentence puts an event after a time or deadline that the story logic says ends it, or before a time it needs.',
  PHYS_IMPOSS: 'The marked sentence needs a character or animal to do something its size, strength or nature stated in the story makes impossible.',
  KNOW_BREAK: 'In the marked sentence a character uses knowledge they were never shown to have learned.',
  HELPER_LOST: 'The marked sentence says a character who was holding, guarding or steadying something is still doing so while the same sentence moves that something away.',
};
const V3Crit = ['everything in the marked sentence is explained by the story logic and the earlier sentences',
  'one small detail in the marked sentence rests on something the story has not given',
  'a reader would stop at the marked sentence and ask how or why it can happen'];
function nouls(map) { return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { type: 'noul', instructions: v }])); }

async function jevRun() {
  const out = path.join(RUN, 'sent_answers.jsonl');
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return `${a.book}|${a.n}|${a.v}|${a.rep}`; }) : []);
  const reps = +(process.argv.find(a => a.startsWith('--reps='))?.split('=')[1] || 1);
  const tasks = [];
  books.forEach((b, bi) => splitArc(b).sents.forEach(s => {
    for (let rep = 0; rep < reps; rep++) {
      tasks.push({ book: bi, n: s.n, v: 'V1', rep, state: stateFor(b, s.n), questions: nouls(V1) });
      tasks.push({ book: bi, n: s.n, v: 'V2', rep, state: stateFor(b, s.n), questions: nouls(V2) });
      if (rep === 0) tasks.push({ book: bi, n: s.n, v: 'V3', rep, state: stateFor(b, s.n), questions: { SC: { type: 'score', instructions: 'How well does the story so far explain the marked sentence?', criteria: V3Crit } } });
    }
  }));
  const todo = tasks.filter(t => !done.has(`${t.book}|${t.n}|${t.v}|${t.rep}`));
  let i = 0, cost = 0, lat = [];
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < todo.length) {
    const t = todo[i++]; const t0 = Date.now();
    try { const r = await J.callJev({ state: t.state, questions: t.questions }); cost += r.cost; lat.push(Date.now() - t0);
      fs.appendFileSync(out, JSON.stringify({ book: t.book, n: t.n, v: t.v, rep: t.rep, ms: Date.now() - t0, cost: r.cost, answers: r.answers }) + '\n');
    } catch (e) { console.error('fail', t.book, t.n, t.v, e.message.slice(0, 120)); }
  } }));
  console.log(`ran ${todo.length} calls, cost $${cost.toFixed(4)}, p50 ${lat.sort((a, b) => a - b)[lat.length >> 1]} ms`);
}
module.exports.splitArc = splitArc; module.exports.stateFor = stateFor; module.exports.V1 = V1; module.exports.V2 = V2; module.exports.nouls = nouls;
if (require.main === module && process.argv[2] === 'run') { require('dotenv').config(); jevRun(); }
