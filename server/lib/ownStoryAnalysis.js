/**
 * "Own story" check in the wizard's idea step (owner, 2026-10-30): while a
 * parent types a story idea, Jev says which story parts the text already has.
 *
 * Jev answers yes-probabilities (`noul`) and generates no prose, so the
 * "tip" the UI shows is NOT Jev text: code turns each probability into a typed
 * present/missing flag here, and the client shows a fixed, translated tip for
 * the first missing part. Nothing in this path reads free text.
 * Questions: prompts/jev-own-story.txt (versioned).
 */

const fs = require('fs');
const path = require('path');
const J = require('./jevAudit');
const { arcEventRange } = require('./promptBuilders');

const QUESTIONS_FILE = path.join(__dirname, '../../prompts/jev-own-story.txt');

/** The closed list of story parts, in the order the checklist shows them. */
const OWN_STORY_PARTS = ['WHO', 'WHERE', 'PROBLEM', 'WANT', 'ENDING'];
/**
 * Depth checks (owner, 2026-11-01): a part can be named and still be thin. Each depth flag belongs to one
 * part; a part whose depth is missing counts as not done and the client shows that part's fixed depth tip.
 * WANT and ENDING have no depth check.
 */
const DEPTH_FLAGS = { WHO: 'WHO_DEPTH', WHERE: 'WHERE_DEPTH', PROBLEM: 'PROBLEM_DEPTH' };
/** Pages from which one problem is too thin for the book: two are wanted, from the second step three. */
const PROBLEM_PAGES_FOR_TWO = 14;
const PROBLEM_PAGES_FOR_THREE = 28;

/** The flag raised when the text does not fit the children's age. */
const UNSUITABLE = 'UNSUITABLE';
/** The flag raised when the text names more events than the chosen book comfortably holds. */
const TOO_MANY_EVENTS = 'TOO_MANY_EVENTS';
/** Probability at or above which a proposition counts as true. */
const OWN_STORY_THRESHOLD = 0.5;
/** Shorter texts are not analysed (the client uses the same number to decide when to ask). */
const OWN_STORY_MIN_CHARS = 40;
const OWN_STORY_MAX_CHARS = 4000;

/** How many separate problems the chosen page count wants. 1 means the PROBLEM_DEPTH question is not asked. */
function problemsWanted(pages) {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('ownStoryAnalysis: pages is required');
  return pages >= PROBLEM_PAGES_FOR_THREE ? 3 : pages >= PROBLEM_PAGES_FOR_TWO ? 2 : 1;
}

/**
 * The event number the Jev question names IS the arc's budget for this book:
 * arcEventRange, the function the arc prompts state and the code counts with,
 * never a copied number. The own-story book keeps every event the parent wrote
 * (docs/decisions.md 2026-10-31), so this only warns the parent; it never limits.
 * @param {number} [age]
 * @param {{pages: number, languageLevel?: string}} book
 */
function questionSet(age, { pages, languageLevel } = {}) {
  if (!Number.isInteger(pages) || pages < 1) throw new Error('ownStoryAnalysis: pages is required');
  const lines = J.parseQuestionFile(fs.readFileSync(QUESTIONS_FILE, 'utf-8')).PARTS;
  const ageText = Number.isFinite(age) ? String(age) : 'the story\'s age';
  // Same input shape the arc builders read: the oldest main's age and the reading level.
  const budgetInput = { languageLevel, characters: Number.isFinite(age) ? [{ age, isMain: true }] : [] };
  const events = String(arcEventRange(budgetInput, pages).hi);
  const problems = problemsWanted(pages);
  const questions = {};
  for (const q of lines) {
    if (q.id === DEPTH_FLAGS.PROBLEM && problems < 2) continue;   // one problem is enough for a short book: not asked
    questions[q.id] = { type: 'noul', instructions: q.text.replace('{AGE}', ageText).replaceAll('{EVENTS}', events).replaceAll('{PAGES}', String(pages)).replaceAll('{PROBLEMS}', String(problems)) };
  }
  return questions;
}

/**
 * Typed flags from raw probabilities. Pure.
 * `present` is final: a part counts only when it is named AND its depth holds. `thin` lists the parts that are
 * named but lack depth (the client shows their depth tip instead of the "say it" tip). A depth question that
 * was not asked (no answer) counts as satisfied.
 * @returns {{present: Record<string, boolean>, missing: string[], thin: string[], unsuitable: boolean, tooManyEvents: boolean}}
 */
function flagsFromAnswers(answers) {
  const present = {};
  const thin = [];
  for (const id of OWN_STORY_PARTS) {
    const named = J.yesProb(answers[id]) >= OWN_STORY_THRESHOLD;
    const depthAnswer = DEPTH_FLAGS[id] ? answers[DEPTH_FLAGS[id]] : undefined;
    const deep = depthAnswer === undefined || J.yesProb(depthAnswer) >= OWN_STORY_THRESHOLD;
    present[id] = named && deep;
    if (named && !deep) thin.push(id);
  }
  return {
    present,
    missing: OWN_STORY_PARTS.filter(id => !present[id]),
    thin,
    unsuitable: J.yesProb(answers[UNSUITABLE]) >= OWN_STORY_THRESHOLD,
    tooManyEvents: J.yesProb(answers[TOO_MANY_EVENTS]) >= OWN_STORY_THRESHOLD,
  };
}

/**
 * @param {string} text the parent's story text
 * @param {number} [age] age of the child the book is for (the oldest main)
 * @param {{pages: number, languageLevel?: string}} book the chosen book (sizes the event question)
 * @param {{callImpl?: Function}} [deps]
 */
async function analyseOwnStory(text, age, book, { callImpl = (r) => J.callJev(r) } = {}) {
  const state = String(text || '').trim();
  if (state.length < OWN_STORY_MIN_CHARS) throw new Error(`ownStoryAnalysis: text under ${OWN_STORY_MIN_CHARS} characters`);
  const r = await callImpl({ state: state.slice(0, OWN_STORY_MAX_CHARS), questions: questionSet(age, book) });
  return { ...flagsFromAnswers(r.answers), costUsd: Number(r.cost || 0), usage: r.usage || {}, model: r.model };
}

module.exports = { analyseOwnStory, flagsFromAnswers, questionSet, problemsWanted, DEPTH_FLAGS, OWN_STORY_PARTS, UNSUITABLE, TOO_MANY_EVENTS, OWN_STORY_THRESHOLD, OWN_STORY_MIN_CHARS, OWN_STORY_MAX_CHARS };
