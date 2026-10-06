/**
 * AI-PROSE SLOP — one source for the writer and its critic (2026-09-27).
 *
 * Each entry is one slop type with TWO phrasings of the same rule:
 *   rule      the instruction every prose pass is given — appended to
 *             STYLE_RULEBOOK (promptBuilders.js), which fills {STYLE_RULEBOOK}
 *             in the beats writer, the trial writer, the text repair, the diff
 *             pass, the lector and the blind audit;
 *   question  the proposition Jev (jevAudit.js) answers yes/no about a page.
 *             The wording was MEASURED (evals/datasets/jev-text-audit-v1, run
 *             2026-09-27_jev-v1) — changing a question changes the score, so
 *             re-run scripts/analysis/eval-jev-text-audit.js before editing one.
 *
 * `rule: null` means an existing STYLE_RULEBOOK line already states it (named in
 * `coveredBy`), so the writer is not told twice. A type the writer was never
 * told is never judged: jevAudit asks only the types listed here
 * (generator-vs-critic, sibling set `prose-slop-generator-vs-critic`).
 *
 * Deliberately NOT here:
 *   - "she felt sad" emotion labels — MOTIVE_AT_THE_ACT_RULE tells the writer a
 *     glimpse may be "a feeling named", and the last page lands one feeling
 *     "plainly"; a rule against naming feelings would contradict both.
 *   - "suddenly" — Jev answers it 0.6-0.87 on every page; it is a count
 *     (jevAudit.mechanicalChecks, MECH_SUDDENLY) and the rule below.
 * see docs/decisions.md 2026-09-27 "Jev text audit wired"
 */

const SLOP_TYPES = [
  {
    id: 'SLOP_STOCK_WONDER',
    rule: 'No stock phrases of awe or magic ("a sense of wonder", "magic filled the air", "eyes sparkling with wonder"): show the one thing that amazes.',
    question: 'The text uses a stock phrase of awe or magic, such as "a sense of wonder", "magic filled the air" or "eyes sparkling with wonder".',
  },
  {
    id: 'SLOP_BODY_CLICHE',
    rule: 'No body clichés for a feeling (a heart swelling, a heart pounding with excitement, warmth spreading through a chest): a feeling shows in what the character does or says.',
    question: 'The text describes a feeling with a cliché of the body, such as a heart swelling, a heart pounding with excitement or warmth spreading through a chest.',
  },
  {
    id: 'SLOP_FORESHADOW',
    rule: 'No narrator teasers ("little did they know", "they did not know yet that", "this was only the beginning"): the story tells what happens when it happens.',
    question: 'The text uses a narrator\'s teaser such as "little did they know", "they did not know yet that" or "this was only the beginning".',
  },
  {
    id: 'SLOP_MORAL_SUMMARY',
    rule: null,
    coveredBy: 'STYLE_RULEBOOK: no sentence tells what an event meant',
    question: 'A sentence states the moral or lesson of the story outright, such as "and so they learned that friendship is the greatest treasure".',
  },
  {
    id: 'SLOP_RULE_OF_THREE',
    rule: 'No strings of three adjectives or abstract nouns for rhythm ("brave, kind and true").',
    question: 'The text strings three abstract adjectives or nouns together for rhythm, such as "brave, kind and true" or "laughter, light and love".',
  },
  {
    id: 'SLOP_INTENSIFIER',
    rule: 'No empty intensifiers ("very", "really", "truly", "incredibly", "absolutely") where they add nothing.',
    question: 'The text leans on empty intensifiers such as "very", "really", "truly", "incredibly" or "absolutely" where they add nothing.',
  },
  {
    id: 'SLOP_REPETITIVE_OPENINGS',
    rule: 'Never three sentences in a row that begin with the same word or the same name.',
    question: 'Three or more sentences in a row begin with the same word or the same name.',
  },
  {
    id: 'SLOP_LESSON_EXPLAIN',
    rule: null,
    coveredBy: 'STYLE_RULEBOOK: the narrator never justifies, excuses or explains an action to the reader',
    question: 'The narrator explains why an action was good, kind or important, telling the reader what to think about it.',
  },
  {
    id: 'SLOP_PURPLE_SIMILE',
    rule: 'At most one simile at a time, and never a decorative one ("like a thousand tiny stars", "as if the whole world held its breath").',
    question: 'The text stacks decorative similes or metaphors, such as "like a thousand tiny stars" or "as if the whole world held its breath".',
  },
  {
    id: 'SLOP_GENERIC_ENDING',
    rule: 'No generic warm formula at a close (hearts full of love, the stars smiling down, a day they would never forget).',
    question: 'The text closes on a generic warm formula, such as hearts full of love, the stars smiling down or a day they would never forget.',
  },
  {
    id: 'SLOP_PARALLEL_NEGATION',
    rule: null,
    coveredBy: 'STYLE_RULEBOOK: no rhetorical set-pieces, no paired negations',
    question: 'The text uses a "not X, but Y" or "It wasn\'t just X. It was Y." construction for effect.',
  },
];

/** The "suddenly" rule; the critic side is the $0 count MECH_SUDDENLY (two per page flags). Banned outright (text-v4): the writer was told "at most once" here and "never" in the DO-NOT-WRITE list. */
const SUDDENLY_RULE = 'Never "suddenly" or its equivalent in the story\'s language, and never "without warning".';

/**
 * The old DO-NOT-WRITE list's writer-side bans, folded into one line (text-v4,
 * owner 2026-10-06): no jokes, the gesture bans and the once-per-book cap, the
 * page-1 openings, trait labels and buzzwords. The beats writer no longer
 * carries the separate list; every prose pass reads this line through
 * STYLE_RULEBOOK.
 */
const STOCK_BAN_RULE = 'No jokes, puns or wordplay. No stock gestures (a hand on a shoulder, ruffled hair, a knowing nod), and no gesture (a hug, a wink, a shrug, a high five) twice in the book. No "it was a [adjective] day", no weather, waking up or backstory to open page 1, no trait labels ("she was brave") and no words like dramatic, ethereal, breathtaking or stunning.';

/** The writer-side lines, in order, for STYLE_RULEBOOK. */
const SLOP_RULES = [...SLOP_TYPES.filter(t => t.rule).map(t => t.rule), SUDDENLY_RULE, STOCK_BAN_RULE];

module.exports = { SLOP_TYPES, SLOP_RULES, SUDDENLY_RULE, STOCK_BAN_RULE };
