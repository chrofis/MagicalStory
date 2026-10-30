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

const QUESTIONS_FILE = path.join(__dirname, '../../prompts/jev-own-story.txt');

/** The closed list of story parts, in the order the checklist shows them. */
const OWN_STORY_PARTS = ['WHO', 'WHERE', 'PROBLEM', 'WANT', 'ENDING'];
/** The flag raised when the text does not fit the children's age. */
const UNSUITABLE = 'UNSUITABLE';
/** Probability at or above which a proposition counts as true. */
const OWN_STORY_THRESHOLD = 0.5;
/** Shorter texts are not analysed (the client uses the same number to decide when to ask). */
const OWN_STORY_MIN_CHARS = 40;
const OWN_STORY_MAX_CHARS = 4000;

function questionSet(age) {
  const lines = J.parseQuestionFile(fs.readFileSync(QUESTIONS_FILE, 'utf-8')).PARTS;
  const ageText = Number.isFinite(age) ? String(age) : 'the story\'s age';
  const questions = {};
  for (const q of lines) {
    questions[q.id] = { type: 'noul', instructions: q.text.replace('{AGE}', ageText) };
  }
  return questions;
}

/**
 * Typed flags from raw probabilities. Pure.
 * @returns {{present: Record<string, boolean>, missing: string[], unsuitable: boolean}}
 */
function flagsFromAnswers(answers) {
  const present = {};
  for (const id of OWN_STORY_PARTS) present[id] = J.yesProb(answers[id]) >= OWN_STORY_THRESHOLD;
  return {
    present,
    missing: OWN_STORY_PARTS.filter(id => !present[id]),
    unsuitable: J.yesProb(answers[UNSUITABLE]) >= OWN_STORY_THRESHOLD,
  };
}

/**
 * @param {string} text the parent's story text
 * @param {number} [age] age of the child the book is for (the oldest main)
 * @param {{callImpl?: Function}} [deps]
 */
async function analyseOwnStory(text, age, { callImpl = (r) => J.callJev(r) } = {}) {
  const state = String(text || '').trim();
  if (state.length < OWN_STORY_MIN_CHARS) throw new Error(`ownStoryAnalysis: text under ${OWN_STORY_MIN_CHARS} characters`);
  const r = await callImpl({ state: state.slice(0, OWN_STORY_MAX_CHARS), questions: questionSet(age) });
  return { ...flagsFromAnswers(r.answers), costUsd: Number(r.cost || 0), usage: r.usage || {}, model: r.model };
}

module.exports = { analyseOwnStory, flagsFromAnswers, questionSet, OWN_STORY_PARTS, UNSUITABLE, OWN_STORY_THRESHOLD, OWN_STORY_MIN_CHARS, OWN_STORY_MAX_CHARS };
