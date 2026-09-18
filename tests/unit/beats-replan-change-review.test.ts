/**
 * DECLARE → REVIEW → APPLY: a re-plan's structural changes (owner, 2026-09-18).
 *
 * What this replaced. Commit 97ccc4128 shipped a one-directional rule — "every
 * name a page above puts in frame is in frame on that page in the division you
 * return" — plus a mechanical restore of anything a round removed. The owner
 * rejected it: "we can not say delete only or add only. We must give a fair
 * review and allow both fix types." Three concrete defects followed from the
 * one-directional shape:
 *
 *   1. No route existed by which a page's cast could shrink. NO_COMMISSIONED_ON_PAGE
 *      is answered by adding, CAST_OVER_CEILING by a justification, plan-check
 *      Q3 likewise — so an over-crowded page could only get more crowded.
 *   2. The standing division was treated as always right, when it is itself a
 *      model output: a mistake in round one could never be corrected in round two.
 *   3. It was the shape the codebase had spent the day removing — a detector
 *      that only forms an opinion in one direction.
 *
 * The design pinned here: the re-plan DECLARES each structural change with the
 * finding it answers; `reviewPlanChanges` JUDGES a removal against declared
 * evidence (the check's own OBSTACLES line, the figure's span, the cast
 * ceiling, the page-count balance); code APPLIES the verdict and never decides.
 * A removal nobody declared stays `castLostByReplan`'s business.
 *
 * These tests pin BEHAVIOUR — which changes are refused and on what evidence —
 * not the wording of any prompt rule. Offline and free: no API call, no database.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');
const { loadPromptTemplates } = require('../../server/services/prompts');

const { parsePlanChanges, parsePlanCheckObstacles } = PB;
const { reviewPlanChanges, replanChangeDirection, castLostByReplan } = PC;

// ---------------------------------------------------------------------------
// The motivating story, verbatim from staging job_1789681157795_wkt20ckod
// ("Das Ei im Lindenhof"). The plan check's NO_COMMISSIONED_ON_PAGE named pages
// 8, 12, 16 and 18 — and TWO of those four hits were themselves false: the plan
// lines said "all four boys braced shoulder to shoulder" and "the four boys
// sitting together", which the literal-name counters could not see. The re-plan
// answered 8 and 12 by adding the commissioned children and answered 16 and 18
// by deleting Tobias, the invented antagonist whose blocking of the stone is
// the arc's fourth declared challenge.
// ---------------------------------------------------------------------------
const CAST = ['Levin', 'Julian', 'Max', 'Kiaan', 'Tobias', 'Zünsli'];

const STANDING = [
  { pageNumber: 8, planLine: "medium — Tobias striding up, hands red from cold, reaching for the egg on the rim — Tobias's hands close around the egg — Tobias has taken the egg and Kiaan stands opposite him" },
  { pageNumber: 9, planLine: 'close-up — Tobias alone at the wall — he turns the egg over in his hands — the egg is his' },
  { pageNumber: 12, planLine: 'ultra-wide — all four boys braced shoulder to shoulder against the big wedged stone in the gap, feet dug into the earth — the stone does not move — the stone is stuck fast and Julian stands frozen at the end of the line, not pushing' },
  { pageNumber: 16, planLine: "medium — Tobias sitting on the wedged stone in the dark, tin box under his arm, shouting — the Lindenhof is dark behind him — Tobias blocks the stone and the others cannot reach the gap; Zünsli lies still in Julian's hands" },
  { pageNumber: 17, planLine: 'close-up — Levin gripping a fallen branch, eyes on the earth below the stone, Max and Kiaan already digging beside him with bare hands — the branch biting into the soil — Levin has chosen and the digging has begun' },
  { pageNumber: 18, planLine: "wide — Tobias stumbling back into the leaves, the stone tipped sideways, a large eye blinking in the open gap, the four boys sitting together in the leaf-scattered dark — Zünsli's tail disappearing into the warm dark of the hill — the gap is open, Zünsli is home, and the four boys sit together on the Lindenhof" },
];

const RETURNED = [
  { pageNumber: 8, planLine: "medium — Levin and Tobias at the Lindenhofbrunnen fountain rim — Tobias's red hands close around the egg while Levin watches — Tobias has taken the egg and Kiaan stands opposite him" },
  { pageNumber: 9, planLine: 'close-up — Tobias alone at the wall — he turns the egg over in his hands — the egg is his' },
  { pageNumber: 12, planLine: "ultra-wide — Levin, Max, Kiaan, and Julian braced against the big wedged stone in the gap, feet dug into the earth — Julian's hands fall away from the stone as the others push — the stone does not move and Julian has frozen" },
  { pageNumber: 16, planLine: "medium — Levin and Julian at the stone in the dark, Julian cupping Zünsli who lies still in his hands — Levin's face turns toward the fallen branch on the ground beside him — Zünsli has gone still and the stone still blocks the gap" },
  { pageNumber: 17, planLine: 'close-up — Levin gripping a fallen branch, eyes on the earth below the stone, Max and Kiaan already digging beside him with bare hands — the branch biting into the soil — Levin has chosen and the digging has begun' },
  { pageNumber: 18, planLine: "wide — Levin, Julian, Max, and Kiaan sitting together in the leaf-scattered dark, the stone tipped sideways, a large eye blinking in the open gap — Zünsli's tail slipping into the warm dark of the hill — the gap is open, Zünsli is home, and the four boys sit together on the Lindenhof" },
];

// ---------------------------------------------------------------------------
// DECLARE — the change block, parsed as data
// ---------------------------------------------------------------------------
describe('parsePlanChanges — the declaration is read as declared fields', () => {
  const BLOCK = [
    '---PAGE PLAN---',
    'Page 4: wide — the main character — she lifts the latch — the gate is open',
    '',
    '---CHANGES---',
    'Page 4: cast out the guard — PLAN[CAST_OVER_CEILING] — four names in one frame',
    'Page 5: cast in the main character — CHECK[3] — the page needs its owner',
    'Page 6: action to page 7 the rope going taut — CHECK[9] — the deed and its effect were one instant',
    'Page 7: material from page 6 — CHECK[9] — page 6 keeps the first action alone',
    'Page 6: new material the rope going taut — CHECK[9] — the second action earns a picture',
    'Page 8: action out the second turn — CHECK[5] — the instant states position, not an action',
    'Changes: 6',
  ].join('\n');

  const parsed = parsePlanChanges(BLOCK);

  it('finds the block and every kind in the declared vocabulary', () => {
    expect(parsed.present).toBe(true);
    expect(parsed.changes.map((c: any) => c.kind)).toEqual([
      'cast_out', 'cast_in', 'action_to', 'material_from', 'new_material', 'action_out',
    ]);
  });

  it('reads the page, the subject and the page a move points at', () => {
    const [out, , moved, merged] = parsed.changes;
    expect(out.pageNumber).toBe(4);
    expect(out.subject).toBe('the guard');
    expect(moved.toPage).toBe(7);
    expect(merged.fromPage).toBe(6);
  });

  it('reads the finding tag structurally, never the reason prose', () => {
    expect(parsed.changes[0].answers).toEqual({ code: 'CAST_OVER_CEILING' });
    expect(parsed.changes[1].answers).toEqual({ check: 3 });
    expect(parsed.changes[0].reason).toBe('four names in one frame');
  });

  it('re-counts the enumeration rather than trusting the declared total', () => {
    // A total is always self-certifiable: both numbers are kept so a caller can
    // see them disagree, and the enumeration is what code acts on.
    expect(parsed.declaredCount).toBe(6);
    expect(parsed.counted).toBe(6);
    const lying = parsePlanChanges(BLOCK.replace('Changes: 6', 'Changes: 3'));
    expect(lying.declaredCount).toBe(3);
    expect(lying.counted).toBe(6);
  });

  it('keeps a line it cannot read rather than dropping it', () => {
    // A change nobody could parse is a change nobody reviewed; the caller has
    // to be able to see it.
    const odd = parsePlanChanges('---CHANGES---\nPage 3: swapped the whole thing around — CHECK[5] — reasons');
    expect(odd.changes).toHaveLength(1);
    expect(odd.changes[0].kind).toBe('other');
  });

  it('does not leak into the page plan — a change line reads exactly like one', () => {
    // "Page 16: cast out Tobias — ..." matches parsePagePlan's line shape, so a
    // page-plan parse that ran past the ---CHANGES--- marker would enter the
    // declaration as page 16's plan line and ship it as the division.
    const raw = [
      '---PAGE PLAN---',
      'Page 16: medium — Levin and Julian — Levin lifts the branch — the branch is in hand',
      '',
      '---CHANGES---',
      'Page 16: cast out the antagonist — PLAN[CAST_OVER_CEILING] — four names in one frame',
      'Changes: 1',
    ].join('\n');
    const plan = PB.parsePlanResponse(raw, [16]);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0].planLine).toBe('medium — Levin and Julian — Levin lifts the branch — the branch is in hand');
    // …and the change block is still read in full from the same response.
    expect(parsePlanChanges(raw).changes).toHaveLength(1);
  });

  it('a response with no block at all reports present: false', () => {
    const none = parsePlanChanges('---PAGE PLAN---\nPage 1: wide — a door — it closes — the door is shut');
    expect(none.present).toBe(false);
    expect(none.changes).toEqual([]);
  });
});

describe('parsePlanCheckObstacles — the evidence a removal is judged against', () => {
  it('reads the OBSTACLES lines and ignores everything else', () => {
    const raw = [
      'ROSTER 16: people = Tobias, Levin; things = the stone; covers = none',
      'OBSTACLES 16: Tobias',
      'OBSTACLES 18: Tobias',
      '11. Page 16 — the obstacle holder is not named in the plan line.',
    ].join('\n');
    const m = parsePlanCheckObstacles(raw);
    expect(m.get(16)).toEqual(['Tobias']);
    expect(m.get(18)).toEqual(['Tobias']);
    expect(m.size).toBe(2);
  });

  it('a page with no obstacle emits no line and is simply absent', () => {
    expect(parsePlanCheckObstacles('OBSTACLES 4: none').size).toBe(0);
    expect(parsePlanCheckObstacles('ROSTER 4: people = Ana').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REVIEW — a removal is judged, not banned and not waved through
// ---------------------------------------------------------------------------
describe('replanChangeDirection — a property of the finding vocabulary', () => {
  it('knows which findings ask for more in frame and which for fewer', () => {
    expect(replanChangeDirection({ code: 'NO_COMMISSIONED_ON_PAGE' })).toBe('more');
    expect(replanChangeDirection({ code: 'PEOPLELESS_ON_INTERACTION_PAGE' })).toBe('more');
    expect(replanChangeDirection({ code: 'CAST_OVER_CEILING' })).toBe('fewer');
    expect(replanChangeDirection({ check: 3 })).toBe('fewer');
    expect(replanChangeDirection({ check: 11 })).toBe('more');
  });

  it('ranks the invented-dominance pair as asking for MORE, not fewer', () => {
    // Found by replaying the 109 stored beatsReviewReport rows: ranked "fewer",
    // these two let the motivating story delete its antagonist a SECOND time —
    // the round declares against INVENTED_DOMINANT_EXCESS instead of
    // NO_COMMISSIONED_ON_PAGE and the direction rule waves it through. The arc
    // is settled by the time it is divided, so the figure it gave the page
    // stays and the commissioned cast is what comes in.
    expect(replanChangeDirection({ code: 'INVENTED_DOMINANT_EXCESS' })).toBe('more');
    expect(replanChangeDirection({ code: 'INVENTED_DOMINANT_CONSECUTIVE' })).toBe('more');
  });

  it('leaves a finding either direction can answer unranked', () => {
    // A focal page is "at most two in frame OR a close-up": adding and removing
    // both answer it, so neither is refused on direction.
    expect(replanChangeDirection({ code: 'NO_FOCAL_PAGE' })).toBeNull();
    // Satisfied by changing the shot, adding OR removing.
    expect(replanChangeDirection({ code: 'CONSECUTIVE_SAME_SHOT_CAST' })).toBeNull();
    // A finding against the ARC: it names no page and no division edit repairs it.
    expect(replanChangeDirection({ code: 'ARC_INVENTED_OVER_ALLOWANCE' })).toBeNull();
    expect(replanChangeDirection({ check: 2 })).toBeNull();
    expect(replanChangeDirection(null)).toBeNull();
    expect(replanChangeDirection({ code: 'A_CODE_THAT_DOES_NOT_EXIST' })).toBeNull();
  });
});

describe('reviewPlanChanges — THE TOBIAS CASE, under the new design', () => {
  const changes = parsePlanChanges([
    '---CHANGES---',
    'Page 16: cast out Tobias — PLAN[NO_COMMISSIONED_ON_PAGE] — the page needed a commissioned child',
    'Page 18: cast out Tobias — PLAN[NO_COMMISSIONED_ON_PAGE] — the page needed a commissioned child',
    'Page 8: cast in Levin — PLAN[NO_COMMISSIONED_ON_PAGE] — the page needed a commissioned child',
    'Changes: 3',
  ].join('\n')).changes;

  const review = (obstacles: any) => reviewPlanChanges({
    changes,
    standing: STANDING,
    returned: RETURNED,
    castNames: CAST,
    aliases: {},
    maxCast: 3,
    obstacles,
  });

  it('refuses both removals on the check\'s own obstacle evidence', () => {
    const r = review(new Map([[16, ['Tobias']], [18, ['Tobias']]]));
    expect(r.refusals.map((x: any) => x.pageNumber).sort()).toEqual([16, 18]);
    expect(r.refusals.every((x: any) => x.rule === 'obstacle')).toBe(true);
  });

  it('refuses them on DIRECTION even when the check declared no obstacle at all', () => {
    // The second net, and the one that does not depend on the checker having
    // emitted an OBSTACLES line. NO_COMMISSIONED_ON_PAGE asks for a name IN
    // frame; page 16 stood one name under a ceiling of three, so there was room
    // to add and a removal is not what that finding asked for.
    const r = review(null);
    expect(r.refusals.map((x: any) => x.pageNumber).sort()).toEqual([16, 18]);
    expect(r.refusals.every((x: any) => x.rule === 'direction')).toBe(true);
  });

  it('leaves the ADDITION on page 8 alone — that is the finding answered correctly', () => {
    const r = review(new Map([[16, ['Tobias']], [18, ['Tobias']]]));
    expect(r.refusals.some((x: any) => x.pageNumber === 8)).toBe(false);
  });

  it('records the removals as declared, so the silent-loss guard stays quiet on them', () => {
    const r = review(null);
    expect(r.declaredOut.get(16)).toEqual(['Tobias']);
    expect(castLostByReplan(STANDING, RETURNED, CAST, {}, r.declaredOut)).toEqual([]);
    // …and without a declaration the same round is caught as a silent loss.
    expect(castLostByReplan(STANDING, RETURNED, CAST, {}).map((l: any) => l.pageNumber))
      .toEqual([16, 18]);
  });
});

describe('reviewPlanChanges — an over-crowded page finally has an answer', () => {
  // The defect the owner named first: today a crowded page can only get more
  // crowded. Four names in frame against a ceiling of three, answered by taking
  // one out — allowed, and the page keeps its number.
  const STAND = [
    { pageNumber: 3, planLine: 'wide — Ana, Ben, Cara and Dov at the gate — Ana lifts the latch — the gate is open' },
    { pageNumber: 4, planLine: 'medium — Ben and Cara on the road — Ben shoulders the pack — the pack is carried' },
    { pageNumber: 5, planLine: 'medium — Cara and Dov at the ford — Dov tests the water — the ford is shallow' },
    { pageNumber: 6, planLine: 'medium — Ana and Dov on the bank — Dov shakes out the rope — the rope is loose' },
    { pageNumber: 7, planLine: 'wide — Ben and Dov at the bend — Dov points the way on — the way is chosen' },
  ];
  const RET = [
    { pageNumber: 3, planLine: 'wide — Ana, Ben and Cara at the gate — Ana lifts the latch — the gate is open' },
    STAND[1], STAND[2], STAND[3], STAND[4],
  ];
  const names = ['Ana', 'Ben', 'Cara', 'Dov'];

  const run = (tag: string) => reviewPlanChanges({
    changes: parsePlanChanges(`---CHANGES---\nPage 3: cast out Dov — ${tag} — four names against a ceiling of three\nChanges: 1`).changes,
    standing: STAND, returned: RET, castNames: names, maxCast: 3,
  });

  it('allows the removal that answers the crowding counter', () => {
    expect(run('PLAN[CAST_OVER_CEILING]').refusals).toEqual([]);
  });

  it('allows the removal that answers the crowding question', () => {
    expect(run('CHECK[3]').refusals).toEqual([]);
  });

  it('allows a removal answering an ADDITION finding when the page is at the ceiling', () => {
    // Making room is the right answer there: adding a commissioned name to a
    // page already at the ceiling needs a name to leave.
    expect(run('PLAN[NO_COMMISSIONED_ON_PAGE]').refusals).toEqual([]);
  });

  it('still refuses the mirror — an addition answering a crowding finding', () => {
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 4: cast in Dov — CHECK[3] — reasons\nChanges: 1').changes,
      standing: STAND, returned: RET, castNames: names, maxCast: 3,
    });
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ pageNumber: 4, rule: 'direction' });
  });
});

describe('reviewPlanChanges — the span floor', () => {
  // Three stories lost an invented figure from every page (Pfiff, Silberkrabbe,
  // Krümel). Two pages is the floor UNDER_COVERED_CHARACTER already holds the
  // commissioned cast to.
  const STAND = [
    { pageNumber: 1, planLine: 'wide — Ana and Pip at the door — Ana knocks — the door is answered' },
    { pageNumber: 2, planLine: 'medium — Ana and Pip on the stair — Pip climbs ahead — the landing is reached' },
    { pageNumber: 3, planLine: 'medium — Ana alone — Ana sets down the lamp — the lamp is placed' },
  ];

  it('refuses a removal that strands the figure below two pages', () => {
    const RET = [
      STAND[0],
      { pageNumber: 2, planLine: 'medium — Ana on the stair — Ana climbs — the landing is reached' },
      STAND[2],
    ];
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 2: cast out Pip — CHECK[3] — reasons\nChanges: 1').changes,
      standing: STAND, returned: RET, castNames: ['Ana', 'Pip'], maxCast: 3,
    });
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ pageNumber: 2, rule: 'span' });
    expect(r.refusals[0].detail).toMatch(/Pip 2→1 page/);
  });

  it('allows a removal that leaves the figure two pages or more', () => {
    const FOUR = [...STAND, { pageNumber: 4, planLine: 'medium — Ana and Pip at the window — Pip points out — the street is seen' },
      { pageNumber: 5, planLine: 'wide — Ana and Pip on the roof — Pip steps onto the tiles — the roof is crossed' }];
    const RET = FOUR.map(p => (p.pageNumber === 2
      ? { pageNumber: 2, planLine: 'medium — Ana on the stair — Ana climbs — the landing is reached' } : p));
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 2: cast out Pip — CHECK[3] — reasons\nChanges: 1').changes,
      standing: FOUR, returned: RET, castNames: ['Ana', 'Pip'], maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
  });

  it('does not invent a floor for a figure the standing division already had on one page', () => {
    // Losing one page of a one-page presence is not the same defect; the round
    // is judged on obstacle and direction, not on a span it never had.
    const ONE = [
      { pageNumber: 1, planLine: 'wide — Ana and Pip at the door — Ana knocks — the door is answered' },
      { pageNumber: 2, planLine: 'medium — Ana on the stair — Ana climbs — the landing is reached' },
    ];
    const RET = [{ pageNumber: 1, planLine: 'wide — Ana at the door — Ana knocks — the door is answered' }, ONE[1]];
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 1: cast out Pip — CHECK[1] — reasons\nChanges: 1').changes,
      standing: ONE, returned: RET, castNames: ['Ana', 'Pip'], maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
  });
});

describe('reviewPlanChanges — a page is a bigger loss than a character', () => {
  // The book keeps its page count, so a merge frees exactly one number and that
  // number is declared as staging something new. "Dropping the weakest" page
  // used to be an instruction, with nothing recording which page went or why.
  const STAND = [
    { pageNumber: 6, planLine: 'medium — Ana — Ana lifts the crate and sets it down — the crate is moved' },
    { pageNumber: 7, planLine: 'medium — Ben — Ben waits by the cart — Ben is at the cart' },
  ];
  const RET = [
    { pageNumber: 6, planLine: 'medium — Ana — Ana lifts the crate — the crate is off the ground' },
    { pageNumber: 7, planLine: 'medium — Ana — Ana sets the crate down — the crate is on the cart' },
  ];

  it('accepts a merge and a split declared as one balanced move', () => {
    const r = reviewPlanChanges({
      changes: parsePlanChanges([
        '---CHANGES---',
        'Page 6: material from page 7 — CHECK[9] — page 7 held only position',
        'Page 7: new material Ana setting the crate down — CHECK[9] — the effect earns its own picture',
        'Changes: 2',
      ].join('\n')).changes,
      standing: STAND, returned: RET, castNames: ['Ana', 'Ben'], maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
  });

  it('refuses a merge with no page declaring what the freed number now stages', () => {
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 6: material from page 7 — CHECK[9] — page 7 was the weakest\nChanges: 1').changes,
      standing: STAND, returned: RET, castNames: ['Ana', 'Ben'], maxCast: 3,
    });
    expect(r.refusals.map((x: any) => x.pageNumber).sort()).toEqual([6, 7]);
    expect(r.refusals.every((x: any) => x.rule === 'balance')).toBe(true);
  });

  it('refuses new material that no merge freed a number for', () => {
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 7: new material Ana setting the crate down — CHECK[9] — reasons\nChanges: 1').changes,
      standing: STAND, returned: RET, castNames: ['Ana', 'Ben'], maxCast: 3,
    });
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toMatchObject({ pageNumber: 7, rule: 'balance' });
  });
});

describe('reviewPlanChanges — what it must NOT do', () => {
  const STAND = [
    { pageNumber: 1, planLine: 'wide — Ana and Ben — Ana opens the gate — the gate is open' },
    { pageNumber: 2, planLine: 'wide — Ana and Ben — Ben crosses — the yard is crossed' },
    { pageNumber: 3, planLine: 'wide — Ana and Ben — Ana waves — the signal is given' },
  ];

  it('refuses nothing when no change was declared', () => {
    expect(reviewPlanChanges({ changes: [], standing: STAND, returned: STAND, castNames: ['Ana', 'Ben'] }).refusals)
      .toEqual([]);
    expect(reviewPlanChanges().refusals).toEqual([]);
  });

  it('never refuses an ACTION change — prose is the critic\'s job, not code\'s', () => {
    // A code-only detector for a closely related question measured roughly 37
    // false fires to 1 true over 443 stored pages. An action drop is declared
    // and visible in the report; nothing here pattern-matches it.
    const r = reviewPlanChanges({
      changes: parsePlanChanges([
        '---CHANGES---',
        'Page 1: action out the second turn — PLAN[NO_COMMISSIONED_ON_PAGE] — reasons',
        'Page 2: action to page 3 the crossing — CHECK[9] — reasons',
        'Changes: 2',
      ].join('\n')).changes,
      standing: STAND, returned: STAND, castNames: ['Ana', 'Ben'], maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
  });

  it('notes, but never refuses, a removal naming somebody who is not on the cast list', () => {
    // Refusing on an unresolvable name would fire on the roster's own mistakes.
    // The removal simply stays undeclared, and the silent-loss guard restores
    // the page — the same, cheap outcome as before declarations existed.
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 1: cast out the harbour master — CHECK[3] — reasons\nChanges: 1').changes,
      standing: STAND, returned: STAND, castNames: ['Ana', 'Ben'], maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
    expect(r.declaredOut.size).toBe(0);
    expect(r.notes.join(' ')).toMatch(/names nobody on the cast list/);
  });

  it('notes a change that names no finding tag, and leaves direction unjudged', () => {
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 1: cast out Ben — it felt crowded\nChanges: 1').changes,
      standing: STAND,
      returned: [{ pageNumber: 1, planLine: 'wide — Ana — Ana opens the gate — the gate is open' }, STAND[1], STAND[2]],
      castNames: ['Ana', 'Ben'],
      maxCast: 3,
    });
    expect(r.refusals).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/names no finding tag/);
  });
});

// ---------------------------------------------------------------------------
// APPLY — the prompt and the code say the same thing
// ---------------------------------------------------------------------------
describe('the generator is told exactly what the review enforces', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const inputData: any = {
    title: 'The Lamp on the Pier',
    characters: [{ id: 'c1', name: 'Mara', age: 7, gender: 'female' }],
    mainCharacters: ['c1'],
    language: 'en',
    languageLevel: 'medium',
    pages: 4,
    storyCategory: 'adventure',
    storyType: 'adventure',
    artStyle: 'watercolor',
  };
  const PLAN = [1, 2, 3, 4].map(n => `Page ${n}: wide — Mara — she walks on — she is further along`).join('\n');
  const section = () => PB.buildReplanSection(PLAN, [{ check: 9, line: 'Page 3 holds two actions.', pages: [3] }], { pageCount: 4 });

  it('states the page-count rule as a number the caller supplied', () => {
    expect(section()).toContain('The book keeps its 4 pages, numbered 1 to 4.');
  });

  it('derives that number from the plan when the caller gives none, never below the highest page', () => {
    const derived = PB.buildReplanSection(PLAN, [{ check: 9, line: 'Page 3 holds two actions.', pages: [3] }]);
    expect(derived).toContain('its 4 pages, numbered 1 to 4');
    // A sparse plan must not print a span that contradicts the division under it.
    const sparse = PB.buildReplanSection('Page 1: wide — Mara — she walks — on\nPage 9: wide — Mara — she stops — arrived',
      [{ check: 9, line: 'Page 9 holds two actions.', pages: [9] }]);
    expect(sparse).toContain('its 9 pages, numbered 1 to 9');
  });

  it('the built re-plan prompt carries the declaration format and the first plan does not', () => {
    const replan = PB.buildBeatsPrompt(inputData, 4, { finalArc: 'a line', replan: section() });
    const first = PB.buildBeatsPrompt(inputData, 4, { finalArc: 'a line' });
    expect(replan).toContain('---CHANGES---');
    expect(first).not.toContain('---CHANGES---');
    // No hole in either build.
    expect(replan).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
    expect(first).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('the critic declares the obstacle evidence the review reads', () => {
    const prompt = PB.buildPlanCheckPrompt(inputData, [
      { pageNumber: 1, planLine: 'wide — Mara — she walks on — she is further along' },
    ], 'an arc', PLAN, '');
    expect(prompt).toContain('OBSTACLES <page>:');
    // The generator half of the same pair: the page names that character.
    const beats = PB.buildBeatsPrompt(inputData, 4, { finalArc: 'a line' });
    expect(beats).toMatch(/whose action is what a page's instant works against/);
    expect(beats).toMatch(/is named in that page's plan line/);
  });
});
