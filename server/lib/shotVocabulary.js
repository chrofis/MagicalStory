/**
 * SHOT VOCABULARY — one definition of the camera-framing words, for every stage
 * that writes, counts, or acts on one.
 *
 * A shot word is PRODUCED by the beats planner (prompts/story-beats.txt, which
 * states the distribution shotDistributionPhrase below builds), COUNTED here by
 * planCounters
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
 * THE NEAR FIGURE OF AN OVER-THE-SHOULDER SHOT IS A CROP (owner, 2026-09-23).
 *
 * Dragon run 6 p10 (staging job_1790100385959_1nitlympp) declared
 * `over-the-shoulder` and rendered a full figure seen from behind: the brief
 * gave the near figure `back view`, the builder's back-view directive then asked
 * for hips and both feet, and the height line and the full outfit asked for the
 * whole body a second and third time. Feet in frame pull the camera back and the
 * shot stops being an over-the-shoulder at all.
 *
 * One phrase, read by the shot definition the illustrator gets, the
 * Art Director / iterate rule (OTS_NEAR_FIGURE_RULE) and the image builder's
 * per-figure perspective directive, so the three cannot describe different
 * crops. Positive only, and never the words "back view": Grok anchors on the
 * pose-category word and ignores the qualifier after it.
 */
const OTS_NEAR_FIGURE_CROP = 'the back of the head, one shoulder and the upper arm, large in a front corner and cut by the frame edge; nothing below the shoulder blades is in frame. The camera sees the back of their head and their hair; their face is turned away from us, into the picture';

/**
 * The shots, TIGHTEST FIRST. `id` is the word every stage writes and reads,
 * `match` recognises it in a free-text plan line, `definition` is what the
 * illustrator is told the word means, and `axis` says WHICH QUESTION the word
 * answers — `distance` (how close the camera is) or `position` (where it
 * stands).
 *
 * The axis exists because the field is one-of: a page that declares
 * `high-angle` has spent its one word and can no longer state a distance. A
 * counter that treats all eight as interchangeable therefore mis-reads them —
 * `SHOT_VARIETY` would accept medium/wide/aerial as three "shot types" while
 * the book holds only two distances. Counters read the axis rather than
 * re-listing which words are which; a hand-kept second list is exactly the
 * drift this module was written to end.
 */
const SHOTS = [
  {
    id: 'close-up',
    axis: 'distance',
    match: /\b(?:extreme[-\s]?close[-\s]?up|close[-\s]?up|closeup|portrait)\b/i,
    definition: 'A close-up ends at the waist: legs, knees and feet lie below the bottom frame edge and cannot appear — never widen a close-up into a full-figure or establishing shot.',
  },
  {
    id: 'medium',
    axis: 'distance',
    match: /\b(?:medium|mid)\b/i,
    definition: 'A medium shot keeps each figure whole inside the frame.',
  },
  {
    id: 'wide',
    axis: 'distance',
    match: /\bwide\b/i,
    definition: 'A wide shot shows the full setting.',
  },
  {
    id: 'ultra-wide',
    axis: 'distance',
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
    axis: 'position',
    match: /\b(?:over[-\s]?the[-\s]?shoulder|over[-\s]?shoulder)\b/i,
    definition: `An over-the-shoulder shot stands behind one figure, who is a crop: ${OTS_NEAR_FIGURE_CROP}. What they face sits far across the frame, small and deep in the opposite corner, several body lengths away. The camera's own axis is the line between them, so the picture states who is acting on whom without having to work it out.`,
  },
  {
    id: 'high-angle',
    axis: 'position',
    match: /\b(?:high[-\s]?angle|from[-\s]above|looking[-\s]down[-\s]into)\b/i,
    definition: 'A high-angle shot looks down at the subject from above head height — the ground behind them, little or no sky.',
  },
  {
    id: 'low-angle',
    axis: 'position',
    match: /\b(?:low[-\s]?angle|worm'?s[-\s]?eye|from[-\s]below|wide[-\s]?low)\b/i,
    // THE ONE GUARD ON A CAMERA POSITION (2026-09-19). A low angle makes its
    // subject tower, which is the whole point of the shot and exactly wrong
    // pointed at a grown-up or a creature standing over a small child. The
    // creature-tone bands already forbid a creature "leaning or towering over a
    // child" (ages <=4) and require it "framed at the child's eye level" (5-6),
    // but they constrain the CREATURE'S ENTRY, not the page's camera — so
    // without this the formidable band (7+), which explicitly licenses looming,
    // could be handed a low-angle page and nothing would join the two. The guard
    // lives on the word itself so it reaches the planner, both Art Director
    // templates, both iterate templates and the illustrator from one place.
    definition: "A low-angle shot looks up at the subject from below — a worm's-eye view, the sky or ceiling behind them, the subject taller than the camera. Look up at a thing, a height, a tree or a sky; never up at a grown-up or a creature standing over a child.",
  },
  {
    id: 'aerial',
    axis: 'position',
    match: /\b(?:aerial|bird'?s[-\s]?eye|overhead[-\s]?shot|top[-\s]?down)\b/i,
    definition: "An aerial shot looks straight down from far above — a bird's-eye view of the whole place, figures seen from over their heads.",
  },
];

/**
 * NO OVER-THE-SHOULDER ON CONTACT (owner, 2026-09-23).
 *
 * What the near figure faces sits "small and deep in the opposite corner" —
 * that is the shot, and it is kept. A page whose near figure TOUCHES what they
 * face cannot hold it: the thing touched is at arm's length, so it is either
 * drawn large beside the shoulder (no over-the-shoulder left) or the camera
 * pulls back to fit both (a full figure seen from behind, run 6 p10). The page
 * takes another shot instead.
 *
 * Contact is a reading of the plan line and the brief, so the rule lives in
 * the prompts, stated to every stage that can put the word on a page: the
 * beats planner (story-beats.txt), both Art Director templates and both
 * iterate templates. No counter checks it — a plan line is prose and carries no
 * structured contact field, and code does not classify prose.
 */
const OTS_NO_CONTACT_RULE = "Over-the-shoulder never goes on a page where the near figure touches what they face — a hand laid on it, a grip, a lean against it, a hand-over: whatever is touched is within arm's reach and cannot sit small and deep in the far corner. Such a page takes another shot.";

/**
 * The Art Director / iterate half: which perspective the near figure gets and
 * what its prose may describe. Filled into scene-expansion.txt,
 * scene-expansion-all.txt, scene-iteration.txt and scene-iteration-free.txt.
 */
const OTS_NEAR_FIGURE_RULE = `On an \`over-the-shoulder\` page the figure nearest the camera gets \`perspective: over-the-shoulder\` — never \`back view\` and never a glance over the shoulder — and is seen as a crop: ${OTS_NEAR_FIGURE_CROP}. Describe only what that crop shows: the hair, the collar and sleeve of the upper garment, anything held up into frame. That figure's prose names no legs, trousers, footwear or stance, and it looks straight ahead into the scene toward what it faces — never up at it. ${OTS_NO_CONTACT_RULE}`;

/**
 * Whether a character annotation declares the over-the-shoulder near figure.
 * Reads the structured `perspective` field only.
 */
function isOverTheShoulderPerspective(perspective) {
  return /^over[-\s]?the[-\s]?shoulder\b/i.test(String(perspective || '').trim());
}

/**
 * Recognition order, longest-first: "ultra-wide" contains "wide", and
 * "close-up" must win over a bare "close". Anything unrecognised counts as
 * 'other' and is reported rather than silently folded into medium.
 */
const MATCH_ORDER = ['over-the-shoulder', 'ultra-wide', 'close-up', 'high-angle', 'low-angle', 'aerial', 'wide', 'medium'];

if (MATCH_ORDER.length !== SHOTS.length || MATCH_ORDER.some(id => !SHOTS.some(s => s.id === id))) {
  throw new Error('shotVocabulary: MATCH_ORDER and SHOTS disagree — every shot needs a recognition rank');
}

const SHOT_AXES = ['distance', 'position'];
if (SHOTS.some(s => !SHOT_AXES.includes(s.axis))) {
  throw new Error('shotVocabulary: every shot declares axis `distance` or `position` — a counter reads it to know which question the word answers');
}

/** The words themselves, tightest first. */
const SHOT_TYPES = SHOTS.map(s => s.id);

/** id → axis. The counters' lookup; nothing re-lists which words are angles. */
const SHOT_AXIS = Object.fromEntries(SHOTS.map(s => [s.id, s.axis]));

/** The words on one axis, in framing order. */
const shotsOnAxis = (axis) => SHOTS.filter(s => s.axis === axis).map(s => s.id);

/** How close the camera is: close-up … ultra-wide. */
const DISTANCE_SHOTS = shotsOnAxis('distance');

/** Where the camera stands: anything that is not eye-level-and-square-on. */
const POSITION_SHOTS = shotsOnAxis('position');

/** [name, pattern] pairs in recognition order — the plan-line parser's table. */
const SHOT_PATTERNS = MATCH_ORDER.map(id => [id, SHOTS.find(s => s.id === id).match]);

/**
 * The enum as the Art Director templates state it: "`close-up`, `medium`,
 * `wide`, or `ultra-wide`".
 */
const SHOT_ENUM = SHOT_TYPES
  .map((id, i) => `${i === SHOT_TYPES.length - 1 ? 'or ' : ''}\`${id}\``)
  .join(', ');

/** The camera POSITIONS as the beats planner is offered them. */
const SHOT_POSITIONS = POSITION_SHOTS
  .map((id, i) => `${i === POSITION_SHOTS.length - 1 ? 'or ' : ''}\`${id}\``)
  .join(', ');

/**
 * What each word means to the illustrator. Lives at the END of the built image
 * prompt, inside the tail shrinkPromptForModel never cuts — see
 * prompts/image-generation.txt and the 2026-09-16 decisions.md entry.
 */
const SHOT_DEFINITIONS = `**SHOT:** The scene description declares the shot. ${SHOTS.map(s => s.definition).join(' ')}`;

/** The lead-in every SHOT block opens with, whichever definitions follow. */
const SHOT_RULE_LEAD = '**SHOT:** The scene description declares the shot.';

/**
 * THE SHOT BLOCK FOR ONE PAGE — its declared shot's definition, nothing else.
 *
 * The full table is 1,223 characters for eight shots, and a page draws ONE.
 * Measured on staging job_1789853503332_riqncqg1i (18 pages, grok cap 7,900):
 * every page's built prompt ran 8.5-10.2k, the table was 16% of the whole
 * budget, and `sectionAwareCut` paid for it by deleting AGE & PROPORTIONS,
 * HEIGHT ORDER, the plate-vs-identity reference rule and the Composition block
 * on all fifteen pages that stored a prompt. Seven definitions the page cannot
 * use cost it four blocks it needs.
 *
 * Resolution order: the Art Director's own `shot` field first, then the shot
 * word in the scene prose. Neither → '' and the caller logs it: a block that
 * defines words nobody wrote is the waste this function exists to end, and
 * printing all eight "just in case" is exactly the behaviour being removed.
 *
 * @param {string|null} shotHint - metadata.shot / fullData.shot
 * @param {string|null} sceneText - the scene prose, searched when no field
 * @returns {{ text: string, shot: string|null }}
 */
function buildShotDefinitions(shotHint, sceneText = null) {
  const resolve = (s) => {
    if (!s) return null;
    for (const [id, pattern] of SHOT_PATTERNS) if (pattern.test(String(s))) return id;
    return null;
  };
  const id = resolve(shotHint) || resolve(sceneText);
  if (!id) return { text: '', shot: null };
  const shot = SHOTS.find(s => s.id === id);
  return { text: `${SHOT_RULE_LEAD} ${shot.definition}`, shot: id };
}

/**
 * HOW MANY PAGES OF EACH — the one declaration of the distribution, read by the
 * planner that WRITES the shots (prompts/story-beats.txt, via
 * shotDistributionPhrase) and by the counters that MEASURE them
 * (server/lib/planCounters.js, via shotFloors). One table, so the book is never
 * marked down against a spread nobody asked it for.
 *
 * MEASURED, 11 staging books / 180 pages over the 14 days to 2026-09-20:
 * medium 76 (42%), wide 54 (30%), close-up 37 (21%), ultra-wide 10 (5.6%),
 * high-angle 2 (1.1%), over-the-shoulder 1 (0.6%), aerial 0. Medium plus wide
 * is 72% of every page shipped, and a camera position appears on 3 pages in 180.
 *
 * The planner was COMPLYING. The prompt asked for "about two close-ups and two
 * ultra-wides, the rest medium or wide", which on an 18-page book is an explicit
 * request for ~78% medium-or-wide. The fix is therefore the prompt first — it
 * now states this table — and the counters second (owner, 2026-09-20).
 *
 * Why a SHARE and not a count: the cap scales to any book length with no
 * threshold to maintain. Why TIERED floors: a 6-page trial must not be asked for
 * two over-the-shoulder pages.
 *
 * `ultra-wide` is a DISTANCE and `aerial` is a POSITION — different shots on
 * different axes, each with its own floor. They are never folded together.
 */
const MAX_MEDIUM_WIDE_SHARE = 0.5;

/**
 * The two middle distances the cap is about — the default framings a book falls
 * back on when no page earns anything else. Declared here so the counters read a
 * name instead of spelling the two words out for themselves.
 */
const MID_DISTANCE_SHOTS = ['medium', 'wide'];

/**
 * THE PEOPLELESS PAGE MAY BE THE ULTRA-WIDE PAGE (owner, 2026-09-20).
 *
 * "Books of 10 page allow a bit of freedom, for example put ultra-wide and no
 * person together as 1, so only 5 or so are spoken for."
 *
 * A short book had NO slack. At 9-13 pages the floors mandate close-up 2 +
 * ultra-wide 1 + aerial 1 + over-the-shoulder 1 = 5 shot pages, and
 * `NO_PEOPLELESS_PAGE` (must-fix) demands a sixth page with no cast in it,
 * against a medium/wide ceiling of 4 at nine pages and 5 at ten. Six mandated
 * pages plus a ceiling of 5 needs an 11-page book; 9 and 10 were therefore
 * UNSATISFIABLE, and the planner could only ship one finding or the other.
 *
 * The two demands are orthogonal and always were: `shot` is a camera word, and
 * peopleless is a property of the CAST. An ultra-wide landscape with nobody in
 * it is the natural page to be both, so one page discharges both.
 *
 * AT EVERY LENGTH, not below a threshold. Joint satisfaction is only NEEDED at
 * 9-10 pages (see the arithmetic in tests/unit/shot-distribution-floors.test.ts,
 * which walks 4-40), but it is a PERMISSION, not a quota. A permission that is
 * legal at ten pages and illegal at eighteen would be an arbitrary threshold
 * with nothing behind it and one more number to maintain; at the longer lengths
 * it simply buys slack the book is free not to spend.
 *
 * ONLY THE CAST PROPERTY COMBINES. `shot` is one-of, so aerial, over-the-
 * shoulder, close-up and ultra-wide can never share a page with each other, and
 * nothing here lets them.
 */
const PEOPLELESS_SHARED_SHOT = 'ultra-wide';

if (!SHOT_TYPES.includes(PEOPLELESS_SHARED_SHOT)) {
  throw new Error('shotVocabulary: PEOPLELESS_SHARED_SHOT names an unknown shot');
}

/**
 * id → the finding code planCounters raises when a book is short of that shot.
 * One code per floored shot, so a re-plan is told WHICH shot is missing rather
 * than that the spread is wrong. `ultra-wide` is a DISTANCE and `aerial` a
 * POSITION: different shots on different axes, never folded together.
 */
const SHOT_FLOOR_CODE = {
  'close-up': 'SHOT_CLOSEUP_COUNT',
  'ultra-wide': 'SHOT_ULTRAWIDE_COUNT',
  'over-the-shoulder': 'SHOT_OTS_COUNT',
};

/**
 * Tightest tier first; a book takes the first tier whose `maxPages` it fits.
 * `positionsTotal` is a floor on camera positions TAKEN TOGETHER, on top of the
 * per-shot floors — null where the tier asks for no total.
 */
const SHOT_FLOOR_TIERS = [
  { maxPages: 8, floors: { 'close-up': 1 }, positionsTotal: null },
  // NO AERIAL FLOOR (owner, 2026-09-23): "the aerial view is artificial".
  // It stays in the vocabulary and a page that earns one may take it; it is
  // no longer owed. The camera-POSITION total is kept where it was: the
  // mid tier's two position pages used to be aerial 1 + over-the-shoulder 1,
  // so it now carries an explicit total of 2, and the long tier's
  // ceil(pages/6) already covered it. Removing the mandate must not quietly
  // remove angled pages from the book.
  {
    maxPages: 13,
    floors: { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 1 },
    positionsTotal: () => 2,
  },
  {
    maxPages: Infinity,
    floors: { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 2 },
    positionsTotal: (pages) => Math.ceil(pages / 6),
  },
];

for (const tier of SHOT_FLOOR_TIERS) {
  for (const id of Object.keys(tier.floors)) {
    if (!SHOT_TYPES.includes(id)) {
      throw new Error(`shotVocabulary: SHOT_FLOOR_TIERS floors an unknown shot \`${id}\``);
    }
    if (!SHOT_FLOOR_CODE[id]) {
      throw new Error(`shotVocabulary: no finding code for the floored shot \`${id}\` — a floor nothing can report is not enforceable`);
    }
  }
}

/**
 * The distribution one book of `pageCount` pages owes.
 *
 * @returns {{floors: Object<string, number>, positionsTotal: number,
 *            requiredPositions: number, maxMediumWide: number}}
 *   `floors` id → minimum pages; `positionsTotal` the tier's own total floor (0
 *   where it asks for none); `requiredPositions` what the tier actually demands
 *   on the position axis, which is the larger of that total and the position
 *   floors added up; `maxMediumWide` the most medium-or-wide pages the book may
 *   hold — one more than this exceeds MAX_MEDIUM_WIDE_SHARE.
 */
function shotFloors(pageCount) {
  const pages = Math.max(0, Number(pageCount) || 0);
  const tier = SHOT_FLOOR_TIERS.find(t => pages <= t.maxPages) || SHOT_FLOOR_TIERS[SHOT_FLOOR_TIERS.length - 1];
  const floors = { ...tier.floors };
  const positionsTotal = tier.positionsTotal ? tier.positionsTotal(pages) : 0;
  const positionFloorSum = POSITION_SHOTS.reduce((n, id) => n + (floors[id] || 0), 0);
  const requiredPositions = Math.max(positionsTotal, positionFloorSum);
  const maxMediumWide = Math.floor(pages * MAX_MEDIUM_WIDE_SHARE);
  // THE PAGES THE BOOK OWES, counted once here so no caller re-derives it.
  // Every floor costs a page, plus any position pages the tier's TOTAL asks for
  // beyond the per-shot position floors. The mandatory people-free page costs
  // NOTHING: it rides the ultra-wide page (PEOPLELESS_SHARED_SHOT), which is
  // already in `floors` wherever it is floored at all.
  const mandatedPages = Object.values(floors).reduce((n, v) => n + Number(v), 0)
    + Math.max(0, positionsTotal - positionFloorSum);
  return {
    floors,
    positionsTotal,
    requiredPositions,
    maxMediumWide,
    mandatedPages,
    slack: pages - mandatedPages - maxMediumWide,
  };
}

/**
 * The same table as one sentence for the planner. Built from shotFloors, so the
 * words the planner reads and the numbers the counters enforce cannot drift.
 */
function shotDistributionPhrase(pageCount) {
  const { floors, requiredPositions, maxMediumWide } = shotFloors(pageCount);
  const list = SHOT_TYPES
    .filter(id => floors[id])
    .map(id => `${floors[id]} ${id} page${floors[id] === 1 ? '' : 's'}`)
    .join(', ');
  // A short book is asked for no angle, but it is still SHOWN the words — the
  // page that earns one may take it at any length.
  const positions = requiredPositions
    ? ` ${requiredPositions} page${requiredPositions === 1 ? '' : 's'} in total leave eye level for a camera position (${SHOT_POSITIONS}).`
    : ` A page may leave eye level for a camera position (${SHOT_POSITIONS}) where it earns one.`;
  // The permission is stated only where the shot it rides is actually floored;
  // a short book that owes no ultra-wide is not told to put its people-free
  // page on one.
  const shared = floors[PEOPLELESS_SHARED_SHOT]
    ? ` The page with no people in frame may BE the ${PEOPLELESS_SHARED_SHOT} page — a landscape with nobody in it answers both at once, and that is one page spoken for, not two. No two shot words ever share a page.`
    : '';
  return `Across the ${pageCount} pages: at most ${maxMediumWide} of them medium or wide — half the book at most, and never only two camera distances across the book. At least ${list}.${positions} These are floors, not targets: spend the remaining pages on whichever of the eight words each page earns, and keep the angled pages few enough that an angle still reads as one.${shared}`;
}

/**
 * WHAT A CLOSE-UP MAY NOT STAGE — one declaration of the below-frame subjects.
 *
 * REVERSED 2026-09-20 (owner): "A child can sit in a close up that is fine."
 * The rule this replaces forbade `kneeling, crouching, sitting, stepping, or
 * feet-on-ground contact` and so conflated two different things — the POSE a
 * character is in, and what the FRAME shows. A close-up ends at the waist, so a
 * sitting or kneeling child's legs are simply cropped out; that is not a fault,
 * it is what a close-up IS. Worse, a crouch or a kneel brings the head DOWN to
 * the ground, which is exactly what puts a ground-level subject inside a
 * waist-up frame — the pose was the thing making the shot work.
 *
 * So what is forbidden is an action whose VISIBLE SUBJECT lies below the frame
 * line and therefore cannot be in shot at all: the ground at a character's
 * feet, a story object lying on the floor, a foot placed on a step. Poses come
 * out; below-frame subject matter stays.
 *
 * The rule is stated at SIX stops: the beats planner writes the shot word
 * (prompts/story-beats.txt), the two Art Director templates author the brief
 * (scene-expansion.txt, scene-expansion-all.txt), the two iterate templates
 * REWRITE it (scene-iteration.txt, scene-iteration-free.txt), the
 * Art-Director-less paths get it as AD_COMPOSITION_RULE (promptBuilders.js),
 * and planCounters measures it. Every one of them spelled the list out by hand
 * and they had already drifted — the iterate pair had silently DROPPED
 * `sitting`, the single verb behind the most measured failures. One constant
 * now fills all six.
 *
 * MEASURED against the narrowed rule, 24 staging books / 73 planned close-ups
 * over the 14 days to 2026-09-20: the old verb list flagged 13 plan lines, the
 * narrowed one flags 8, and reading all 13 the five it drops are cropped poses
 * every time ("sits alone, arms wrapped around his knees"; "crouching, holding
 * a scale up between two fingers"; "steps back, hands behind him"). The 8 that
 * survive each name the ground as something the picture must show. Two of them
 * are pages the OLD list could not see at all ("one foot already on the wall
 * stones", "digging beside him with bare hands"), so the rule is at once
 * narrower and a better fit to the class it is about.
 *
 * NARROW BY DESIGN. This is an explicit pattern list, never a reading of what
 * the prose means, and it still misses ways of naming the ground it has no
 * pattern for. Under-reporting is the chosen error: the finding is advisory,
 * and a wrong one costs a re-plan round.
 */
const CLOSEUP_BELOW_WAIST_VERBS = [
  // Every entry is `selfSubject`: the pattern NAMES the below-frame thing
  // itself — feet, the ground, a foot on a surface — so there is no separate
  // actor to look for before it. The old list needed a subject guard only
  // because bare pose verbs ("sits", "steps") read objects as poses; with the
  // poses gone, so is that failure mode.
  {
    verb: "the ground at the character's feet",
    selfSubject: true,
    match: /\b(?:at|around|beneath|below|under) (?:his|her|their|its) feet\b/i,
  },
  {
    verb: 'something lying on the ground or floor',
    selfSubject: true,
    match: /\b(?:on|onto|across|against|into) the (?:\w+ )?(?:ground|floor|earth|soil|mud|sand|cobbles|paving)\b/i,
  },
  {
    verb: 'a foot placed on a step or surface',
    selfSubject: true,
    match: /\b(?:his|her|their|one|both) (?:foot|feet)\b(?:\s+\w+){0,2}\s+(?:on|onto|in|into|against)\b|\bsteps? (?:onto|up onto|down onto)\b/i,
  },
];

/** The list as the prompts state it, in the slot after "no ". */
const CLOSEUP_BELOW_WAIST_PHRASE = CLOSEUP_BELOW_WAIST_VERBS
  .map((v, i) => `${i === CLOSEUP_BELOW_WAIST_VERBS.length - 1 ? 'or ' : ''}${v.verb}`)
  .join(', ');

/**
 * THE PLAN'S CLOSE-UP WINS (2026-09-24, Lab 1433). One rule for everyone who
 * may change a planned close-up: the Art Director (11c), the scene review (7b,
 * 10) and the code check `shot_widened` (sceneBriefCheck.js). Before it, 7b
 * and 10 told the reviewer to answer a below-waist or environment fault by
 * setting `shot` to `medium`, while `shot_widened` reported exactly that
 * widening as a fault — on Lab 1433 p8 the reviewer widened the plan's
 * close-up under its own 7b label and the re-check flagged the result. Only
 * the plan line's own words decide whether a close-up page needs the room.
 */
const CLOSEUP_KEPT_RULE = 'A close-up the page\'s plan asks for stays `close-up`: restage the moment waist-up — holding, reaching, reacting — and never widen the shot for staging the plan does not name. '
  + `Only a plan whose own words put the subject below the frame line — ${CLOSEUP_BELOW_WAIST_PHRASE} — makes that page \`medium\`.`;

/**
 * A capitalised name or a person pronoun — kept for the entry that needs an
 * actor named BEFORE the match rather than inside it. No current entry does
 * (every one is `selfSubject`), and the guard stays because the next pattern
 * added may well not be: without it the old list read "the small dragon sits on
 * his neck" and "the hook where it sits in the ring" as a child's pose, two
 * false positives out of twelve. `it` is deliberately excluded and
 * `he`/`she`/`they` are not: `it` is the pronoun of the prop, never of the
 * child.
 */
const BELOW_WAIST_SUBJECT = /(?:\b[A-ZÄÖÜ][a-zäöüßéèàâç]+\b|\b(?:he|she|they)\b)[^.;!?]{0,24}$/;

/**
 * The below-frame subjects a piece of plan/brief text stages inside a close-up.
 *
 * @param {string} text
 * @returns {string[]} the matched labels, in declaration order.
 */
function closeUpBelowWaistVerbs(text) {
  const clean = String(text || '');
  const out = [];
  for (const { verb, match, selfSubject } of CLOSEUP_BELOW_WAIST_VERBS) {
    const re = new RegExp(match.source, 'gi');
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (selfSubject || BELOW_WAIST_SUBJECT.test(clean.slice(0, m.index))) { out.push(verb); break; }
    }
  }
  return out;
}

/**
 * WHICH SHOTS CAN SHARE ONE BACKDROP PLATE (owner, 2026-09-21).
 *
 * A plate is painted once per vantage and every page of that vantage is drawn
 * on it, which is what makes consecutive pages of one place look like one
 * place. The plate takes its camera from the group's representative page, so a
 * page whose own shot differs inherits someone else's camera. Owner: "a medium
 * and wide might still work, as well as an over-the-shoulder. But a medium
 * plate for a high-angle or for an ultra-wide is bound to fail."
 *
 * The line is NOT the distance/position axis. It is what moves the HORIZON or
 * grows the COVERAGE:
 *
 *   share the base plate  close-up, medium, wide   — same eye level, cropped in
 *                         over-the-shoulder        — eye level; the shoulder is
 *                                                    a FIGURE, and a plate is
 *                                                    background-only
 *   derive their own      high-angle, low-angle,   — the horizon leaves frame
 *                         aerial
 *                         ultra-wide               — needs more of the place
 *                                                    than the plate holds
 *
 * Measured over the 10 staging stories carrying vantages, 157 pages: 5 pages
 * (3.2%) are drawn on a plate built for a camera that cannot hold them, and
 * honouring this costs 3 extra plates on 39 (+7.7%).
 */
const PLATE_DERIVED_SHOTS = new Set(['ultra-wide', 'high-angle', 'low-angle', 'aerial']);

if ([...PLATE_DERIVED_SHOTS].some(id => !SHOT_TYPES.includes(id))) {
  throw new Error('shotVocabulary: PLATE_DERIVED_SHOTS names a shot that does not exist');
}

/** The class every plate-sharing shot collapses to. */
const PLATE_BASE_CLASS = 'eye-level';

/**
 * The vantage half of the same line, for the Art Director that groups pages
 * into vantages (2026-09-23). A page at eye level on an angled vantage is drawn
 * on the angled plate — nothing derives that way — which is what the brief
 * check `shot_off_plate` (sceneBriefCheck.js) reports. Built from
 * PLATE_DERIVED_SHOTS so the rule and the check cannot name different shots.
 */
const VANTAGE_SHOT_RULE = `a vantage whose shot is ${[...PLATE_DERIVED_SHOTS].map(id => '`' + id + '`').join(', ').replace(/, ([^,]*)$/, ' or $1')} holds only pages with that same shot; any other vantage holds any page`;

/**
 * Which plate a page belongs on. Pages sharing a class share a plate; a page
 * whose class is not the base one gets a plate derived from the base.
 */
function plateClass(shot) {
  const id = String(shot || '').trim();
  return PLATE_DERIVED_SHOTS.has(id) ? id : PLATE_BASE_CLASS;
}

/**
 * The instruction that turns the base plate into the angled one.
 *
 * DERIVED, never generated fresh (owner, 2026-09-21: "use the plate as an input
 * and say this is a medium shot, prepare it for a different angle so that the
 * structure stays the same"). A fresh generation of the same place from a new
 * camera returns a different building line, a different tree and a different
 * palette — and the continuity breaks exactly between two adjacent pages of one
 * place, which is the whole reason a plate is shared at all.
 *
 * Positive and structural: it names what must stay, never what must not change.
 */
/**
 * A camera move the shot's definition alone does not produce in an edit.
 * ultra-wide: the plain definition pulled back ~15% on dragon run 6 p2
 * (job_1790100385959_1nitlympp); a pull-back given a SIZE ("the current
 * picture fills the middle third") halved the buildings in Lab 1413.
 */
const DERIVE_CAMERA_MOVE = {
  'ultra-wide': 'Pull the camera far back to an ultra-wide view. Everything in the current picture shrinks to fill only the middle third of the new frame, and the new frame shows much more around it: more open ground in front, more of the surrounding place on both sides, more sky above.',
};

/*
 * What stays is the place's STRUCTURE, never an object's "position": in an
 * image edit that word means position in the frame, and it pinned the camera
 * the instruction was asking to move (run 6 p2, 2026-09-23).
 */
function buildPlateDeriveInstruction(baseShot, targetShot) {
  const target = SHOTS.find(s => s.id === targetShot);
  if (!target) return null;
  const from = String(baseShot || '').trim();
  const fromPhrase = from ? `painted as a ${from} shot` : 'painted at eye level';
  const move = DERIVE_CAMERA_MOVE[target.id] || `Re-paint the same place as a ${target.id} shot. ${target.definition}`;
  return `This backdrop is ${fromPhrase} of a place. ${move} `
    + 'The buildings, walls, roofs, trees, paths and surfaces keep their shape, material and colour and their arrangement relative to each other; the palette and the season stay identical, and the light keeps the same direction and time of day. The camera moves; the place stays as it is, and no one is added to it.';
}

module.exports = {
  OTS_NEAR_FIGURE_CROP,
  OTS_NO_CONTACT_RULE,
  OTS_NEAR_FIGURE_RULE,
  isOverTheShoulderPerspective,
  SHOTS,
  SHOT_TYPES,
  SHOT_AXES,
  SHOT_AXIS,
  PLATE_DERIVED_SHOTS,
  PLATE_BASE_CLASS,
  VANTAGE_SHOT_RULE,
  plateClass,
  buildPlateDeriveInstruction,
  DISTANCE_SHOTS,
  POSITION_SHOTS,
  SHOT_PATTERNS,
  SHOT_ENUM,
  SHOT_POSITIONS,
  SHOT_DEFINITIONS,
  SHOT_RULE_LEAD,
  buildShotDefinitions,
  MAX_MEDIUM_WIDE_SHARE,
  MID_DISTANCE_SHOTS,
  PEOPLELESS_SHARED_SHOT,
  SHOT_FLOOR_CODE,
  SHOT_FLOOR_TIERS,
  CLOSEUP_BELOW_WAIST_VERBS,
  CLOSEUP_KEPT_RULE,
  CLOSEUP_BELOW_WAIST_PHRASE,
  closeUpBelowWaistVerbs,
  shotFloors,
  shotDistributionPhrase,
};
