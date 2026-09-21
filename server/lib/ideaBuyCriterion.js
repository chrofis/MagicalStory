/**
 * The buy criterion — ONE constant, given to the writer and to its own review.
 *
 * Eight rounds of prompt tuning moved the rater's contract axes and did not move
 * the thing the ideas are for: a blind parent read scored R1 3.55, R7 3.60,
 * R8 3.50. Every rule added since R1 removed 2s and removed 5s with them — the
 * prompt taught the model to be safe, never to be wanted. The blind 5s all had
 * the same shape: one picturable strange thing, a want the child owns, a stake
 * the child can feel, an eerie or a funny turn, and nothing an adult owns.
 *
 * So the criterion itself goes into the prompt, as the parent's own questions,
 * and the review answers them with quotes rather than with a verdict — the
 * pattern that worked for the trial card (`trialIdeaCheck.js`): a model that
 * wrote a flat idea rubber-stamps a flat idea, but it cannot quote words that
 * are not there.
 *
 * It is ONE string filled into both sibling templates
 * (`prompts/generate-story-idea-single.txt`, `prompts/generate-story-ideas.txt`)
 * twice each — once as a rule for the draft, once as the last review check — so
 * the rule and the check cannot drift into differently-worded copies
 * (`axis: generator-vs-critic`).
 */

/** The parent's four questions. Generic by construction: no cell, no place, no name. */
const IDEA_BUY_QUESTIONS = `- What does the child get to do here that they cannot do at home?
- What in it will they laugh at, or gasp at?
- What is frightening here in the way a child likes being frightened?
- Which sentence makes them ask for this book again tomorrow?`;

module.exports = { IDEA_BUY_QUESTIONS };
