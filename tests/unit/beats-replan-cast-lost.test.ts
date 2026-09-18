import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
const { castLostByReplan, whoColumn } = planCounters as any;

const ROOT = path.resolve(__dirname, '../..');
const BEATS_SRC = fs.readFileSync(path.join(ROOT, 'server/lib/beatsPipeline.js'), 'utf8');
const BUILDERS_SRC = fs.readFileSync(path.join(ROOT, 'server/lib/promptBuilders.js'), 'utf8');

/**
 * A re-plan may remove a character — but never SILENTLY.
 *
 * Revised 2026-09-18. The rule this file was written for was one-directional:
 * a re-plan adds a character and never deletes one, enforced by restoring every
 * name a round took out. The owner rejected it — "we can not say delete only or
 * add only; we must give a fair review and allow both fix types" — because it
 * left an over-crowded page with no answer available and treated the standing
 * division, itself a model output, as always right. What survives unchanged is
 * this function's set arithmetic, which now answers a narrower question: which
 * removals did the round NOT declare? Those are restored; a declared one goes
 * to `reviewPlanChanges` to be judged.
 *
 * The fixtures below carry no declaration — a round from before the change
 * block existed — so every removal in them is undeclared and the expectations
 * are the same ones the original guard had.
 *
 * Fixtures are the plan lines of staging job_1789681157795_wkt20ckod ("Das Ei
 * im Lindenhof", 2026-09-17), verbatim: `beatsReviewReport.briefsIn` is the
 * first division and `beatsReviewReport.pagePlan` the one that shipped. The
 * plan check's `NO_COMMISSIONED_ON_PAGE` named pages 8, 12, 16 and 18; the
 * re-plan answered 8 and 12 by adding the commissioned children and answered
 * 16 and 18 by deleting Tobias, the invented antagonist whose blocking of the
 * stone is the arc's fourth declared challenge.
 */
const CAST = ['Levin', 'Julian', 'Max', 'Kiaan', 'Tobias', 'Zünsli'];

const FIRST_DIVISION = [
  { pageNumber: 8, planLine: "medium — Tobias striding up, hands red from cold, reaching for the egg on the rim — Tobias's hands close around the egg — Tobias has taken the egg and Kiaan stands opposite him" },
  { pageNumber: 12, planLine: 'ultra-wide — all four boys braced shoulder to shoulder against the big wedged stone in the gap, feet dug into the earth — the stone does not move — the stone is stuck fast and Julian stands frozen at the end of the line, not pushing' },
  { pageNumber: 16, planLine: "medium — Tobias sitting on the wedged stone in the dark, tin box under his arm, shouting — the Lindenhof is dark behind him — Tobias blocks the stone and the others cannot reach the gap; Zünsli lies still in Julian's hands" },
  { pageNumber: 17, planLine: 'close-up — Levin gripping a fallen branch, eyes on the earth below the stone, Max and Kiaan already digging beside him with bare hands — the branch biting into the soil — Levin has chosen and the digging has begun' },
  { pageNumber: 18, planLine: "wide — Tobias stumbling back into the leaves, the stone tipped sideways, a large eye blinking in the open gap, the four boys sitting together in the leaf-scattered dark — Zünsli's tail disappearing into the warm dark of the hill — the gap is open, Zünsli is home, and the four boys sit together on the Lindenhof" },
];

const REPLAN_RETURN = [
  { pageNumber: 8, planLine: "medium — Levin and Tobias at the Lindenhofbrunnen fountain rim — Tobias's red hands close around the egg while Levin watches — Tobias has taken the egg and Kiaan stands opposite him" },
  { pageNumber: 12, planLine: 'ultra-wide — Levin, Max, Kiaan, and Julian braced against the big wedged stone in the gap, feet dug into the earth — Julian\'s hands fall away from the stone as the others push — the stone does not move and Julian has frozen' },
  { pageNumber: 16, planLine: "medium — Levin and Julian at the stone in the dark, Julian cupping Zünsli who lies still in his hands — Levin's face turns toward the fallen branch on the ground beside him — Zünsli has gone still and the stone still blocks the gap" },
  { pageNumber: 17, planLine: 'close-up — Levin gripping a fallen branch, eyes on the earth below the stone, Max and Kiaan already digging beside him with bare hands — the branch biting into the soil — Levin has chosen and the digging has begun' },
  { pageNumber: 18, planLine: "wide — Levin, Julian, Max, and Kiaan sitting together in the leaf-scattered dark, the stone tipped sideways, a large eye blinking in the open gap — Zünsli's tail slipping into the warm dark of the hill — the gap is open, Zünsli is home, and the four boys sit together on the Lindenhof" },
];

describe('whoColumn', () => {
  it('is the second segment of a four-segment plan line', () => {
    expect(whoColumn(FIRST_DIVISION[2].planLine))
      .toBe('Tobias sitting on the wedged stone in the dark, tin box under his arm, shouting');
  });

  it('degrades to the whole line when the line has no segments', () => {
    expect(whoColumn('a line with no separators')).toBe('a line with no separators');
  });

  it('is what runPlanCounters reads, so there is one definition of the who column', () => {
    expect(BEATS_SRC.length).toBeGreaterThan(0);
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/planCounters.js'), 'utf8');
    expect(src).toMatch(/const who = whoColumn\(p\.planLine\);/);
  });
});

describe('castLostByReplan — the motivating story', () => {
  const lost = castLostByReplan(FIRST_DIVISION, REPLAN_RETURN, CAST, {});

  it('names exactly the two pages the round deleted Tobias from', () => {
    expect(lost).toEqual([
      { pageNumber: 16, lost: ['Tobias'] },
      { pageNumber: 18, lost: ['Tobias'] },
    ]);
  });

  it('leaves page 8 alone — the round ADDED Levin there and dropped no one', () => {
    expect(lost.some((l: any) => l.pageNumber === 8)).toBe(false);
  });

  it('leaves page 12 alone — "all four boys" became four names, a gain not a loss', () => {
    expect(lost.some((l: any) => l.pageNumber === 12)).toBe(false);
  });

  it('leaves page 17 alone — the round did not rewrite it', () => {
    expect(lost.some((l: any) => l.pageNumber === 17)).toBe(false);
  });
});

describe('castLostByReplan — what it must NOT flag', () => {
  it('a beat MOVED between two rewritten pages is not a deletion', () => {
    const before = [
      { pageNumber: 4, planLine: 'medium — Ana and Ben at the gate — Ana lifts the latch — the gate is open' },
      { pageNumber: 5, planLine: 'wide — the empty yard — dust settles — the yard is still' },
    ];
    const after = [
      { pageNumber: 4, planLine: 'wide — the empty yard — dust settles — the yard is still' },
      { pageNumber: 5, planLine: 'medium — Ana and Ben at the gate — Ana lifts the latch — the gate is open' },
    ];
    expect(castLostByReplan(before, after, ['Ana', 'Ben'], {})).toEqual([]);
  });

  it('a page the round did not change is never flagged', () => {
    const pages = [{ pageNumber: 1, planLine: 'medium — Ana — Ana waves — Ana has waved' }];
    expect(castLostByReplan(pages, pages, ['Ana'], {})).toEqual([]);
  });

  it('a name leaving the INSTANT but staying in the who column is not lost', () => {
    const before = [{ pageNumber: 2, planLine: 'medium — Ana and Ben — Ben hands Ana the key — the key has changed hands' }];
    const after = [{ pageNumber: 2, planLine: 'medium — Ana and Ben — the key passes between them — the key has changed hands' }];
    expect(castLostByReplan(before, after, ['Ana', 'Ben'], {})).toEqual([]);
  });

  it('an empty cast list disables the guard rather than flagging everything', () => {
    expect(castLostByReplan(FIRST_DIVISION, REPLAN_RETURN, [], {})).toEqual([]);
  });

  it('a page the standing division does not carry is ignored, never restored', () => {
    const before = [{ pageNumber: 1, planLine: 'medium — Ana — Ana waves — Ana has waved' }];
    const after = [
      { pageNumber: 1, planLine: 'medium — Ana — Ana waves — Ana has waved' },
      { pageNumber: 2, planLine: 'medium — a door — it closes — the door is shut' },
    ];
    expect(castLostByReplan(before, after, ['Ana'], {})).toEqual([]);
  });

  it('counts a possessive and an alias as the same figure', () => {
    const before = [{ pageNumber: 3, planLine: "medium — Malva Grimm at the rail — Malva's hand on the rope — the rope is held" }];
    const after = [{ pageNumber: 3, planLine: 'medium — Malva Grimm at the rail — the rope is drawn tight — the rope is held' }];
    expect(castLostByReplan(before, after, ['Malva Grimm'], { 'Malva Grimm': ['Malva'] })).toEqual([]);
  });
});

describe('castLostByReplan — multi-page rounds', () => {
  it('reports every page that deleted a name, in page order', () => {
    const before = [
      { pageNumber: 2, planLine: 'medium — Ana and Cara — Cara points — the path is named' },
      { pageNumber: 6, planLine: 'medium — Ben and Cara — Cara kneels — the mark is found' },
    ];
    const after = [
      { pageNumber: 2, planLine: 'medium — Ana — Ana points — the path is named' },
      { pageNumber: 6, planLine: 'medium — Ben — Ben kneels — the mark is found' },
    ];
    expect(castLostByReplan(before, after, ['Ana', 'Ben', 'Cara'], {}))
      .toEqual([{ pageNumber: 2, lost: ['Cara'] }, { pageNumber: 6, lost: ['Cara'] }]);
  });

  it('a name lost on one page and gained on another is a move on BOTH pages', () => {
    const before = [
      { pageNumber: 2, planLine: 'medium — Ana and Cara — Cara points — the path is named' },
      { pageNumber: 6, planLine: 'medium — Ben — Ben kneels — the mark is found' },
    ];
    const after = [
      { pageNumber: 2, planLine: 'medium — Ana — Ana points — the path is named' },
      { pageNumber: 6, planLine: 'medium — Ben and Cara — Cara kneels — the mark is found' },
    ];
    expect(castLostByReplan(before, after, ['Ana', 'Ben', 'Cara'], {})).toEqual([]);
  });
});

/**
 * The guard and the rule that stops the model needing it. Both halves ship
 * together: a prompt rule nothing checks is a guideline, and a code guard with
 * no rule in the generator makes the planner fail before it is told.
 */
describe('the beats re-plan wiring', () => {
  it('runs the guard on the merged return, before the round is measured', () => {
    expect(BEATS_SRC).toMatch(/const lost = castLostByReplan\(beats, second\.parsed\.pages, guardCast, guardAliases, review\.declaredOut\);/);
    const guardAt = BEATS_SRC.indexOf('castLostByReplan(beats, second.parsed.pages');
    const changedAt = BEATS_SRC.indexOf('const changedThisRound = second.parsed.pages');
    expect(guardAt).toBeGreaterThan(0);
    expect(changedAt).toBeGreaterThan(guardAt);
  });

  it('reviews the DECLARED changes before it hunts undeclared ones', () => {
    // Order matters: the review produces `declaredOut`, which is what stops the
    // undeclared-loss guard reporting a removal the round openly stated.
    const reviewAt = BEATS_SRC.indexOf('const review = reviewPlanChanges({');
    const guardAt = BEATS_SRC.indexOf('castLostByReplan(beats, second.parsed.pages');
    expect(reviewAt).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(reviewAt);
  });

  it('restores the flagged pages from the standing division', () => {
    expect(BEATS_SRC).toMatch(/want\.has\(Number\(pg\.pageNumber\)\) && standing\.has\(pg\.pageNumber\) \? standing\.get\(pg\.pageNumber\) : pg/);
    expect(BEATS_SRC).toMatch(/restore\(review\.refusals\.map\(r => r\.pageNumber\)\)/);
    expect(BEATS_SRC).toMatch(/restore\(lost\.map\(l => l\.pageNumber\)\)/);
  });

  it('falls back to the commissioned names when the roster failed and there is no resolved cast', () => {
    expect(BEATS_SRC).toMatch(/pendingCheck\.counters\.cast && pendingCheck\.counters\.cast\.all\) \|\| commissionedNames/);
  });

  it('reports both verdicts in the generation log', () => {
    expect(BEATS_SRC).toMatch(/gl\.warn\('beats_replan_cast_lost'/);
    expect(BEATS_SRC).toMatch(/gl\.warn\('beats_replan_change_refused'/);
  });

  it('feeds the review the check\'s own OBSTACLES evidence and the cast ceiling', () => {
    expect(BEATS_SRC).toMatch(/obstacles: pendingCheck\.obstacles/);
    expect(BEATS_SRC).toMatch(/parsePlanCheckObstacles\(res\.text \|\| ''\)/);
    expect(BEATS_SRC).toMatch(/maxCast,/);
  });

  it('tells the planner the same rule the review enforces — both directions', () => {
    // The one-directional rule this replaced (owner, 2026-09-18: "we can not
    // say delete only or add only") must not come back in any form.
    expect(BUILDERS_SRC).not.toMatch(/Dropping a character is not a fix either/);
    expect(BUILDERS_SRC).toMatch(/answered by adding or by removing, whichever that finding asks for/);
    // The two figures a removal may not take are stated to the planner in the
    // same words the review refuses on: the obstacle-holder and the span floor.
    expect(BUILDERS_SRC).toMatch(/the character whose action a page\\?'s instant works against/);
    expect(BUILDERS_SRC).toMatch(/fewer than two pages in the book/);
    // And the declaration the whole design rests on.
    expect(BUILDERS_SRC).toMatch(/A change you do not declare is undone/);
  });
});
