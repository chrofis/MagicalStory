/**
 * SHOT VOCABULARY — one definition of the camera-framing words, for every stage
 * that writes, counts, or acts on one.
 *
 * A shot word is PRODUCED by the beats planner (prompts/story-beats.txt: "about
 * two close-ups and two ultra-wides"), COUNTED here by planCounters
 * (SHOT_VARIETY / SHOT_CLOSEUP_COUNT / SHOT_ULTRAWIDE_COUNT), carried through
 * the Art Director's `shot` field (prompts/scene-expansion.txt,
 * scene-expansion-all.txt) and finally ACTED ON by the illustrator
 * (prompts/image-generation.txt).
 *
 * It was declared separately at each of those stops and the sets did not match:
 * the planner asks for `ultra-wide` pages, while the Art Director enum offered
 * `close-up | medium | wide` and the illustrator was given a meaning for three
 * of the four words. A plan line reading `ultra-wide` therefore reached two
 * stages that had no definition for it. This module is the one declaration all
 * of them read, so a word cannot exist at one stage and be unknown at the next.
 *
 * Adding a shot: add it to SHOTS (framing order) and to MATCH_ORDER. Leaving it
 * out of MATCH_ORDER throws at require time rather than silently making the new
 * word unrecognisable to the counters.
 */

/**
 * The shots, TIGHTEST FIRST. `id` is the word every stage writes and reads,
 * `match` recognises it in a free-text plan line, `definition` is what the
 * illustrator is told the word means.
 */
const SHOTS = [
  {
    id: 'close-up',
    match: /\b(?:extreme[-\s]?close[-\s]?up|close[-\s]?up|closeup|portrait)\b/i,
    definition: 'A close-up ends at the waist: legs, knees and feet lie below the bottom frame edge and cannot appear — never widen a close-up into a full-figure or establishing shot.',
  },
  {
    id: 'medium',
    match: /\b(?:medium|mid)\b/i,
    definition: 'A medium shot keeps each figure whole inside the frame.',
  },
  {
    id: 'wide',
    match: /\bwide\b/i,
    definition: 'A wide shot shows the full setting.',
  },
  {
    id: 'ultra-wide',
    match: /\b(?:ultra[-\s]?wide|extreme[-\s]?wide|establishing[-\s]?wide)\b/i,
    definition: 'An ultra-wide shot shows the whole setting from a distance, the figures small within it and both ends of any separation visible.',
  },
  // WHERE THE CAMERA STANDS (owner, 2026-09-19). The four above say how CLOSE
  // the camera is; these say where it is. They share the one field because a
  // page has one camera. Splitting them left the angle nameable only on a
  // backdrop plate's own `shot`, where it was offered and taken 5 times in ~420
  // vantages, so every page of every book was drawn at eye level.
  {
    id: 'over-the-shoulder',
    match: /\b(?:over[-\s]?the[-\s]?shoulder|over[-\s]?shoulder)\b/i,
    definition: "An over-the-shoulder shot stands behind one figure: their back and shoulder fill a front corner, large and close, and what they face sits small and deep in the opposite corner. The camera's own axis is the line between them, so the picture states who is acting on whom without having to work it out.",
  },
  {
    id: 'high-angle',
    match: /\b(?:high[-\s]?angle|from[-\s]above|looking[-\s]down[-\s]into)\b/i,
    definition: 'A high-angle shot looks down at the subject from above head height — the ground behind them, little or no sky.',
  },
  {
    id: 'low-angle',
    match: /\b(?:low[-\s]?angle|worm'?s[-\s]?eye|from[-\s]below|wide[-\s]?low)\b/i,
    definition: "A low-angle shot looks up at the subject from below — a worm's-eye view, the sky or ceiling behind them, the subject taller than the camera.",
  },
  {
    id: 'aerial',
    match: /\b(?:aerial|bird'?s[-\s]?eye|overhead[-\s]?shot|top[-\s]?down)\b/i,
    definition: "An aerial shot looks straight down from far above — a bird's-eye view of the whole place, figures seen from over their heads.",
  },
];

/**
 * Recognition order, longest-first: "ultra-wide" contains "wide", and
 * "close-up" must win over a bare "close". Anything unrecognised counts as
 * 'other' and is reported rather than silently folded into medium.
 */
const MATCH_ORDER = ['over-the-shoulder', 'ultra-wide', 'close-up', 'high-angle', 'low-angle', 'aerial', 'wide', 'medium'];

if (MATCH_ORDER.length !== SHOTS.length || MATCH_ORDER.some(id => !SHOTS.some(s => s.id === id))) {
  throw new Error('shotVocabulary: MATCH_ORDER and SHOTS disagree — every shot needs a recognition rank');
}

/** The words themselves, tightest first. */
const SHOT_TYPES = SHOTS.map(s => s.id);

/** [name, pattern] pairs in recognition order — the plan-line parser's table. */
const SHOT_PATTERNS = MATCH_ORDER.map(id => [id, SHOTS.find(s => s.id === id).match]);

/**
 * The enum as the Art Director templates state it: "`close-up`, `medium`,
 * `wide`, or `ultra-wide`".
 */
const SHOT_ENUM = SHOT_TYPES
  .map((id, i) => `${i === SHOT_TYPES.length - 1 ? 'or ' : ''}\`${id}\``)
  .join(', ');

/**
 * What each word means to the illustrator. Lives at the END of the built image
 * prompt, inside the tail shrinkPromptForModel never cuts — see
 * prompts/image-generation.txt and the 2026-09-16 decisions.md entry.
 */
const SHOT_DEFINITIONS = `**SHOT:** The scene description declares the shot. ${SHOTS.map(s => s.definition).join(' ')}`;

module.exports = {
  SHOTS,
  SHOT_TYPES,
  SHOT_PATTERNS,
  SHOT_ENUM,
  SHOT_DEFINITIONS,
};
