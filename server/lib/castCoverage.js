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

const { GROUP_STAGING_MAX } = require('./shotVocabulary');

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
  // A page LEADS with one character (owner 2026-10-06; docs/decisions.md "Every named figure leads a page"): when the book has
  // a page to spare for each, no two characters share a focal page. Larger casts keep the pairing the floor above allows.
  const leadEach = C > 1 && C <= Math.floor(P / 2);
  // Pages with people on them: every page but the one people-free page.
  const peopled = Math.max(1, P - 1);
  const slots = peopled * PAGE_CAST_TYPICAL;
  // The main character appears on most pages; the rest share what is left.
  const perCharacter = C === 1
    ? peopled
    : Math.floor((slots - Math.ceil(P / 2)) / (C - 1));
  const max = Math.max(1, Math.min(APPEARANCES_TARGET_MAX, perCharacter));
  const min = max >= APPEARANCES_TARGET_MAX ? APPEARANCES_TARGET_MIN : max;
  return { pageCount: P, castCount: C, focalEach, leadEach, focalPagesNeeded, appearances: { min, max } };
}

const pagesWord = n => `${n} page${n === 1 ? '' : 's'}`;

/**
 * HOW MANY PAGES MAY HOLD A GROUP (owner, 2026-09-27).
 *
 * The planner was told "Two or three named characters carry a page best" and
 * given the image model's ceiling (6 for Grok) in the same sentence; nothing
 * counted the preference. Measured over the 17 staging books of the 14 days to
 * 2026-09-27 (docs/decisions.md): 27 of 241 shipped plan pages held more than
 * three characters, 22 of them whole-cast pages, up to 4 in one 18-page book —
 * and those pages score worst (by the Art Director's cast: 1 → 79.4, 2 → 66.7,
 * 3 → 53.6, 4+ → 49.6).
 *
 * The budget is one page in six — three in a 16-18-page book: the opening
 * gathering, the climax and the ending, the three places the story brings
 * everyone together — and at least one.
 *
 * It never fights the coverage floor above. That floor is computed from two
 * characters a page (PAGE_CAST_TYPICAL), so pages of one to three always hold
 * it; only when a cast is too large for the book to reach the floor on pages
 * of three does the budget rise, by exactly the group pages the floor needs at
 * the image model's ceiling (`forced`).
 *
 * One object, two readers: the planner is told `groupPageRule(budget)`
 * (story-beats.txt {GROUP_PAGE_BUDGET}) and planCounters GROUP_PAGES_OVER_BUDGET
 * counts against `budget.max`.
 *
 * @param {{pageCount:number, castCount:number, maxCharactersPerScene:number}} args
 * @returns {null | {max:number, base:number, forced:number, over:number}}
 *   null when the book has no pages, or the image model cannot hold a group at
 *   all (its ceiling is the cap then, and CAST_OVER_CEILING counts it).
 */
const GROUP_PAGE_SHARE = 6;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
function groupPageBudget({ pageCount, castCount, maxCharactersPerScene } = {}) {
  const P = Math.floor(Number(pageCount));
  const ceiling = Math.floor(Number(maxCharactersPerScene));
  if (!(P > 0) || !(ceiling > GROUP_STAGING_MAX)) return null;
  const base = Math.max(1, Math.round(P / GROUP_PAGE_SHARE));
  const cov = castCoverage({ pageCount: P, castCount });
  let forced = 0;
  if (cov && cov.castCount > 1) {
    const need = Math.ceil(P / 2) + (cov.castCount - 1) * cov.appearances.min;
    const onSmallPages = GROUP_STAGING_MAX * Math.max(1, P - 1);
    if (need > onSmallPages) forced = Math.ceil((need - onSmallPages) / (ceiling - GROUP_STAGING_MAX));
  }
  return { max: Math.min(P, Math.max(base, forced)), base, forced, over: GROUP_STAGING_MAX };
}

/**
 * The budget as the planner is told it. Generic on purpose: the three example
 * moments are structural, never a story's.
 * @param {ReturnType<typeof groupPageBudget>} budget
 * @returns {string} '' when there is no budget
 */
function groupPageRule(budget) {
  if (!budget) return '';
  const over = NUMBER_WORDS[budget.over] || String(budget.over);
  return `At most ${pagesWord(budget.max)} of this book hold more than ${over} named characters, and only where the story brings them together — an opening gathering, the climax, the ending. Every other page carries one to ${over}, and each character's pages in frame come from those.`;
}

/**
 * THE TYPED PAGE PLAN'S BOOK TARGETS (Lab experiment, 2026-10-05; docs/decisions.md
 * "Typed page plan"). The numbers the planner is told up front
 * (`typedTargetsRule`) and the counters measure (planCounters.countPlanTargets)
 * are this ONE object, built from the constants above: the old shot quotas became
 * these targets, so a quota the planner was never told cannot be counted.
 *
 * @param {{pageCount:number, listed?:string[], maxCharactersPerScene:number}} args
 */
const TYPED_FACE_MIN = 1;
const TYPED_SCENERY_MIN = 1;
/**
 * HOW MANY PEOPLED PAGES MAY HOLD NO COMMISSIONED CHARACTER, one number for the
 * planner in BOTH modes (`noCommissionedRule`, story-beats.txt {NO_COMMISSIONED_DEF})
 * and the counter NO_COMMISSIONED_ON_PAGE (planCounters), which flags only the pages
 * past it (2026-10-06, the planner review: production's counter flagged the first such
 * page while only the typed planner was told one is allowed).
 */
const NO_COMMISSIONED_PAGES_MAX = 1;
const TYPED_NO_COMMISSIONED_MAX = NO_COMMISSIONED_PAGES_MAX;
/**
 * HOW LONG A PLAN LINE'S INSTANT MAY BE (owner goal: simple pictures; the reviewer's
 * edit list 2026-10-06). The planner is told the number (`planInstantRule`) and the
 * counter PLAN_INSTANT_TOO_LONG (planCounters) counts the words of the instant.
 */
const PLAN_INSTANT_MAX_WORDS = 20;
function typedPlanTargets({ pageCount, listed = [], maxCharactersPerScene } = {}) {
  const P = Math.floor(Number(pageCount));
  const C = listed.length;
  const cov = castCoverage({ pageCount: P, castCount: C });
  const group = groupPageBudget({ pageCount: P, castCount: C, maxCharactersPerScene });
  return {
    pageCount: P,
    faceMin: TYPED_FACE_MIN,
    sceneryMin: TYPED_SCENERY_MIN,
    noCommissionedMax: NO_COMMISSIONED_PAGES_MAX,
    appearancesMin: cov && C > 1 ? cov.appearances.min : 0,
    focalEach: !!(cov && C > 1 && cov.focalEach),
    mainMin: Math.ceil(P / 2),
    groupMax: group ? group.max : 0,
    cast: cov,
    group,
  };
}

/**
 * The main character's floor, as the planner is told it in BOTH modes
 * (story-beats.txt {MAIN_FLOOR}); the number is typedPlanTargets.mainMin, the one the
 * counter MAIN_UNDER_HALF measures.
 * @param {number} mainMin
 * @param {string|null} mainName
 */
function mainFloorRule(mainMin, mainName = null) {
  return `${mainName || 'The main character'} is in frame on at least ${pagesWord(mainMin)};`;
}

/** The peopled-page-without-a-commissioned-character budget, for the planner in both modes. */
function noCommissionedRule(max = NO_COMMISSIONED_PAGES_MAX) {
  return `At most ${pagesWord(max)} with figures in frame holds none of the commissioned characters; every other page with figures holds at least one.`;
}

/** The length of a plan line's instant, for the planner. */
function planInstantRule(maxWords = PLAN_INSTANT_MAX_WORDS) {
  return `The instant is at most ${maxWords} words.`;
}

/**
 * The targets as the planner is told them, before it plans a page. Only what no other part of
 * the prompt already states: the commissioned characters' pages, the page budget of people
 * without a commissioned character and the instant's length are stated once, in the
 * requirements (2026-10-06, the planner review). The main character's floor is the exception:
 * the typed mode states it here and the requirements line points back to it.
 */
function typedTargetsRule(t, mainName = null) {
  // The main character's floor stands HERE, with the targets (typed plan only, 2026-10-06: it was one sentence
  // among thirty rules and the planner stopped at 6-8 of 9 at every effort). The number is t.mainMin, the one
  // MAIN_UNDER_HALF counts; every appearance shares the page's one action (never a bystander).
  const lines = [
    `- ${mainName || 'The main character'} is in frame on at least ${pagesWord(t.mainMin)} of ${t.pageCount}, each time taking part in that page's one action; count them as you plan.`,
    `- At least ${pagesWord(t.faceMin)} of type face, and a face page shows a commissioned character.`,
    `- At least ${pagesWord(t.sceneryMin)} of type landscape or object; two are fine, ideally one of each.`,
    `- At most ${pagesWord(t.groupMax)} of type group.`,
    '- The who column names commissioned characters and the figures of the STORY LOGIC, nobody else: a figure you invent is a fault.',
  ];
  return ["THE BOOK'S TARGETS — every one is counted in code on the finished plan. A figure the STORY LOGIC names (new) is not commissioned and may share a page with commissioned characters or carry a page alone.", ...lines].join('\n');
}

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
      ? `Every commissioned character gets a focal page of their own whose instant is the action the story gives them.${cov.leadEach ? ` ${LEAD_RULE}` : ''}`
      : 'This cast is too large for a focal page each: the characters share group moments, and each character\'s own action from the story is the instant of some page.';
  return [cast, cast && mayAddDeeds ? ADDED_DEED_RULE : '', centralFigureActionRule(centralFigure)].filter(Boolean).join(' ');
}

/**
 * A focal page is ONE character's (owner 2026-10-06; docs/decisions.md "Every named figure leads a page"). One sentence for
 * the planner's cast rule and CAST block, and the plan check's question 12 (castActionRule); the counter is
 * planCounters.castTablePromises (a deed page named by two characters).
 */
const LEAD_RULE = 'A page leads with one character: two characters never share a focal page.';

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
 * The floor is stated by the CAST block's "also on" pages (castTableSpec) whenever the
 * block is written or shown; the planner is given it here only when no block stands
 * (`floor`), so the number is said once (2026-10-06, the planner review).
 *
 * @param {ReturnType<typeof castCoverage>} cov
 * @returns {string}
 */
function castCoverageRule(cov, { centralFigure = null, mayAddDeeds = false, floor: withFloor = true } = {}) {
  const floor = withFloor && cov && cov.castCount !== 1
    ? `Every commissioned character is in frame on at least ${pagesWord(cov.appearances.min)}.`
    : '';
  return [castActionRule(cov, { centralFigure, mayAddDeeds }), floor].filter(Boolean).join(' ');
}

/**
 * HOW A CAST FINDING IS ANSWERED (owner, 2026-09-25, on Lab #1494). The
 * counters' UNDER_COVERED_CHARACTER and NO_FOCAL_PAGE lines used to state the
 * count and nothing else; the re-plan of #1494 (dragon, 18 pages, four boys)
 * answered them by pouring the main character into every page that asked for
 * a commissioned character (Levin 8 -> 14 pages), took a page from Max (3 -> 2)
 * to give Kiaan a focal page, and left Kiaan on 2. The finding now carries the
 * fix: the character is cast IN — their own action on a page of its own, or a
 * neighbouring moment the group shares — and never at the cost of another
 * commissioned character's floor. The same floor is the review's `span` rule
 * for the commissioned cast (planCounters.reviewPlanChanges `castFloor`).
 */
function underCoveredFix(name, floor) {
  return `Answer it by casting ${name} in — on a page of their own whose instant is their own action, or in a neighbouring moment the group shares — never by casting out another commissioned character who would fall below ${pagesWord(floor)}.`;
}

function noFocalFix(name) {
  return `Answer it with a page whose instant is ${name}'s own action, ${name} alone or with one companion: move that action onto a page of its own, or out of a shared moment onto a neighbouring page — never by taking another character's only focal page.`;
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
 *   children  the listed names the every-child-acts rule is about: a listed
 *             adult may comfort, permit or watch, so the cast-beat check
 *             (jevAudit.jevCastBeatVoice) asks only these to act. A character
 *             with no readable age counts as a child.
 * @returns {{listed:string[], children:string[], supplied:string[], all:string[]}}
 */
// The oldest age that still counts as a child here; the idea-cache age bands
// (jevSelection.ideaAgeBands) put the grown-ups at 16 and over.
const CHILD_MAX_AGE = 15;

function commissionedCast(inputData, suppliedNames = []) {
  const chars = (inputData?.characters || []).filter(c => c && String(c.name || '').trim());
  const listed = chars.map(c => String(c.name).trim());
  const children = chars
    .filter(c => !(parseInt(c.age, 10) > CHILD_MAX_AGE))
    .map(c => String(c.name).trim());
  const lower = new Set(listed.map(n => n.toLowerCase()));
  const supplied = [];
  for (const n of (Array.isArray(suppliedNames) ? suppliedNames : [])) {
    const name = String(n || '').trim();
    if (!name || lower.has(name.toLowerCase())) continue;
    lower.add(name.toLowerCase());
    supplied.push(name);
  }
  return { listed, children, supplied, all: [...listed, ...supplied] };
}

/**
 * THE CAST TABLE (owner, 2026-09-25, on Lab #1495/#1496). The planner writes,
 * BEFORE its plan lines, one promise per commissioned character — the page
 * whose instant is their own action, and the other pages they are in frame on —
 * and one line for the last page's cast. The plan lines then keep it.
 *
 * Measured on #1495 (dragon, 18 pages, four boys) and #1496 (Fiona, 16 pages,
 * five children): the first division left Kiaan on 2 pages with no focal page,
 * Lorena on 2 of 3, and Fiona's last page held Fiona and the guard while the
 * story keeps all five together; the re-plan repaired part of it. The floor was
 * stated as a sentence the planner read and did not count against. A table it
 * fills in is a count it makes before it divides, and a promise the counters can
 * hold each plan line to (planCounters CAST_PROMISE_BROKEN).
 *
 * The number of "also on" pages is computed here, from the same castCoverage()
 * floor the counters measure — never hand-written into the prompt.
 *
 * One wording, three readers: the planner's question (castTableSpec), its
 * output format (castTableFormat), and the parser (parsePlanCastBlock).
 */
const CAST_TABLE_HEADER = '---CAST---';

/** The "also on" page count the table asks for: the floor, minus the deed page. */
function castTableAlsoCount(cov) {
  return cov ? Math.max(0, cov.appearances.min - 1) : 0;
}

/** The deed line's shape, as the planner is shown it. */
function castTableDeedLine(cov) {
  const also = castTableAlsoCount(cov);
  const focal = cov && cov.focalEach ? ', <alone, or with whom>' : '';
  const alsoPart = also > 0 ? ` — also on pages ${Array.from({ length: also }, () => '<N>').join(', ')}` : '';
  return `<name> — deed page <N>: <their own action from the story>${focal}${alsoPart}`;
}

/**
 * The planner's question (story-beats.txt {CAST_TABLE}, first division only).
 * @param {ReturnType<typeof castCoverage>} cov
 * @param {number} pageCount
 * @returns {string} '' when the book has no commissioned cast
 */
function castTableSpec(cov, pageCount, { replan = false, table = null } = {}) {
  if (!cov) return 'The book has no commissioned characters, so it has no CAST block.';
  // A re-plan keeps the table the first division wrote (it is shown under
  // RE-DIVIDE by buildReplanSection) and writes none of its own.
  if (replan) {
    return table
      ? 'Your CAST block, under RE-DIVIDE, stands: every page you return keeps what it promises, and the block itself is not rewritten.'
      : 'The division that stands has no CAST block; answer the findings and write none.';
  }
  const also = castTableAlsoCount(cov);
  const where = cov.focalEach
    ? `the page whose instant is their own action from the story, alone or with one companion${cov.leadEach ? `; ${LEAD_RULE} Every line names a different page, and a character's deed page is never another character's "also on" page` : ''}`
    : 'the page whose instant is their own action from the story, which they may share with the group';
  const more = also > 0 ? `, and ${also} more page${also === 1 ? '' : 's'} they are in frame on` : '';
  return `Write the CAST block before the plan lines. One line per commissioned character: ${where}${more}. Then page ${pageCount}, the last: the names of everyone the story keeps together at the end. Every plan line keeps what the block promises.`;
}

/** The block as the OUTPUT FORMAT shows it (first division only). */
function castTableFormat(cov, pageCount, { replan = false } = {}) {
  if (!cov || replan) return '';
  return [CAST_TABLE_HEADER, castTableDeedLine(cov), `Ending page ${pageCount}: <names, comma separated>`].join('\n');
}

/**
 * The CAST block out of a planner reply. FAILS LOUDLY — no silent default: a
 * reply without the block, without the ending line, or without a line for a
 * character on the list throws, and the caller records the error.
 *
 * "Kiaan — deed page 12: holds up the round stone he found, with Max — also on pages 1, 18"
 *   → { name: 'Kiaan', deedPage: 12, deed: 'holds up …, with Max', alsoOn: [1, 18] }
 * "Ending page 18: Levin, Julian, Max and Kiaan" → { page: 18, names: [...] }
 *
 * @param {string} raw the planner's reply
 * @param {{ listed: string[] }} opts the commission's character list
 * @returns {{ raw: string, characters: Array<{name:string, deedPage:number, deed:string, alsoOn:number[]}>,
 *   ending: {page:number, names:string[]}, extra: string[] }}
 */
function parsePlanCastBlock(raw, { listed = [] } = {}) {
  const full = String(raw || '');
  const m = full.match(/---\s*CAST\s*---([\s\S]*?)(?=\n\s*---\s*[A-Z][A-Z ]*---|$)/i);
  if (!m) throw new Error('the planner wrote no ---CAST--- block');
  const block = m[1].trim();
  const characters = [];
  const extra = [];
  let ending = null;
  const byLower = new Map(listed.map(n => [String(n).trim().toLowerCase(), n]));
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\*\*/g, '').replace(/^\s*[-*•]\s*/, '').trim();
    if (!line) continue;
    const end = line.match(/^ending\s+page\s+(\d+)\s*:\s*(.+)$/i);
    if (end) {
      const names = end[2].split(/\s*,\s*|\s+and\s+|\s*&\s*/i).map(s => s.trim()).filter(Boolean);
      ending = { page: Number(end[1]), names };
      continue;
    }
    const deed = line.match(/^(.+?)\s+[—–-]+\s+deed\s+page\s+(\d+)\s*:\s*(.+)$/i);
    if (!deed) throw new Error(`CAST block line unreadable: "${line.slice(0, 160)}"`);
    let rest = deed[3];
    let alsoOn = [];
    const alsoAt = rest.search(/\s+[—–-]+\s+also\s+on\s+pages?\b/i);
    if (alsoAt >= 0) {
      alsoOn = [...rest.slice(alsoAt).matchAll(/\d+/g)].map(x => Number(x[0]));
      rest = rest.slice(0, alsoAt);
    }
    const name = deed[1].trim();
    const known = byLower.get(name.toLowerCase());
    if (!known) { extra.push(name); continue; }
    characters.push({ name: known, deedPage: Number(deed[2]), deed: rest.trim(), alsoOn });
  }
  if (!ending) throw new Error('the CAST block has no "Ending page" line');
  const missing = listed.filter(n => !characters.some(c => c.name === n));
  if (missing.length) throw new Error(`the CAST block has no line for ${missing.join(', ')}`);
  return { raw: block, characters, ending, extra };
}

/**
 * The table as the re-plan and the plan check are shown it: the block the
 * planner wrote, verbatim.
 */
function castTableBlock(table) {
  return table && table.raw ? `${CAST_TABLE_HEADER}\n${table.raw}` : '';
}

module.exports = {
  CAST_TABLE_HEADER,
  castTableAlsoCount,
  LEAD_RULE,
  castTableSpec,
  castTableFormat,
  castTableBlock,
  parsePlanCastBlock,
  commissionedCast,
  castCoverage,
  typedPlanTargets,
  typedTargetsRule,
  mainFloorRule,
  noCommissionedRule,
  planInstantRule,
  NO_COMMISSIONED_PAGES_MAX,
  PLAN_INSTANT_MAX_WORDS,
  groupPageBudget,
  groupPageRule,
  castActionRule,
  ADDED_DEED_RULE,
  centralFigureActionRule,
  castCoverageRule,
  underCoveredFix,
  noFocalFix,
  PAGE_CAST_TYPICAL,
  APPEARANCES_TARGET_MAX,
  APPEARANCES_TARGET_MIN,
};
