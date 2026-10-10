/**
 * Idea coherence — the two rules every story IDEA must meet in ONE module used by both idea paths:
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
 * (coherenceRule) and the Jev rubric questions (ideaJevRubric.js) are built from the
 * same two phrases below, so neither can drift (`axis: generator-vs-critic`).
 * Jev judges MEANING; nothing here reads the idea's text.
 *
 * WIRING: the trial card gets the rule AND the Jev rubric gate (ideaJevRubric.js via
 * trialIdeaCheck.finishIdeaCard, docs/decisions.md 2026-10-10). The wizard gets the RULE
 * only: the trial-calibrated thresholds fail every wizard premise, so a gate there waits
 * for thresholds calibrated on wizard labels.
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

/** What the visitor chose, as the check needs it: the topic only when it is a commissioned hard thing (a life challenge). */
function ideaCoherenceContext({ storyCategory, storyTopic, storyTheme } = {}) {
  return { topic: storyCategory === 'life-challenge' ? String(storyTopic || '') : '', theme: String(storyTheme || '') };
}

module.exports = {
  COMMISSIONED_ACT_PHRASE,
  INSERTED_ACT_PHRASE,
  coherenceRule,
  ideaCoherenceContext,
};
