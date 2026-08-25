/**
 * Idea provenance — did the story come from OUR idea, our idea after the
 * customer edited it, or an idea they wrote themselves? (owner, 2026-08-25)
 *
 * Why it exists: when a story turns out strange, the first question is whose
 * premise it was. A story built on an idea we generated has to be good. A story
 * built on a premise the customer introduced is a different conversation, and
 * without this we cannot tell the two apart after the fact.
 *
 * The raw material was always there — the wizard sends `ideaGeneration` on the
 * create-story payload — but `server/routes/jobs.js` only logged it, and
 * `story_jobs` rows are pruned, so it was gone by the time anyone asked.
 *
 * `selectedIndex` alone is NOT the answer: typing in the wizard's textarea
 * calls `setStoryDetails` without resetting `selectedIdeaIndex`, so a story
 * whose text was rewritten after picking still carries the index of the idea it
 * started from. That is exactly why the used text is compared, not trusted.
 */
'use strict';

const SOURCES = {
  OURS_UNCHANGED: 'ours-unchanged',
  OURS_EDITED: 'ours-edited',
  USER_WRITTEN: 'user-written',
};

/**
 * Compare two idea texts. Exact match by owner's choice (2026-08-25) — no
 * similarity threshold, so a corrected typo and a full rewrite both count as
 * edited. Only trailing/leading whitespace and line-ending style are forgiven,
 * because a textarea round-trip changes those without the customer touching a
 * word.
 */
function sameIdea(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Resolve where a story's idea came from.
 *
 * @param {Object}   story
 * @param {string}   story.storyDetails         the idea the story was generated from
 * @param {Object}   [story.ideaGeneration]     what the wizard offered: { output: string[], selectedIndex: number|null }
 * @param {boolean}  [story.trialMode]          trials cannot edit the idea (TrialIdeasStep has no textarea)
 * @returns {{source: string, original: string|null, used: string}}
 */
function resolveIdeaProvenance(story = {}) {
  const used = String(story.storyDetails || '').trim();
  const offered = Array.isArray(story.ideaGeneration?.output) ? story.ideaGeneration.output : [];
  const idx = story.ideaGeneration?.selectedIndex;
  const selected = Number.isInteger(idx) && idx >= 0 && idx < offered.length ? offered[idx] : null;

  // The trial has no way to edit: TrialIdeasStep gates creation on a selected
  // index and renders no textarea, and TrialWizard posts generatedIdeas[i]
  // verbatim. Stamp it as ours even when the payload carried no ideaGeneration
  // block, so the column is never null for a trial (owner, 2026-08-25).
  if (story.trialMode) {
    return { source: SOURCES.OURS_UNCHANGED, original: selected || used || null, used };
  }

  if (selected) {
    return sameIdea(selected, used)
      ? { source: SOURCES.OURS_UNCHANGED, original: selected, used }
      : { source: SOURCES.OURS_EDITED, original: selected, used };
  }

  // No selection recorded. It may still match something we offered — the
  // customer can pick an idea, navigate away and come back, losing the index
  // but not the text.
  const match = offered.find((o) => sameIdea(o, used));
  if (match) return { source: SOURCES.OURS_UNCHANGED, original: match, used };

  return { source: SOURCES.USER_WRITTEN, original: null, used };
}

module.exports = { resolveIdeaProvenance, sameIdea, SOURCES };
