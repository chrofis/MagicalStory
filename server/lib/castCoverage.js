/**
 * HOW MUCH OF THE BOOK EACH COMMISSIONED CHARACTER GETS — one computation for
 * the arc, the planner, and the plan counters (owner, 2026-09-23).
 *
 * Owner ruling, verbatim: "Every child gets a moment. And ideally we have them
 * in multiple images. Depends on the story length and amount of characters,
 * ideally each one is on 3-4 images. Fine for up to 2-3 characters and long
 * books, but for 7 characters in 10 pages it will not work."
 *
 * So the numbers scale with the book, and they are computed here, once:
 *
 *   focal page   every commissioned character gets a page of their own — alone
 *                or with one companion sharing the action, the planner's own
 *                definition — whenever the book has room for one each. Two
 *                characters can share one focal page, so a cast of C needs
 *                ceil(C/2) such pages; they may take at most half the book.
 *                When they cannot, the cast shares group moments instead and
 *                nobody is dropped (the appearance floor below still holds).
 *   appearances  a target of 3 to 4 pages in frame per character, scaled down
 *                as the cast grows or the book shrinks. The pages the book can
 *                give are counted from what a page holds best — two named
 *                characters — on every page but the one people-free page the
 *                book owes, after the main character takes half the book.
 *
 * The planner is told these numbers (`castCoverageRule`), and the counters
 * measure against the SAME object (planCounters `NO_FOCAL_PAGE`,
 * `UNDER_COVERED_CHARACTER`), so the generator and its critic can never hold
 * the book to two different floors — the doctrine in
 * feedback_mechanical_rules_and_fed_back_retries: the number is computed in
 * code and injected into both sides.
 *
 * The count is the commission's character list. Figures the commission names
 * elsewhere — a pet in the premise or in a character's details — are
 * commissioned, never invented (commissionedCast below), but they
 * are not the children this rule is about and owe the book no page.
 */

/** Named characters a page carries best (story-beats.txt: "Two or three named characters carry a page best"; "Stage a page with two people rather than three when two carry it"). */
const PAGE_CAST_TYPICAL = 2;
/** The owner's target: "ideally each one is on 3-4 images". */
const APPEARANCES_TARGET_MAX = 4;
const APPEARANCES_TARGET_MIN = 3;

/**
 * @param {{pageCount:number, castCount:number}} args
 * @returns {null | {pageCount:number, castCount:number, focalEach:boolean,
 *   focalPagesNeeded:number, appearances:{min:number, max:number}}}
 *   null when either count is missing — the caller has no cast to hold to a floor.
 */
function castCoverage({ pageCount, castCount } = {}) {
  const P = Math.floor(Number(pageCount));
  const C = Math.floor(Number(castCount));
  if (!(P > 0) || !(C > 0)) return null;
  const focalPagesNeeded = Math.ceil(C / 2);
  const focalEach = C === 1 || focalPagesNeeded <= Math.floor(P / 2);
  // Pages with people on them: every page but the one people-free page.
  const peopled = Math.max(1, P - 1);
  const slots = peopled * PAGE_CAST_TYPICAL;
  // The main character appears on most pages; the rest share what is left.
  const perCharacter = C === 1
    ? peopled
    : Math.floor((slots - Math.ceil(P / 2)) / (C - 1));
  const max = Math.max(1, Math.min(APPEARANCES_TARGET_MAX, perCharacter));
  const min = max >= APPEARANCES_TARGET_MAX ? APPEARANCES_TARGET_MIN : max;
  return { pageCount: P, castCount: C, focalEach, focalPagesNeeded, appearances: { min, max } };
}

const pagesWord = n => `${n} page${n === 1 ? '' : 's'}`;

/**
 * The rule as a stage is told it. `unit: 'page'` is the planner's form (it
 * divides into pages and knows what a focal page is); `unit: 'story'` is the
 * arc's form (it writes numbered sentences, not pages, so it is told the
 * moment each character owes and never a page count).
 *
 * @param {ReturnType<typeof castCoverage>} cov
 * @param {{unit?: 'page'|'story'}} [opts]
 * @returns {string} '' when there is no coverage to state
 */
function castCoverageRule(cov, { unit = 'page' } = {}) {
  if (!cov) return '';
  const { min, max } = cov.appearances;
  if (unit === 'story') {
    if (cov.castCount === 1) return '';
    return cov.focalEach
      ? 'Every commissioned character gets a moment of their own — something they do that counts — and takes part in more than one scene.'
      : 'The cast is large for this book: the characters share group moments, and every one of them takes part — nobody is left out.';
  }
  const span = min === max ? `at least ${pagesWord(min)}` : `${min} to ${max} pages`;
  if (cov.castCount === 1) return '';
  return cov.focalEach
    ? `Every commissioned character gets a focal page of their own and is in frame on ${span}.`
    : `This cast is too large for a focal page each: the characters share group moments, and every commissioned character is in frame on ${span}.`;
}

/**
 * WHO THE COMMISSION SUPPLIED — the one definition the plan counters and the
 * arc's counting rule share (2026-09-23).
 *
 *   listed    the commission's character list: the children (and any adult)
 *             the family entered. They owe the book the coverage above.
 *   supplied  figures the commission names outside that list — in the premise,
 *             or in a character's saved details (a sibling, a friend, a pet, a
 *             companion) — as the arc reports them under "Premise figures:".
 *             Commissioned, never invented, and owe the book no page.
 *   all       both, the set the invented-cast counters subtract.
 *
 * The arc is the only reader of the saved details (free text, in the family's
 * language), so the supplied names come from its own declared list and never
 * from a scan of that text.
 *
 * @param {Object} inputData  the job input (its `characters` list)
 * @param {string[]} [suppliedNames]  the arc's "Premise figures:" names
 * @returns {{listed:string[], supplied:string[], all:string[]}}
 */
function commissionedCast(inputData, suppliedNames = []) {
  const listed = (inputData?.characters || []).map(c => c && String(c.name || '').trim()).filter(Boolean);
  const lower = new Set(listed.map(n => n.toLowerCase()));
  const supplied = [];
  for (const n of (Array.isArray(suppliedNames) ? suppliedNames : [])) {
    const name = String(n || '').trim();
    if (!name || lower.has(name.toLowerCase())) continue;
    lower.add(name.toLowerCase());
    supplied.push(name);
  }
  return { listed, supplied, all: [...listed, ...supplied] };
}

module.exports = {
  commissionedCast,
  castCoverage,
  castCoverageRule,
  PAGE_CAST_TYPICAL,
  APPEARANCES_TARGET_MAX,
  APPEARANCES_TARGET_MIN,
};
