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
 * The planner and the plan check are told these numbers (`castCoverageRule`), and the counters
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
 * The ACTION half of the page plan's cast rule — the link to the arc's own rule
 * (every child does something of their own, owner 2026-09-23): the planner is
 * told each character's action is a page's instant, and the plan check (Q12)
 * asks the same sentence. It carries no page count on purpose: given "in frame
 * on 3 to 4 pages", the checker read the range as a CAP and filed a must-fix
 * finding against every child who appeared more often (validation call on
 * job_1790100385959_1nitlympp, 2026-09-23). The counts are the counters' job.
 *
 * THE CENTRAL FIGURE (owner, 2026-09-24, d4): when the arc's STORY LOGIC names
 * one, the same sentence tells the planner and the checker that it acts in each
 * third of the book. The arc's critique used to certify "acts in every third"
 * itself; the per-third presence is now the counter CENTRAL_FIGURE_ABSENT_THIRD
 * and "acts, never carried" is judged on the pages by Q12's ACTION line.
 *
 * `mayAddDeeds` (Test Lab only, 2026-09-25; production never passes it): the
 * planner may give a character the arc left without a deed one small deed
 * inside an existing event (ADDED_DEED_RULE). One string, planner and checker,
 * so the checker accepts what the planner was allowed.
 *
 * @param {ReturnType<typeof castCoverage>} cov
 * @param {{ centralFigure?: string[]|null, mayAddDeeds?: boolean }} [opts] the names the arc gave the figure
 * @returns {string} '' when there is no cast rule and no central figure
 */
function castActionRule(cov, { centralFigure = null, mayAddDeeds = false } = {}) {
  const cast = !cov || cov.castCount === 1
    ? ''
    : cov.focalEach
      ? 'Every commissioned character gets a focal page of their own whose instant is the action the story gives them.'
      : 'This cast is too large for a focal page each: the characters share group moments, and each character\'s own action from the story is the instant of some page.';
  return [cast, cast && mayAddDeeds ? ADDED_DEED_RULE : '', centralFigureActionRule(centralFigure)].filter(Boolean).join(' ');
}

/** The Lab A/B sentence of castActionRule (`mayAddDeeds`). */
const ADDED_DEED_RULE = 'A commissioned character the story gives no action of their own may be given one small action inside an existing event — one that serves that event and changes nothing in the plot, the order of events or the outcome.';

/** The central-figure sentence of castActionRule; '' when the arc named none. */
function centralFigureActionRule(centralFigure) {
  const names = (Array.isArray(centralFigure) ? centralFigure : []).map(n => String(n || '').trim()).filter(Boolean);
  if (!names.length) return '';
  return `The story's central figure, ${names.join(' / ')}, acts in each third of the book — it chooses, moves, speaks or changes something in a page's instant, never only carried.`;
}

/**
 * The whole rule as the PLANNER is told it ({CAST_COVERAGE} in story-beats.txt):
 * the action half above plus the appearance floor the counters measure
 * (UNDER_COVERED_CHARACTER at `appearances.min`). Stated as a floor — "at least"
 * — never as a range a reader could take for a ceiling.
 *
 * @param {ReturnType<typeof castCoverage>} cov
 * @returns {string}
 */
function castCoverageRule(cov, { centralFigure = null, mayAddDeeds = false } = {}) {
  const floor = cov && cov.castCount !== 1
    ? `Every commissioned character is in frame on at least ${pagesWord(cov.appearances.min)}.`
    : '';
  return [castActionRule(cov, { centralFigure, mayAddDeeds }), floor].filter(Boolean).join(' ');
}

/**
 * WHO THE COMMISSION SUPPLIED — the one definition the plan counters and the
 * arc's counting rule share (2026-09-23).
 *
 *   listed    the commission's character list: the children (and any adult)
 *             the family entered. They owe the book the coverage above.
 *   supplied  figures the commission names outside that list — in the premise,
 *             or in a character's saved details (a sibling, a friend, a pet, a
 *             companion) — as the arc's STORY LOGIC tags them "(commissioned)"
 *             (since 2026-09-24; the "Premise figures:" list before).
 *             Commissioned, never invented, and owe the book no page.
 *   all       both, the set the invented-cast counters subtract.
 *
 * The arc is the only reader of the saved details (free text, in the family's
 * language), so the supplied names come from its own declared list and never
 * from a scan of that text.
 *
 * @param {Object} inputData  the job input (its `characters` list)
 * @param {string[]} [suppliedNames]  the arc's (commissioned)-tagged figure names
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
  castActionRule,
  ADDED_DEED_RULE,
  centralFigureActionRule,
  castCoverageRule,
  PAGE_CAST_TYPICAL,
  APPEARANCES_TARGET_MAX,
  APPEARANCES_TARGET_MIN,
};
