#!/usr/bin/env node
/**
 * Can Jev be the REVIEWER of a story-idea card (replacing the in-stream [REVIEW])? (owner 2026-10-09)
 * Runs every stored idea's DRAFT and FINAL through three Jev question sets and stores the raw answers:
 *   G  narrow "holds" nouls (yes = good)          one question per checklist item, one per cast name
 *   B  narrow "defect" nouls (yes = defect)       the rewrite-class defects only
 *   S  SCORE mode (0-4) per dimension
 *   node scripts/analysis/eval-jev-idea-review.js run [--only=G,B,S] [--cap=0.45] [--ids=R25]
 * Input  evals/runs/2026-10-09_jev-idea-review/ideas.jsonl (scripts/analysis/jev-idea-extract.js)
 * Output evals/runs/2026-10-09_jev-idea-review/answers.jsonl
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const { callJev } = require('../../server/lib/jevAudit');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const mode = process.argv[2];
const LANG = { de: 'German', fr: 'French', en: 'English', it: 'Italian' };

const load = () => fs.readFileSync(RUN + 'ideas.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);

function state(it, text) {
  const youngest = Math.min(...it.cast.map(c => c.age));
  return [
    "# THE BACK-COVER TEXT OF A CHILDREN'S PICTURE BOOK",
    `Cast: ${it.cast.map(c => `${c.name} (${c.age}${c.main ? ', main character' : ''})`).join('; ')}. Youngest: ${youngest}.`,
    `Kind of story: ${[it.cat, it.theme && `theme "${it.theme}"`, it.topic && `topic "${it.topic}"`].filter(Boolean).join(', ')}.`,
    `Language of the text: ${LANG[String(it.lang).slice(0, 2)] || it.lang}.`,
    '# THE TEXT', text].join('\n');
}
const N = (instructions) => ({ type: 'noul', instructions });
const mainName = it => it.cast.filter(c => c.main).map(c => c.name).join(' and ') || it.cast[0].name;
const mainAge = it => (it.cast.find(c => c.main) || it.cast[0]).age;

function questionsFor(it, set) {
  const main = mainName(it);
  const lang = LANG[String(it.lang).slice(0, 2)] || it.lang;
  const q = {};
  if (set === 'G') {
    q.G_WANT = N(`The text says what ${main} wants for themselves, and it is something a child of that age would want for themselves, not an errand an adult gave them.`);
    q.G_OBST = N('The text names a concrete obstacle in the way of that want: a creature, person, thing or event outside the child that can be pictured.');
    q.G_CAUSAL = N('The text forms a chain: a want, an obstacle that stops it, and an act by the child that answers exactly that obstacle.');
    q.G_ACT = N(`The last sentence shows ${main} moving their body toward the want: a reach, a climb, a step, a call.`);
    q.G_ACT_FREE = N(`In the last sentence ${main} is not already holding, knowing or having the thing that decides the outcome.`);
    q.G_NO_END = N('The text stops before the outcome: it does not tell whether the main character succeeds, nor how the story ends.');
    q.G_NO_MIDDLE = N('The text does not narrate the middle of the story: it names no trick, object or test that decides the outcome, and no sequence of attempts.');
    for (const c of it.cast) q[`G_STAKE_${c.name.replace(/\W/g, '_')}`] = N(`${c.name} has a stake in this text: ${c.name} wants something or is answerable for something, beyond being there, living with the others or coming along.`);
    q.G_NO_NEW = N('Every person in the text is one of the cast listed above, or a stranger or keeper standing in the way. No new companion, helper or teller joins the cast.');
    q.G_AGE = N(`The want, the obstacle and the act suit a child aged ${mainAge(it)}.`);
    q.G_SAFE = N('No child of the cast is put at a height, in deep or rising water, in the dark underground, or in a vehicle with a running-out supply.');
    if (it.topic && it.cat === 'life-challenge') q.G_TOPIC = N(`The topic "${it.topic}" is what stands in the way: without it the text would be a different story.`);
    q.G_HOOK = N('The text contains exactly one thing out of the ordinary that can be pointed at in a picture, named with a plain noun, and it belongs to the setup or the obstacle, not to what decides the outcome.');
    q.G_OPEN = N('The first sentence shows the hook or the main character in action; it is not a sentence that merely states where and when.');
    q.G_FEEL = N('No feeling is named in words; every feeling is shown by what a body does.');
    q.G_EXCITE = N('A child would be excited and want to know what happens next.');
    q.G_BUY = N('A parent would buy this book for their child, going by this text.');
    q.G_LANG = N(`The text is written entirely in ${lang}, with no words from another language and no invented words.`);
  } else if (set === 'B') {
    q.B_LEAK_END = N('The text tells how the story ends, or whether the main character manages it.');
    q.B_LEAK_MIDDLE = N('The text narrates the middle of the story: a series of attempts, a trick, or the object that decides the outcome.');
    q.B_NEW_COMPANION = N('The text lets a person join the cast who is not in the cast list: a companion, helper or teller.');
    q.B_FEEL = N('The text names a feeling in words (such as afraid, happy, sad, brave) instead of showing it.');
    q.B_PERIL = N('A child of the cast is in bodily danger: at a height, in deep or rising water, in the dark underground, or in a vehicle with a running-out supply.');
    q.B_ACT_HOLD = N(`The last sentence has ${main} already holding or having the thing the whole text turns on, instead of moving toward it.`);
    q.B_OPEN_STATES = N('The first sentence only states where and when, and shows neither the main character nor anything out of the ordinary.');
    q.B_ERRAND = N('What the main character wants is an errand an adult gave them, a repair, a permit, a measurement or an arrangement, not something a child wants for themselves.');
    q.B_STUCK = N('The text stops on the problem alone: nothing in it shows the main character doing something about it.');
    q.B_NAMED_ONLY = N('Some cast member is only named, with no want and nothing they are answerable for.');
    if (it.topic && it.cat === 'life-challenge') q.B_BOLTED = N(`The topic "${it.topic}" is bolted on: the text would read the same if the topic were removed.`);
  } else if (set === 'S') {
    q.S_CAUSAL = { type: 'score', instructions: 'How well does the text form a chain from a want, through an obstacle, to an act by the child that answers exactly that obstacle?', criteria: ['no chain at all', 'a want or a situation only', 'want and obstacle, but no act of the child', 'want, obstacle and an act that does not answer that obstacle', 'a clean chain: want, obstacle, an act that answers it'] };
    q.S_LEAK = { type: 'score', instructions: 'How much of the middle and the ending of the story does the text tell?', criteria: ['the whole story including the ending', 'the middle and a hint of the end', 'part of the middle (a trick, an object or a series of attempts)', 'a trace of the middle only', "nothing: it stops at want, obstacle and the child's first move"] };
    q.S_ACT = { type: 'score', instructions: 'What does the last sentence of the text show?', criteria: ['nothing the child does', 'the child holding, knowing or having the key thing', 'the child standing or waiting', 'the child talking or deciding', "the child's body moving toward the want"] };
    q.S_CAST = { type: 'score', instructions: 'How many of the cast members have a stake of their own in the text (a want, or something they are answerable for)?', criteria: ['none', 'fewer than half', 'about half', 'all but one', 'all of them'] };
    q.S_AGE = { type: 'score', instructions: `How well do the want, the obstacle and the act suit a child aged ${mainAge(it)}?`, criteria: ['far too old or too young', 'clearly off', 'acceptable', 'good fit', 'exactly right'] };
    q.S_EXCITE = { type: 'score', instructions: 'How exciting is this text for a child?', criteria: ['dull', 'mild', 'some pull', 'strong pull', 'they would ask for it again tomorrow'] };
  }
  return q;
}

async function once(req, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await callJev(req); } catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  return null;
}

async function run() {
  const ideas = load().filter(x => !argv.ids || x.id.startsWith(argv.ids));
  const sets = String(argv.only || 'G,B,S').split(',');
  const cap = Number(argv.cap || 0.45);
  const file = RUN + 'answers.jsonl';
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const o = JSON.parse(l); return `${o.id}|${o.which}|${o.set}`; }) : []);
  const jobs = [];
  for (const it of ideas) for (const which of ['draft', 'final']) for (const set of sets) if (!done.has(`${it.id}|${which}|${set}`)) jobs.push({ it, which, set });
  console.log('jobs', jobs.length);
  let spent = 0; let n = 0; let i = 0; const ms = [];
  const out = fs.createWriteStream(file, { flags: 'a' });
  async function worker() {
    while (i < jobs.length && spent < cap) {
      const { it, which, set } = jobs[i++];
      const t0 = Date.now();
      try {
        const r = await once({ state: state(it, it[which]), questions: questionsFor(it, set) });
        spent += r.cost; n++; ms.push(Date.now() - t0);
        out.write(JSON.stringify({ id: it.id, which, set, answers: r.answers, cost: r.cost, ms: Date.now() - t0 }) + '\n');
      } catch (e) { console.log('FAIL', it.id, which, set, e.message.slice(0, 120)); }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  out.end();
  ms.sort((a, b) => a - b);
  console.log(`calls ${n} spent $${spent.toFixed(4)} p50 ${ms[Math.floor(ms.length / 2)]}ms p90 ${ms[Math.floor(ms.length * 0.9)]}ms`);
}
if (mode === 'run' && require.main === module) run().catch(e => { console.error(e); process.exit(1); });
module.exports = { state, questionsFor, load, mainName, mainAge };
