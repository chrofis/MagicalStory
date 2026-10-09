/**
 * Idea Jev rubric — one Jev question per requirement the trial idea prompt gives
 * (prompts/trial-idea.txt), plus the owner's holistic ones, and one card score.
 * Owner, 2026-10-09: "what we tell the idea to create we should be able to rate
 * with Jev. Jev is the only thing fast enough for quality control of trials."
 *
 * PURE and NOT WIRED: no route calls this. It builds the Jev request, reads the
 * answers into probabilities and combines them; the call itself is
 * `jevAudit.callJev`. Measured in scripts/analysis/eval-jev-idea-rubric.js,
 * numbers in docs/decisions.md 2026-10-09 "Jev idea rubric".
 *
 * Generator <-> critic: the slot phrases below are copied verbatim from the
 * trial-idea prompt (tests/unit/idea-jev-rubric.test.ts pins that each occurs in
 * prompts/trial-idea.txt), and the topic / inserted-act phrases are the very
 * constants the generator's coherence rule is built from (ideaCoherence.js).
 * Sibling set `idea-coherence-paths`.
 *
 * Owner scope (2026-10-09): an idea may stay open, introduce characters, mix
 * worlds — NO question here asks for resolution beyond the slot-3 want, for an
 * introduction, or for a single world. Jev judges MEANING; nothing here reads
 * the idea's text.
 */
const { COMMISSIONED_ACT_PHRASE, INSERTED_ACT_PHRASE } = require('./ideaCoherence');

/** Verbatim from prompts/trial-idea.txt (pinned by a test). */
const SLOT1_PHRASE = 'what the main character wants, and the one outside event that stops them';
const SLOT2_PHRASE = 'what they do about exactly that event';
const SLOT3_PHRASE = 'which settles the want';
const NAMED_IN_1_PHRASE = 'What sentence 2 works with or on is named in sentence 1';

/** Option sets for the choice mode. Generous on purpose (owner: too many options rather than too few). */
const WHO_RESOLVES = {
  own: 'the main character, by their own act',
  with_helper: 'the main character, with a helper who joins in',
  other_person: 'another person does it, the main character only watches or asks',
  creature: 'an animal or a creature does it',
  chance: 'chance, luck or something that happens by itself',
  not_resolved: 'nothing gets them past it in the idea; it stays open',
  unclear: 'it is not clear',
};
const WHO_RESOLVES_GOOD = ['own', 'with_helper'];
const SENTENCE2_SHOWS = {
  on_event: 'the main character doing something about exactly the outside event from the first sentence',
  related: 'the main character doing something related to the situation but not about the outside event itself',
  unrelated: 'the main character doing something that has nothing to do with the outside event',
  other_acts: 'someone or something else acting while the main character waits',
  nothing: 'nothing being done',
};
const SENTENCE3_SHOWS = {
  settles_want: 'exactly the want from the first sentence being settled, or its settling clearly under way',
  other_want: 'a different want than the one in the first sentence being settled',
  nothing: 'nothing that settles any want (it just goes on or stops)',
  worse: 'things getting worse',
};

/**
 * The rubric. `needs`: 'topic' = asked only for a commissioned hard thing,
 * 'theme' = only with a theme. `gen` names the generator requirement.
 * Each phrasing: { mode, q(ctx) -> question, invert?, good? (choice: option keys that count as good) }.
 * Keys: A = positive statement (noul), B = defect statement (noul, p inverted),
 * S = 5-level score, C = choice.
 */
const age = ctx => ctx.age;
const RUBRIC = {
  WANT_EVENT: {
    gen: 'slot 1', label: 'sentence 1 = a want and the one outside event that stops it',
    A: { mode: 'noul', q: () => `The first sentence gives ${SLOT1_PHRASE}.` },
    B: { mode: 'noul', invert: true, q: () => 'The first sentence names no outside event that stops the main character, or no want.' },
  },
  ACT_ON_EVENT: {
    gen: 'slot 2', label: 'sentence 2 = the act on exactly that event',
    A: { mode: 'noul', q: () => `The second sentence gives ${SLOT2_PHRASE}: the event is what the main character works on.` },
    B: { mode: 'noul', invert: true, q: () => 'The second sentence is about something other than the outside event from the first sentence.' },
    C: { mode: 'choice', good: ['on_event'], q: () => ({ type: 'choice', instructions: 'The second sentence shows', criteria: SENTENCE2_SHOWS }) },
  },
  SETTLES: {
    gen: 'slot 3', label: 'sentence 3 settles the want of sentence 1',
    A: { mode: 'noul', q: () => `The last sentence is what the act leads to, ${SLOT3_PHRASE} from the first sentence.` },
    B: { mode: 'noul', invert: true, q: () => 'The last sentence settles something other than the want from the first sentence.' },
    C: { mode: 'choice', good: ['settles_want'], q: () => ({ type: 'choice', instructions: 'The last sentence shows', criteria: SENTENCE3_SHOWS }) },
  },
  NAMED_IN_1: {
    gen: 'chain', label: 'what sentence 2 works with is named in sentence 1',
    A: { mode: 'noul', q: () => `${NAMED_IN_1_PHRASE}: nothing in the second sentence turns up from nowhere.` },
    B: { mode: 'noul', invert: true, q: () => 'The second sentence works with a person, creature or thing that the first sentence did not name.' },
  },
  TOPIC_ACT: {
    gen: 'commissioned act', needs: 'topic', label: 'the main character does the commissioned hard thing',
    A: { mode: 'noul', q: () => `The main character does ${COMMISSIONED_ACT_PHRASE} in the second sentence.` },
    B: { mode: 'noul', invert: true, q: () => `The idea is about something else than ${COMMISSIONED_ACT_PHRASE}.` },
  },
  FORCED: {
    gen: 'coherence 1', needs: 'topic', label: 'the situation forces the commissioned act (production wording)',
    A: { mode: 'noul', q: () => `The act in this idea that deals with ${COMMISSIONED_ACT_PHRASE} is needed to get past what stands in the way.` },
    B: { mode: 'noul', invert: true, q: () => `The main character deals with ${COMMISSIONED_ACT_PHRASE} only because the story must mention it; what stands in the way did not need it.` },
  },
  FOLLOWS: {
    gen: 'coherence 2', label: 'every act follows from the situation (production wording)',
    A: { mode: 'noul', q: () => `Every act in this idea follows from the situation set up before it: a reader of the earlier sentences sees why the main character does it, and none is an act ${INSERTED_ACT_PHRASE}.` },
    B: { mode: 'noul', invert: true, q: () => `Some act in this idea is ${INSERTED_ACT_PHRASE}, or has no reason in what happened before it.` },
  },
  THEME: {
    gen: 'theme', needs: 'theme', label: 'the theme is visible',
    A: { mode: 'noul', q: () => 'The theme named above can be seen in the idea: in who the main character plays, where it happens or what they use.' },
    B: { mode: 'noul', invert: true, q: () => 'The theme named above is not in the idea.' },
  },
  AGE_FIT: {
    gen: 'age mode', label: 'want, event and act suit the age',
    A: { mode: 'noul', q: c => `The want, the outside event and the act suit a child aged ${age(c)}.` },
    B: { mode: 'noul', invert: true, q: c => `The want, the outside event or the act are clearly too young or too old for a child aged ${age(c)}.` },
    S: { mode: 'score', q: c => ({ type: 'score', instructions: `How well do the want, the outside event and the act suit a child aged ${age(c)}?`, criteria: ['far too old or too young', 'clearly off', 'acceptable', 'good fit', 'exactly right'] }) },
  },
  AGENCY: {
    gen: 'hero acts', label: 'the main character\'s own act gets them past it',
    A: { mode: 'noul', q: () => 'The main character\'s own act is what gets them past the outside event; nobody else and no luck solves it for them.' },
    B: { mode: 'noul', invert: true, q: () => 'Someone else or chance gets the main character past what stands in the way.' },
    C: { mode: 'choice', good: WHO_RESOLVES_GOOD, q: () => ({ type: 'choice', instructions: 'What gets the main character past the outside event?', criteria: WHO_RESOLVES }) },
  },
  CHALLENGE: {
    gen: 'hero faces a challenge', label: 'a real difficulty for the main character',
    A: { mode: 'noul', q: c => `The main character faces a real difficulty for a child aged ${age(c)}, and has to do something about it.` },
    B: { mode: 'noul', invert: true, q: () => 'Nothing really stops the main character: the difficulty is trivial or only named.' },
  },
  CHAR_CONSISTENT: {
    gen: 'character consistent (owner)', label: 'the main character stays one consistent character',
    A: { mode: 'noul', q: () => 'The main character stays one consistent character from the first sentence to the last: the same role, and acts that suit them.' },
    B: { mode: 'noul', invert: true, q: () => 'The main character changes role, or does something that does not suit them.' },
    S: { mode: 'score', q: () => ({ type: 'score', instructions: 'How consistent is the main character, in role and in what they do, from the first sentence to the last?', criteria: ['not at all', 'barely', 'mostly', 'well', 'completely'] }) },
  },
  KID_ENJOY: {
    gen: 'kid would enjoy (owner)', label: 'a child of that age would enjoy it',
    A: { mode: 'noul', q: c => `A child aged ${age(c)} would enjoy hearing this story.` },
    B: { mode: 'noul', invert: true, q: c => `A child aged ${age(c)} would find this story dull or confusing.` },
    S: { mode: 'score', q: c => ({ type: 'score', instructions: `How much would a child aged ${age(c)} enjoy hearing this story?`, criteria: ['not at all', 'a little', 'somewhat', 'quite a lot', 'very much'] }) },
  },
  PARENT_BUY: {
    gen: 'parent would buy (owner)', label: 'a parent would buy a book from it',
    A: { mode: 'noul', q: c => `A parent of a child aged ${age(c)} would buy a picture book made from this idea.` },
    B: { mode: 'noul', invert: true, q: c => `A parent of a child aged ${age(c)} would not buy a picture book made from this idea.` },
    S: { mode: 'score', q: c => ({ type: 'score', instructions: `How likely is a parent of a child aged ${age(c)} to buy a picture book made from this idea?`, criteria: ['certainly not', 'unlikely', 'maybe', 'likely', 'certainly'] }) },
  },
  NO_COMMENTARY: {
    gen: 'output is only the idea', label: 'no remark by the writer about the idea itself',
    A: { mode: 'noul', q: () => 'The text is only the story idea: it holds no remark by its writer about the idea itself, such as a correction or a new attempt.' },
    B: { mode: 'noul', invert: true, q: () => 'The text holds a remark by its writer about the idea itself, such as a correction or a new attempt.' },
  },
};

/** The picture of the idea Jev reads. Age and the commissioned thing / theme first, then the idea. */
function buildRubricState(idea, { age: a, topic = '', theme = '' } = {}) {
  const t = String(topic || '').replace(/-/g, ' ').trim();
  const th = String(theme || '').replace(/-/g, ' ').trim();
  const asked = COMMISSIONED_ACT_PHRASE.charAt(0).toUpperCase() + COMMISSIONED_ACT_PHRASE.slice(1);
  return `A STORY IDEA FOR A CHILD'S PICTURE BOOK.\nThe main character is a child aged ${a}.\n${t ? `${asked}: ${t}.\n` : ''}${th ? `The story's theme: ${th}.\n` : ''}\nTHE IDEA:\n${String(idea || '').trim()}`;
}

/** The question ids that apply to this context. */
function applicableIds(ctx = {}, ids = Object.keys(RUBRIC)) {
  return ids.filter(id => {
    const need = RUBRIC[id].needs;
    return !need || (need === 'topic' && ctx.topic) || (need === 'theme' && ctx.theme);
  });
}

/**
 * The Jev request for one card.
 * @param {string} idea
 * @param {{age:number, topic?:string, theme?:string}} ctx
 * @param {Object<string,string>} sel  question id -> phrasing key ('A'|'B'|'S'|'C'); a question missing here is not asked. Several phrasings of
 *   one question: use the key `ID:K` in `extra` (the measurement does).
 * @returns {{state:string, questions:Object, keys:Array<{key:string,id:string,ph:string}>}}
 */
function buildRubricRequest(idea, ctx, sel) {
  const questions = {}; const keys = [];
  for (const id of applicableIds(ctx, Object.keys(sel))) {
    const ph = sel[id]; const def = RUBRIC[id][ph];
    if (!def) throw new Error(`ideaJevRubric: question ${id} has no phrasing ${ph}`);
    const q = def.q(ctx);
    questions[`${id}__${ph}`] = typeof q === 'string' ? { type: 'noul', instructions: q } : q;
    keys.push({ key: `${id}__${ph}`, id, ph });
  }
  return { state: buildRubricState(idea, ctx), questions, keys };
}

/** P(the idea is good on this question) from one Jev answer. Noul: P(yes), inverted for a defect statement; score: mean score / 4; choice: summed probability of the good options. */
function goodProbability(answer, def) {
  if (!answer) throw new Error('ideaJevRubric: missing answer');
  if (def.mode === 'noul') {
    if (typeof answer.noul !== 'number') throw new Error(`ideaJevRubric: not a noul answer: ${JSON.stringify(answer)}`);
    return def.invert ? 1 - answer.noul : answer.noul;
  }
  if (def.mode === 'score') {
    if (typeof answer.score !== 'number') throw new Error(`ideaJevRubric: not a score answer: ${JSON.stringify(answer)}`);
    return answer.score / 4;
  }
  if (!answer.probabilities) throw new Error(`ideaJevRubric: not a choice answer: ${JSON.stringify(answer)}`);
  return def.good.reduce((s, k) => s + (answer.probabilities[k] || 0), 0);
}

/** Jev answers -> { 'ID__K': p_good }. */
function readRubricAnswers(answers, keys) {
  const out = {};
  for (const { key, id, ph } of keys) out[key] = goodProbability(answers[key], RUBRIC[id][ph]);
  return out;
}

/**
 * The card score: weighted mean of the P(good) of the adopted questions that were
 * asked for this card (a topic question missing for an adventure is left out and
 * the weights renormalise). 0..1.
 * @param {Object<string,number>} p  question id -> P(good)
 * @param {Object<string,number>} weights
 */
function cardScore(p, weights) {
  let num = 0; let den = 0;
  for (const [id, w] of Object.entries(weights)) {
    if (!(id in p) || !(w > 0)) continue;
    num += w * p[id]; den += w;
  }
  if (!den) throw new Error('ideaJevRubric: no weighted question was answered');
  return num / den;
}

// ───────────────────────── the adopted set (measured, 2026-10-09) ─────────────────────────
// Which phrasing of each question carries signal and what it is worth: docs/decisions.md 2026-10-09 "Jev idea rubric",
// scripts/analysis/eval-jev-idea-rubric.js (chosen on all 102 hand-labelled cards; the held-out numbers are in the entry).

/** question id -> phrasing key, the weighted card score. */
const SCORE_PHRASINGS = {
  FORCED: 'B', FOLLOWS: 'A', TOPIC_ACT: 'B', KID_ENJOY: 'S', PARENT_BUY: 'B', CHAR_CONSISTENT: 'S', ACT_ON_EVENT: 'C',
};
/** weight = AUC - 0.5 of the question against "card is good", rounded. */
const SCORE_WEIGHTS = {
  FORCED: 0.37, FOLLOWS: 0.24, TOPIC_ACT: 0.28, KID_ENJOY: 0.22, PARENT_BUY: 0.22, CHAR_CONSISTENT: 0.29, ACT_ON_EVENT: 0.13,
};
/**
 * Hard-fail questions for gross defects, thresholds from cards changed on purpose (30 each), false alarms read on the 102
 * real cards: commentary 30/30 caught, 2/2 real remarks found, 0 false; age (score) 24/30, 0 false; theme 25/30, 0 false.
 * SETTLES (sentence 3 settles the want) is measured and left OUT of the adopted set: it separates a swapped sentence 3 (AUC 0.99)
 * but would also read an idea that stays open as a fault, which the owner ruled is not one (2026-10-09).
 */
const TRIPWIRES = [
  { id: 'NO_COMMENTARY', ph: 'A', below: 0.5 },
  { id: 'AGE_FIT', ph: 'S', below: 0.5 },
  { id: 'THEME', ph: 'B', below: 0.5 },
];
/** The card score under which a card is sent back: a quantile giving the rerun budget on the 102 measured cards (recalibrate when the generator changes). */
const RUBRIC_GATE = { flagBelow: 0.646, rerunBudget: 0.15 };
const RUBRIC_TIMEOUT_MS = 15000;

/** The production request: the scored questions plus the tripwires, ONE Jev call per card. */
function buildAdoptedRequest(idea, ctx) {
  const base = buildRubricRequest(idea, ctx, { ...SCORE_PHRASINGS });
  const questions = { ...base.questions }; const keys = [...base.keys];
  for (const t of TRIPWIRES) {
    if (!applicableIds(ctx, [t.id]).length) continue;
    const key = `${t.id}__${t.ph}`;
    if (questions[key]) continue;
    const q = RUBRIC[t.id][t.ph].q(ctx);
    questions[key] = typeof q === 'string' ? { type: 'noul', instructions: q } : q;
    keys.push({ key, id: t.id, ph: t.ph });
  }
  return { state: base.state, questions, keys };
}

/**
 * Read one card's answers.
 * @returns {{score:number, tripped:string[], p:Object<string,number>, pq:Object<string,number>}}
 */
function evaluateAdopted(answers, keys) {
  const pk = readRubricAnswers(answers, keys); // 'ID__K' -> P(good)
  const pq = {};
  for (const id of Object.keys(SCORE_PHRASINGS)) { const v = pk[`${id}__${SCORE_PHRASINGS[id]}`]; if (v !== undefined) pq[id] = v; }
  const tripped = TRIPWIRES.filter(t => pk[`${t.id}__${t.ph}`] !== undefined && pk[`${t.id}__${t.ph}`] < t.below).map(t => t.id);
  return { score: cardScore(pq, SCORE_WEIGHTS), tripped, p: pk, pq };
}

/**
 * One Jev call for a card. THROWS when Jev does not answer (no unchecked card ships, as ideaCoherence.judgeCoherence).
 * @param {{age:number, topic?:string, theme?:string}} ctx
 * @param {{callImpl?:Function, flagBelow?:number}} [opts]
 */
async function judgeIdeaRubric(idea, ctx, { callImpl, flagBelow = RUBRIC_GATE.flagBelow } = {}) {
  const J = require('./jevAudit');
  const call = callImpl || (rq => J.callJev(rq));
  const rq = buildAdoptedRequest(idea, ctx);
  const t0 = Date.now();
  let timer;
  const r = await Promise.race([
    call({ state: rq.state, questions: rq.questions }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`idea rubric: Jev did not answer in ${RUBRIC_TIMEOUT_MS} ms`)), RUBRIC_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  const ev = evaluateAdopted(r.answers, rq.keys);
  const low = ev.score < flagBelow;
  return { ...ev, ok: !low && !ev.tripped.length, failure: ev.tripped.length ? `rubric-tripwire-${ev.tripped[0].toLowerCase()}` : low ? 'rubric-low-score' : null, cost: r.cost || 0, ms: Date.now() - t0 };
}

/** Why a card was sent back, in the generator's own terms (English by design). */
const RUBRIC_FEEDBACK = {
  'rubric-tripwire-no_commentary': 'the text held a remark about the idea itself; write only the idea',
  'rubric-tripwire-age_fit': 'the want, the outside event or the act do not suit the age of the main character',
  'rubric-tripwire-theme': 'the theme cannot be seen in the idea',
    'rubric-low-score': 'the idea reads weak on the whole: the act does not follow from the situation, or the topic is not what the situation calls for',
};

module.exports = {
  SCORE_PHRASINGS, SCORE_WEIGHTS, TRIPWIRES, RUBRIC_GATE, RUBRIC_FEEDBACK, buildAdoptedRequest, evaluateAdopted, judgeIdeaRubric,
  SLOT1_PHRASE, SLOT2_PHRASE, SLOT3_PHRASE, NAMED_IN_1_PHRASE,
  RUBRIC, buildRubricState, applicableIds, buildRubricRequest, goodProbability, readRubricAnswers, cardScore,
};
