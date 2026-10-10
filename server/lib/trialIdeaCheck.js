/**
 * Trial idea self-certification — the generator points at its own words.
 *
 * Nine rounds of prompt tuning plateaued with the commissioned hard thing
 * missing from ~6 of 28 cards and, worse, BOTH cards of 2 of 14 cells missing
 * it: a visitor picks a topic and is offered two stories that are not about it.
 * Nothing on the trial path ever checked (`skipQualityEval: true`).
 *
 * A second judge call was rejected by the owner on latency: it taxes 100% of
 * trials to fix ~15%. So the check rides in the SAME call that writes the idea.
 * It is deliberately NOT a self-assigned verdict ("is this good? yes/no") — a
 * model that wrote the wrong card rubber-stamps the wrong card. It is
 * ENUMERABLE and quotable, the pattern that worked for invented-cast totals:
 * the card must COPY the span of its own slot 2 in which the main character
 * does the commissioned hard thing. A card with no such span has to write NONE,
 * which is self-identification without an opinion.
 *
 * JS never reads the idea's meaning — it only checks that the quoted spans are
 * really spans of the card's own slots. Classification stays in the prompt.
 */

/**
 * The one phrase naming the commissioned act. It appears in the RULE the
 * generator is given and in the SELF-CHECK it answers, so the two cannot drift
 * into differently-worded copies of one rule (`generator-vs-critic`).
 */
const { COMMISSIONED_ACT_PHRASE, coherenceRule, ideaCoherenceContext } = require('./ideaCoherence');
const { RUBRIC_FEEDBACK, judgeIdeaRubric } = require('./ideaJevRubric');

/** The obstacle rule, verbatim as it stood in prompts/trial-idea.txt. */
const TRIAL_IDEA_COMMISSION_RULE = `What gets in the way is an outside event that leaves the main character no way through but
${COMMISSIONED_ACT_PHRASE} — never a different difficulty put in its place, and never named
outright. The event is what makes that hard thing unavoidable, and slot 2 is the main character
doing it; an event that merely happens alongside it is a fault. The setting is where that struggle
happens, not scenery around it. When the story was asked for no particular hard thing, the trouble
comes out of the theme's own world: the kind of trouble that world makes for the people in it, never
a creature, villain or quest borrowed from another kind of story.
${coherenceRule()}`;

// The idea card's length. 11 of 11 stored trial ideas before the causal-chain
// rule (docs/decisions.md 2026-10-08) were 47-50 words; the 16 after it ran 61-110
// (median ~75) because "Maximum 50 words" was one clause at the end of a long
// chain rule. The limit is now a stated, per-sentence budget (prompts/trial-idea.txt
// {MAX_WORDS} / {SENTENCE_WORDS}), one constant for the prompt and the test.
const TRIAL_IDEA_MAX_WORDS = 75;
const TRIAL_IDEA_SENTENCE_WORDS = Math.ceil(TRIAL_IDEA_MAX_WORDS / 3);

const CHECK_MARKER = 'CHECK';
const NO_ACT = 'NONE';

/** The self-check block, worded from the same phrase as the rule above. */
const TRIAL_IDEA_SELF_CHECK_RULE = `After the three sentences, on further lines, write exactly:
${CHECK_MARKER}
WANT: the words of sentence 1 that are what the main character wants, copied exactly as you wrote them
EVENT: the words of sentence 1 that are the outside event, copied exactly as you wrote them
USES: the words of sentence 1 that name each person, creature or thing sentence 2 works with or on, copied exactly as you wrote them, several separated by | — if sentence 2 works with nothing but the main character themselves, write ${NO_ACT}; if sentence 2 works with something sentence 1 does not name, the idea is wrong, so write it again
ACT: the words of sentence 2 in which the main character does ${COMMISSIONED_ACT_PHRASE}, copied exactly as you wrote them — if sentence 2 has no such words, write ${NO_ACT}
RESULT: the words of sentence 3 in which exactly that want is settled, copied exactly as you wrote them — if sentence 3 settles something else, write ${NO_ACT}
Copy, never reword, and write nothing after the RESULT line. The labels ${CHECK_MARKER}, WANT, EVENT, USES, ACT and RESULT stay in English whatever language the idea is written in.`;

/** Loose compare: case, whitespace and quotation marks only. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"“”„‚‘’']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?…]+$/g, '')
    .trim();
}

const MARKER_RE = new RegExp(String.raw`^\s*${CHECK_MARKER}\s*$`, 'mi');

/**
 * The visitor-facing idea: everything before the check block. Also handles a
 * partially streamed marker, so no fragment of it flashes in the UI.
 */
function stripIdeaSelfCheck(text) {
  let out = String(text || '');
  const m = out.match(MARKER_RE);
  if (m) out = out.slice(0, m.index);
  else out = out.replace(/\n\s*C(H(E(C(K)?)?)?)?\s*$/i, '');
  return out.trim();
}

/** Sentences of the idea, by terminal punctuation. */
function ideaSentences(idea) {
  return String(idea || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Parse the self-check block. THROWS when the block is missing or malformed —
 * an unparseable card is a broken contract, not a passing card (NO FALLBACKS).
 *
 * @returns {{idea, event, act, ok, failure}} `failure` is a stable code, never
 *   text read out of the idea.
 */
function parseIdeaSelfCheck(raw) {
  const text = String(raw || '').trim();
  const m = text.match(MARKER_RE);
  if (!m) throw new Error('trial idea self-check: no CHECK block in the response');
  const idea = text.slice(0, m.index).trim();
  const block = text.slice(m.index + m[0].length);
  const line = label => (block.match(new RegExp(String.raw`^\s*${label}:\s*(.+)$`, 'mi')) || [])[1];
  const [want, event, uses, act, resultSpan] = ['WANT', 'EVENT', 'USES', 'ACT', 'RESULT'].map(line);
  if ([want, event, uses, act, resultSpan].some(v => v === undefined)) {
    throw new Error('trial idea self-check: CHECK block is missing a WANT, EVENT, USES, ACT or RESULT line');
  }
  if (!idea) throw new Error('trial idea self-check: no idea before the CHECK block');

  const sentences = ideaSentences(idea);
  const nIdea = norm(idea);
  const result = { idea, want: want.trim(), event: event.trim(), uses: uses.trim(), act: act.trim(), result: resultSpan.trim(), ok: true, failure: null };

  const fail = code => { result.ok = false; result.failure = code; return result; };

  if (norm(act) === norm(NO_ACT) || !norm(act)) return fail('no-act');
  if (!nIdea.includes(norm(act))) return fail('act-not-quoted');
  if (sentences.length >= 2 && !norm(sentences[1]).includes(norm(act))) return fail('act-not-in-slot-2');
  if (!norm(event)) return fail('no-event');
  if (!nIdea.includes(norm(event))) return fail('event-not-quoted');
  if (sentences.length >= 1 && !norm(sentences[0]).includes(norm(event))) return fail('event-not-in-slot-1');
  // The chain: the want and the thing slot 2 works with are slot-1 words, and
  // the result is the slot-3 span that settles that want.
  if (!norm(want)) return fail('no-want');
  if (!nIdea.includes(norm(want))) return fail('want-not-quoted');
  if (sentences.length >= 1 && !norm(sentences[0]).includes(norm(want))) return fail('want-not-in-slot-1');
  if (norm(uses) !== norm(NO_ACT)) {
    for (const part of uses.split('|').map(norm).filter(Boolean)) {
      if (!nIdea.includes(part)) return fail('uses-not-quoted');
      if (sentences.length >= 1 && !norm(sentences[0]).includes(part)) return fail('uses-not-in-slot-1');
    }
  }
  if (norm(resultSpan) === norm(NO_ACT) || !norm(resultSpan)) return fail('no-result');
  if (!nIdea.includes(norm(resultSpan))) return fail('result-not-quoted');
  if (sentences.length >= 3 && !norm(sentences[2]).includes(norm(resultSpan))) return fail('result-not-in-slot-3');
  return result;
}

// ───────────────────────── the Jev gate and the one rerun ─────────────────────────

/** What the visitor chose and who the card is about, as the rubric needs it. Topic only for a life challenge (ideaCoherence.js). */
function ideaGateContext({ storyCategory, storyTopic, storyTheme, age } = {}) {
  return { age: parseInt(age, 10), ...ideaCoherenceContext({ storyCategory, storyTopic, storyTheme }) };
}

/**
 * One Jev rubric call for one card. FAIL-OPEN BY OWNER DECISION (docs/decisions.md
 * 2026-10-10 "Jev idea rubric wired"; precedent 2026-09-11 element-cell gate): a Jev
 * outage logs an error and the card ships un-gated; it never fails the visitor's idea.
 * @returns {Promise<{ok:boolean, failure:string|null, score?:number, tripped?:string[], ms?:number, cost?:number, error?:string}>}
 */
async function gateCard(idea, ctx, { judgeImpl, log } = {}) {
  try {
    if (!Number.isFinite(ctx?.age)) throw new Error('the main character has no age');
    const r = await (judgeImpl || judgeIdeaRubric)(idea, ctx);
    return { ok: r.ok, failure: r.failure, score: r.score, tripped: r.tripped, ms: r.ms, cost: r.cost };
  } catch (err) {
    if (log) log.error(`  idea rubric gate failed, card ships un-gated: ${err.message}`);
    return { ok: true, failure: null, error: err.message };
  }
}

/**
 * Finish one generated card: its own CHECK block, then the Jev rubric (tripwires +
 * score gate), then AT MOST ONE rerun with the reason fed back. One rerun path for
 * both causes; whatever the rerun returns is the answer. A card that fails its own
 * CHECK reruns without a Jev call (Jev adds nothing to a card already going back).
 * The rerun result is scored too, for the record only.
 *
 * @param {object} a
 * @param {string} a.firstText    the raw first response (idea + CHECK block)
 * @param {string} a.basePrompt   the prompt that produced it
 * @param {(prompt:string)=>Promise<string>} a.rerunCall  returns the rerun's raw text
 * @param {{age:number, topic?:string, theme?:string}} a.ctx
 * @returns {Promise<{parsed:object, rerun:boolean, rerunReason:string|null, firstGate:object|null, finalGate:object|null}>}
 *   THROWS when either response has no parseable CHECK block (unchanged).
 */
async function finishIdeaCard({ firstText, basePrompt, rerunCall, ctx, judgeImpl, log }) {
  let parsed = parseIdeaSelfCheck(firstText);
  const firstGate = parsed.ok ? await gateCard(parsed.idea, ctx, { judgeImpl, log }) : null;
  const rerunReason = !parsed.ok ? parsed.failure : (firstGate && !firstGate.ok ? firstGate.failure : null);
  if (!rerunReason) return { parsed, rerun: false, rerunReason: null, firstGate, finalGate: firstGate };
  if (log) log.warn(`  card sent back (${rerunReason}) — one rerun`);
  const reparsed = parseIdeaSelfCheck(String(await rerunCall(buildIdeaRerunPrompt(basePrompt, { idea: parsed.idea, failure: rerunReason })) || ''));
  const finalGate = reparsed.ok ? await gateCard(reparsed.idea, ctx, { judgeImpl, log }) : null;
  if (log) log.info(`  rerun ${reparsed.ok ? 'passed its check' : `still failing (${reparsed.failure})`}${finalGate?.score !== undefined ? `, rubric ${finalGate.score.toFixed(3)}` : ''}`);
  parsed = reparsed;
  return { parsed, rerun: true, rerunReason, firstGate, finalGate };
}

/** Why the card was sent back, in the generator's own terms. English by design. */
const FAILURE_FEEDBACK = {
  'no-act': `your second sentence did not show the main character doing ${COMMISSIONED_ACT_PHRASE}`,
  'act-not-quoted': 'the words you copied as the act were not in the idea you wrote',
  'act-not-in-slot-2': `the words you copied as the act were not in sentence 2, so sentence 2 is not the main character doing ${COMMISSIONED_ACT_PHRASE}`,
  'no-event': 'you named no outside event',
  'event-not-quoted': 'the words you copied as the event were not in the idea you wrote',
  'event-not-in-slot-1': 'the words you copied as the event were not in sentence 1',
  'no-want': 'you named no want in sentence 1',
  'want-not-quoted': 'the words you copied as the want were not in the idea you wrote',
  'want-not-in-slot-1': 'the words you copied as the want were not in sentence 1',
  'uses-not-quoted': 'the words you copied as what sentence 2 works with were not in the idea you wrote',
  'uses-not-in-slot-1': 'what sentence 2 works with was not named in sentence 1, so it turned up from nowhere',
  'no-result': 'sentence 3 did not settle the want from sentence 1',
  'result-not-quoted': 'the words you copied as the result were not in the idea you wrote',
  'result-not-in-slot-3': 'the words you copied as the result were not in sentence 3',
  ...RUBRIC_FEEDBACK,
};

/**
 * The rerun prompt: the same prompt, plus the rejected card and its own stated
 * reason. Exactly one rerun ever happens — if it fails too, that is the answer.
 */
function buildIdeaRerunPrompt(basePrompt, { idea, failure } = {}) {
  const reason = FAILURE_FEEDBACK[failure] || 'your check block did not hold';
  return `${basePrompt}

Your previous attempt is rejected: ${reason}.
Rejected attempt:
${String(idea || '').trim()}
Write a different idea. Sentence 2 must be the main character doing ${COMMISSIONED_ACT_PHRASE}, and the outside event in sentence 1 must be what leaves them no other way. Everything sentence 2 works with is named in sentence 1, and sentence 3 settles exactly the want from sentence 1. Then write the CHECK block for the new idea. Write only the new idea and its CHECK block: no commentary, no remark on the rejected attempt, nothing before the first sentence.`;
}

module.exports = {
  COMMISSIONED_ACT_PHRASE,
  finishIdeaCard,
  ideaGateContext,
  TRIAL_IDEA_COMMISSION_RULE,
  TRIAL_IDEA_SELF_CHECK_RULE,
  TRIAL_IDEA_MAX_WORDS,
  TRIAL_IDEA_SENTENCE_WORDS,
  CHECK_MARKER,
  NO_ACT,
  FAILURE_FEEDBACK,
  stripIdeaSelfCheck,
  parseIdeaSelfCheck,
  buildIdeaRerunPrompt,
};
