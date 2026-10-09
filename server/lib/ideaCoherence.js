/**
 * Idea coherence — the two rules every story IDEA must meet, and the Jev check
 * that judges them, in ONE module used by both idea paths:
 *   - the trial idea  (prompts/trial-idea.txt, server/lib/trialIdeaCheck.js, server/routes/trial.js)
 *   - the wizard idea (prompts/generate-story-idea*.txt via server/lib/ideaContract.js, server/routes/storyIdeas.js)
 * Sibling set `idea-coherence-paths` (scripts/admin/sibling-registry.json).
 *
 * The two rules (owner, 2026-10-09: "they are incoherent"):
 *   FORCED   the topic drives the problem: the situation leaves the main
 *            character no way through but the commissioned hard thing, so the act
 *            is not bolted on (a muted playmate phone that nothing in the story
 *            required);
 *   FOLLOWS  every act follows from the situation set up before it: no act is put
 *            in only to bring the topic or the theme into the story.
 * Deliberately NOT rules (owner, same day): the idea need not resolve, characters
 * need not be introduced, worlds may mix.
 *
 * Generator and critic are one wording: the rule the generator reads
 * (coherenceRule) and the Jev questions (coherenceQuestions) are built from the
 * same two phrases below, so neither can drift (`axis: generator-vs-critic`).
 * Jev judges MEANING; nothing here reads the idea's text. A Jev failure THROWS
 * (no unchecked idea ships).
 *
 * WIRING: the trial card gets the rule AND the Jev gate (thresholds calibrated
 * on 34 hand-labelled trial cards). The wizard gets the RULE only: on wizard
 * premises (no outcome, longer, one paragraph) the trial-calibrated thresholds
 * fail every card (3/3 before the rule, 3/3 after), so a gate there would rerun
 * ~100% of ideas, doubling their cost and adding 45-60 s. The wizard gate waits
 * for thresholds calibrated on wizard labels (docs/decisions.md 2026-10-09
 * "Trial and wizard idea coherence", Revisit if).
 * see docs/decisions.md 2026-10-09 "Trial and wizard idea coherence".
 */

/** The hard thing the visitor picked, as the generator and the critic both name it. */
const COMMISSIONED_ACT_PHRASE = 'the hard thing this story was asked for';
/** An act that serves the checklist and not the story. */
const INSERTED_ACT_PHRASE = 'put in only to bring the topic or the theme into the story';

/** The generator's rule. `withTopic=false` (an adventure) drops the topic clause. */
function coherenceRule({ withTopic = true } = {}) {
  return `Every act follows from the situation set up before it: a reader of the sentences so far sees why the main character does it${withTopic ? `, and the situation itself calls for ${COMMISSIONED_ACT_PHRASE}` : ''}. An act ${INSERTED_ACT_PHRASE} is a fault: change the situation until it calls for the act, never bolt the act onto a situation that does not.`;
}

/** The Jev questions, worded from the same phrases. Position-free: they read a three-sentence card and a premise alike. */
const COHERENCE_QUESTIONS = {
  forced: {
    type: 'noul',
    instructions: `The act in this idea that deals with ${COMMISSIONED_ACT_PHRASE} is needed to get past what stands in the way.`,
  },
  follows: {
    type: 'noul',
    instructions: `Every act in this idea follows from the situation set up before it: a reader of the earlier sentences sees why the main character does it, and none is an act ${INSERTED_ACT_PHRASE}.`,
  },
};
/** P(yes) under this fails the question. Calibrated on the 34 hand-labelled 2026-10-09 trial baseline cards (wording AUC: forced 0.74, follows 0.88; evals/runs/2026-10-09_trial-idea-coherence/, scripts/analysis/eval-idea-coherence-wording.js). */
const COHERENCE_THRESHOLDS = { forced: 0.8, follows: 0.6 };
const COHERENCE_TIMEOUT_MS = 15000;

/** Why an idea was sent back, in the generator's own terms. English by design. */
const COHERENCE_FEEDBACK = {
  'incoherent-forced': `what stands in the way does not leave the main character no way through but ${COMMISSIONED_ACT_PHRASE}, so what they do about it is not what the situation demands`,
  'incoherent-follows': `an act in the idea does not follow from the situation set up before it, or was ${INSERTED_ACT_PHRASE}`,
};

/**
 * @param {string} idea
 * @param {{topic?:string, theme?:string}} context  `topic` only for a commissioned
 *   hard thing (a life challenge); without it only `follows` is asked.
 */
function buildCoherenceRequest(idea, { topic = '', theme = '' } = {}) {
  const t = String(topic || '').replace(/-/g, ' ').trim();
  const th = String(theme || '').replace(/-/g, ' ').trim();
  const asked = COMMISSIONED_ACT_PHRASE.charAt(0).toUpperCase() + COMMISSIONED_ACT_PHRASE.slice(1);
  const state = `A STORY IDEA FOR A CHILD'S PICTURE BOOK.\n${t ? `${asked}: ${t}.\n` : ''}${th ? `The story's theme: ${th}.\n` : ''}\nTHE IDEA:\n${String(idea || '').trim()}`;
  const questions = t ? { forced: COHERENCE_QUESTIONS.forced, follows: COHERENCE_QUESTIONS.follows } : { follows: COHERENCE_QUESTIONS.follows };
  return { state, questions };
}

/** What the visitor chose, as the check needs it: the topic only when it is a commissioned hard thing (a life challenge). */
function ideaCoherenceContext({ storyCategory, storyTopic, storyTheme } = {}) {
  return { topic: storyCategory === 'life-challenge' ? String(storyTopic || '') : '', theme: String(storyTheme || '') };
}

/**
 * One Jev call, both questions. THROWS when Jev does not answer.
 * @returns {Promise<{ok:boolean, failure:string|null, forced?:number, follows:number, cost:number, ms:number}>}
 */
async function judgeCoherence(idea, context = {}, { callImpl } = {}) {
  const J = require('./jevAudit');
  const call = callImpl || (rq => J.callJev(rq));
  const rq = buildCoherenceRequest(idea, context);
  const t0 = Date.now();
  let timer;
  const r = await Promise.race([
    call(rq),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`idea coherence check: Jev did not answer in ${COHERENCE_TIMEOUT_MS} ms`)), COHERENCE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  const p = {};
  for (const id of Object.keys(rq.questions)) p[id] = J.yesProb(r.answers[id]);
  const failed = ['forced', 'follows'].find(id => id in p && p[id] < COHERENCE_THRESHOLDS[id]);
  return { ...p, ok: !failed, failure: failed ? `incoherent-${failed}` : null, cost: r.cost || 0, ms: Date.now() - t0 };
}

module.exports = {
  COMMISSIONED_ACT_PHRASE,
  INSERTED_ACT_PHRASE,
  COHERENCE_QUESTIONS,
  COHERENCE_THRESHOLDS,
  COHERENCE_FEEDBACK,
  coherenceRule,
  ideaCoherenceContext,
  buildCoherenceRequest,
  judgeCoherence,
};
