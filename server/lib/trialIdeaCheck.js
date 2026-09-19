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
const COMMISSIONED_ACT_PHRASE = 'the hard thing this story was asked for';

/** The obstacle rule, verbatim as it stood in prompts/trial-idea.txt. */
const TRIAL_IDEA_COMMISSION_RULE = `What gets in the way is an outside event that leaves the main character no way through but
${COMMISSIONED_ACT_PHRASE} — never a different difficulty put in its place, and never named
outright. The event is what makes that hard thing unavoidable, and slot 2 is the main character
doing it; an event that merely happens alongside it is a fault. The setting is where that struggle
happens, not scenery around it.`;

const CHECK_MARKER = 'CHECK';
const NO_ACT = 'NONE';

/** The self-check block, worded from the same phrase as the rule above. */
const TRIAL_IDEA_SELF_CHECK_RULE = `After the three sentences, on three further lines, write exactly:
${CHECK_MARKER}
EVENT: the words of sentence 1 that are the outside event, copied exactly as you wrote them
ACT: the words of sentence 2 in which the main character does ${COMMISSIONED_ACT_PHRASE}, copied exactly as you wrote them — if sentence 2 has no such words, write ${NO_ACT}
Copy, never reword, and write nothing after the ACT line. The three labels ${CHECK_MARKER}, EVENT and ACT stay in English whatever language the idea is written in.`;

/** Loose compare: case, whitespace and quotation marks only. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[«»"“”„‚‘’']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?…]+$/g, '')
    .trim();
}

const MARKER_RE = new RegExp(`^\s*${CHECK_MARKER}\s*$`, 'mi');

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
  const event = (block.match(/^\s*EVENT:\s*(.+)$/mi) || [])[1];
  const act = (block.match(/^\s*ACT:\s*(.+)$/mi) || [])[1];
  if (event === undefined || act === undefined) {
    throw new Error('trial idea self-check: CHECK block is missing its EVENT or ACT line');
  }
  if (!idea) throw new Error('trial idea self-check: no idea before the CHECK block');

  const sentences = ideaSentences(idea);
  const nIdea = norm(idea);
  const result = { idea, event: event.trim(), act: act.trim(), ok: true, failure: null };

  const fail = code => { result.ok = false; result.failure = code; return result; };

  if (norm(act) === norm(NO_ACT) || !norm(act)) return fail('no-act');
  if (!nIdea.includes(norm(act))) return fail('act-not-quoted');
  if (sentences.length >= 2 && !norm(sentences[1]).includes(norm(act))) return fail('act-not-in-slot-2');
  if (!norm(event)) return fail('no-event');
  if (!nIdea.includes(norm(event))) return fail('event-not-quoted');
  if (sentences.length >= 1 && !norm(sentences[0]).includes(norm(event))) return fail('event-not-in-slot-1');
  return result;
}

/** Why the card was sent back, in the generator's own terms. English by design. */
const FAILURE_FEEDBACK = {
  'no-act': `your second sentence did not show the main character doing ${COMMISSIONED_ACT_PHRASE}`,
  'act-not-quoted': 'the words you copied as the act were not in the idea you wrote',
  'act-not-in-slot-2': `the words you copied as the act were not in sentence 2, so sentence 2 is not the main character doing ${COMMISSIONED_ACT_PHRASE}`,
  'no-event': 'you named no outside event',
  'event-not-quoted': 'the words you copied as the event were not in the idea you wrote',
  'event-not-in-slot-1': 'the words you copied as the event were not in sentence 1',
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
Write a different idea. Sentence 2 must be the main character doing ${COMMISSIONED_ACT_PHRASE}, and the outside event in sentence 1 must be what leaves them no other way. Then write the CHECK block for the new idea.`;
}

module.exports = {
  COMMISSIONED_ACT_PHRASE,
  TRIAL_IDEA_COMMISSION_RULE,
  TRIAL_IDEA_SELF_CHECK_RULE,
  CHECK_MARKER,
  NO_ACT,
  FAILURE_FEEDBACK,
  stripIdeaSelfCheck,
  parseIdeaSelfCheck,
  buildIdeaRerunPrompt,
};
