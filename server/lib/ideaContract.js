/**
 * What an idea IS — the slot list, the slot rules, and the check that reads them
 * back. ONE placeholder ({IDEA_CONTRACT}) in both sibling templates
 * (`prompts/generate-story-idea-single.txt`, `prompts/generate-story-ideas.txt`),
 * filled in `buildIdeasPromptContext`, so neither template holds a line of age
 * branching in prose.
 *
 * Two contracts, because a book for a one- or two-year-old is not a small
 * version of a book for a six-year-old (owner, 2026-09-21). A premise — a want,
 * a thing in the way, a cost — is the wrong object at that age: round 21's cell
 * 7 produced «Das Pony trippelt ans andere Ende der Koppel. Lena streckt die
 * Hände durch den Zaun.», which is one page, correctly built, and not a book.
 * What a toddler book is instead is a PATTERN: one thing the child does, an
 * answer from the world, a variation per page, one that resists, a refrain the
 * child says along, and a landing.
 *
 * The switch keys off the YOUNGEST main character's age (`youngestMainAge`),
 * the same person the templates' existing "aged two or under" rules key off —
 * not `resolveAgeBand`, which keys off the OLDEST main.
 *
 * The check text lives INSIDE each contract rather than in the review list, so
 * the review list holds one age-free line pointing at it (`axis:
 * generator-vs-critic`: the rule and its critic are the same string).
 */

const { IDEA_BUY_QUESTIONS, IDEA_BUY_QUESTIONS_TODDLER } = require('./ideaBuyCriterion');

const IDEA_CONTRACT_PREMISE = `Generate a story idea that includes:
1. THE SETUP: who is there and what they want.
2. WHAT STANDS IN THE WAY.
3. THE PROMISE: one thing that happens in this book.
4. WHAT IT COSTS THEM TO FAIL.
5. THE PICTURE: the main character in the act, last.

The want, the obstacle and the cost are each a concrete thing the reader can name: one thing to reach, fetch, mend or be in time for, a stated force or condition against it, and a stated loss. Wanting to find out what something is, an unnamed something standing in the way, or more than they can see, are none of the three.

The idea names what failing costs, wherever it fits, and the loss is one the book could show on a page.

CONTRACT CHECK: number the sentences of the final. Label each one "setup", "hook", "promise", "event", "rule", "cost" or "act". A "promise" names an event the book contains, in the story's voice, and does not say whether they manage it. A "rule" is any sentence that says what only happens if, what opens only when, what resets, or what someone will not do — the condition a reader would use to work out the ending. An "act" is the main character in the act, the picture a parent can see; the last sentence is labelled "act" and kept. A "cost" may stand anywhere and is kept. Only "event" and "rule" are cut: every sentence marked "event" other than the last, and every sentence marked "rule". Setup, hook, promise, cost and act are kept. List every cut sentence, not one of them. Then quote the last sentence of the final: if it begins with a condition or says what happens if, move the cost earlier and end on the act. Then quote the last sentence again: if the child holds, knows or has what decides it, replace the sentence with the movement just before that.`;

const IDEA_CONTRACT_PATTERN = `This book is a pattern, not a premise. Generate a story idea that holds these five, one sentence each, in this order:
1. THE PATTERN: what happens on every page — the child does one thing, and the world answers.
2. THE VARIATION: what changes from page to page — a new animal, a new sound, a new place.
3. THE ONE THAT RESISTS: the one that will not come, will not open, will not answer.
4. THE REFRAIN: the line that is said on every page and that the child learns to say along. Write the line itself, in the output language, short enough to say in one breath.
5. THE LANDING: where it comes back to — the child going to a grown-up and to comfort, written as a movement of the body: a reach, a step, a climb into a lap. Never what the one that resists finally does.

Nothing here names what failing costs; a book at this age has no such page. Everything in it can be pointed at in a picture and named with a plain noun, and one thing only is out of the ordinary. The want, where there is one, is something to reach, follow, touch, hold or get to.

CONTRACT CHECK: quote each of the five slots from the final, one line each, and name which slot it is. A slot with nothing to quote is added to the final. Then quote any sentence that says what the one that resists finally does, and cut it. List every cut sentence, not one of them.`;

/** The age at or below which a main character gets the pattern contract. */
const PATTERN_CONTRACT_MAX_AGE = 2;

/**
 * The youngest MAIN character's age, or null when no main declares a readable
 * one. Side characters never decide: a two-year-old sibling in the cast of an
 * eight-year-old's book does not turn that book into a pattern book.
 */
function youngestMainAge(characters = []) {
  const ages = (characters || [])
    .filter(c => c && (c.isMain || c.is_main))
    .map(c => Number(c.age))
    .filter(n => Number.isFinite(n));
  return ages.length ? Math.min(...ages) : null;
}

function isPatternContract(characters = []) {
  const age = youngestMainAge(characters);
  return age !== null && age <= PATTERN_CONTRACT_MAX_AGE;
}

/** { IDEA_CONTRACT, BUY_CRITERION } for this cast. */
function buildIdeaContract(characters = []) {
  return isPatternContract(characters)
    ? { IDEA_CONTRACT: IDEA_CONTRACT_PATTERN, BUY_CRITERION: IDEA_BUY_QUESTIONS_TODDLER }
    : { IDEA_CONTRACT: IDEA_CONTRACT_PREMISE, BUY_CRITERION: IDEA_BUY_QUESTIONS };
}

module.exports = {
  IDEA_BUY_QUESTIONS,
  IDEA_BUY_QUESTIONS_TODDLER,
  IDEA_CONTRACT_PREMISE,
  IDEA_CONTRACT_PATTERN,
  PATTERN_CONTRACT_MAX_AGE,
  youngestMainAge,
  isPatternContract,
  buildIdeaContract,
};
