import { describe, it, expect } from 'vitest';
import {
  getTrialLifeChallenges,
  getLifeChallengesByGroup,
  topicFitsAge,
  parseChildAge,
  lifeChallenges,
  lifeChallengeGroups,
  popularLifeChallengeIds,
  trialLifeChallengeIds,
  TRIAL_GRID_SIZE,
} from '../../client/src/constants/storyTypes';

/**
 * Owner directive (2026-09-13): "for the trial mode we should show only age
 * appropriate challenges. No dimming." The trial FILTERS; the full wizard
 * keeps dim-and-sort. These tests pin the trial behaviour.
 *
 * Phase 2 (same day): "First just label all with appropriate ages. Than rank
 * them by age group and keep the top 5 or so, what fits todays layout 4 or 6?"
 * — so the trial is filter → rank → cap at six, and the wizard stays uncapped.
 */

const popular = getLifeChallengesByGroup('popular');
const trialPool = trialLifeChallengeIds
  .map(tid => lifeChallenges.find(c => c.id === tid)!)
  .filter(Boolean);
const id = (list: { id: string }[]) => list.map(c => c.id);
const width = (tid: string) => {
  const w = lifeChallenges.find(c => c.id === tid)!.suitableAges;
  return w ? w[1] - w[0] + 1 : 13;
};

describe('trial topic list — age filtering', () => {
  it('shows an in-window topic', () => {
    // first-kindergarten is suitableAges [3, 6]
    expect(id(getTrialLifeChallenges(4))).toContain('first-kindergarten');
  });

  it('hides an out-of-window topic — absent, not dimmed', () => {
    // first-school is suitableAges [5, 8]
    expect(id(getTrialLifeChallenges(3))).not.toContain('first-school');
    // screen-time is [5, 12]
    expect(id(getTrialLifeChallenges(3))).not.toContain('screen-time');
  });

  it('never filters out an any-age topic (no suitableAges field)', () => {
    // An any-age life event is never OUT of window; it can only be pushed off
    // the grid by the ranking or the cap, never by the filter. (Age 0 used to be
    // nothing BUT life events; since the five infant topics were authored it is
    // a real grid, so this no longer asserts what fills it.)
    const anyAge = trialPool.filter(c => !c.suitableAges).map(c => c.id);
    expect(anyAge.length).toBeGreaterThan(0);
    for (const a of anyAge) {
      expect(topicFitsAge(lifeChallenges.find(c => c.id === a)!, 0)).toBe(true);
      expect(topicFitsAge(lifeChallenges.find(c => c.id === a)!, 12)).toBe(true);
    }
  });

  it('never leaves the trial with an empty topic list at any age 0-12', () => {
    for (let age = 0; age <= 12; age++) {
      expect(getTrialLifeChallenges(age).length).toBeGreaterThan(0);
    }
  });

  it('never invents a topic that is not in the trial pool (unless pinned)', () => {
    for (let age = 0; age <= 12; age++) {
      for (const c of getTrialLifeChallenges(age)) {
        expect(id(trialPool)).toContain(c.id);
      }
    }
  });
});

describe('trial topic grid — cap of six', () => {
  it('caps at TRIAL_GRID_SIZE, which is 6 to fill both grid geometries', () => {
    // TrialTopicStep.tsx renders `grid grid-cols-2 sm:grid-cols-3`: six is
    // 3 full rows of 2 on mobile and 2 full rows of 3 on desktop.
    expect(TRIAL_GRID_SIZE).toBe(6);
    for (let age = 0; age <= 12; age++) {
      expect(getTrialLifeChallenges(age).length).toBeLessThanOrEqual(TRIAL_GRID_SIZE);
    }
  });

  it('caps the no-age list too — the grid geometry does not depend on the age', () => {
    expect(getTrialLifeChallenges(null).length).toBe(TRIAL_GRID_SIZE);
    expect(getTrialLifeChallenges(undefined, 'body-changes').length).toBe(TRIAL_GRID_SIZE);
  });

  it('caps AFTER filtering, not before — a full age still yields six', () => {
    // Ages 2-12 all have more than six in-window pool topics; only age 0, where
    // no developmental window has opened yet, legitimately returns fewer.
    for (let age = 2; age <= 12; age++) {
      expect(getTrialLifeChallenges(age).length).toBe(TRIAL_GRID_SIZE);
    }
  });

  it('draws from the widened pool — the 16 curated plus 26 age-gated topics', () => {
    // 13 from 896895deb, then 5 infant and 8 pre-teen topics on 2026-09-13: the
    // grid could not be filled at 0-1 and repeated itself at 9-12 without them.
    expect(trialLifeChallengeIds.length).toBe(popularLifeChallengeIds.length + 26);
    expect(new Set(trialLifeChallengeIds).size).toBe(trialLifeChallengeIds.length);
    for (const pid of popularLifeChallengeIds) expect(trialLifeChallengeIds).toContain(pid);
    for (const tid of trialLifeChallengeIds) {
      expect(lifeChallenges.some(c => c.id === tid)).toBe(true);
    }
    // Topics the old 16-topic pool could never surface, now shown where they fit.
    expect(id(getTrialLifeChallenges(2))).toContain('potty-training');
    expect(id(getTrialLifeChallenges(3))).toContain('no-pacifier');
  });

  it('leaves the four heavy life events out of the pool — deep link only', () => {
    for (const heavy of ['parents-splitting', 'death-pet', 'grandparent-sick', 'staying-hospital']) {
      expect(lifeChallenges.some(c => c.id === heavy)).toBe(true);
      expect(trialLifeChallengeIds).not.toContain(heavy);
      for (let age = 0; age <= 12; age++) {
        expect(id(getTrialLifeChallenges(age))).not.toContain(heavy);
      }
      // …but a deep link to one still works.
      expect(id(getTrialLifeChallenges(6, heavy))).toContain(heavy);
    }
  });
});

describe('trial topic grid — ranking by liveness, then fit', () => {
  const liveness = (tid: string) => lifeChallenges.find(c => c.id === tid)!.liveness ?? 3;

  it('ranks by liveness monotonically over the whole visible grid', () => {
    // The grid is composed, not a raw top-six, so a reserved milestone seat may
    // sit below a livelier tile — but liveness must never INCREASE down the list
    // among tiles of the same pole.
    for (let age = 0; age <= 12; age++) {
      const grid = getTrialLifeChallenges(age);
      for (const pole of ['friction', 'milestone', 'both'] as const) {
        const vals = grid.filter(c => c.pole === pole).map(c => c.liveness ?? 3);
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
      }
    }
  });

  it('puts a daily battle above an occasional event, whatever the window says', () => {
    // The fault this replaced: window width ranked a fieldless life event last
    // ALWAYS, so visiting-doctor filled age 0-1 while eating-vegetables — a
    // battle for six years — surfaced only at 8.
    for (const age of [2, 3, 4, 5, 6, 7]) {
      const ids = id(getTrialLifeChallenges(age));
      expect(ids).not.toContain('visiting-doctor');
    }
    expect(id(getTrialLifeChallenges(4))).toContain('eating-vegetables');
    expect(liveness('eating-vegetables')).toBeGreaterThan(liveness('visiting-doctor'));
  });

  it('breaks a liveness tie by window fit', () => {
    // At 4 both first-kindergarten [4,5] and going-to-bed [1,8] are liveness 5;
    // 4 sits inside the tight kindergarten window and off-centre in the other.
    const at4 = getTrialLifeChallenges(4);
    expect(id(at4)).toContain('first-kindergarten');
    expect(id(at4)).not.toContain('first-school');
  });

  it('is deterministic — the same age gives the same order every call', () => {
    for (let age = 0; age <= 12; age++) {
      expect(id(getTrialLifeChallenges(age))).toEqual(id(getTrialLifeChallenges(age)));
    }
  });

  it('does not reorder when the age is unknown — no signal, no ranking', () => {
    expect(id(getTrialLifeChallenges(null))).toEqual(id(trialPool).slice(0, TRIAL_GRID_SIZE));
  });
});

describe('trial topic grid — the six tiles are a composed set', () => {
  it('never shows more than four pure-friction tiles', () => {
    // Six tiles of what your child is doing wrong is a bad second screen: a
    // parent comes looking either because something is hard or because
    // something is worth marking (owner, 2026-09-13).
    for (let age = 0; age <= 12; age++) {
      const friction = getTrialLifeChallenges(age).filter(c => c.pole === 'friction');
      expect(friction.length).toBeLessThanOrEqual(4);
    }
  });

  it('seats at least one pure milestone at every age that has one in window', () => {
    for (let age = 0; age <= 12; age++) {
      const grid = getTrialLifeChallenges(age);
      const available = lifeChallenges.filter(c => c.pole === 'milestone' && topicFitsAge(c, age)
        && trialLifeChallengeIds.includes(c.id));
      if (available.length) expect(grid.some(c => c.pole === 'milestone')).toBe(true);
    }
  });

  it('never shows two tiles from the same family', () => {
    // eating-vegetables beside picky-eating reads as a bug, not a choice.
    for (let age = 0; age <= 12; age++) {
      const fams = getTrialLifeChallenges(age).map(c => c.family).filter(Boolean);
      expect(new Set(fams).size).toBe(fams.length);
    }
  });

  it('treats a `both` topic as a wildcard, counting toward neither quota', () => {
    // A new sibling is exciting AND produces jealousy; forcing it to one pole
    // would misdescribe it.
    const both = lifeChallenges.filter(c => c.pole === 'both').map(c => c.id);
    expect(both).toContain('new-sibling');
    expect(both).toContain('first-kindergarten');
    const at0 = getTrialLifeChallenges(0);
    expect(at0.filter(c => c.pole === 'friction').length).toBeLessThanOrEqual(4);
  });

  it('fills all six tiles at every age from 0 to 12', () => {
    // Age 0 could not be filled before the five infant topics existed — that is
    // how the catalogue gap was found.
    for (let age = 0; age <= 12; age++) {
      expect(getTrialLifeChallenges(age).length).toBe(TRIAL_GRID_SIZE);
    }
  });
});

describe('Swiss school entry — kindergarten and school are two years apart', () => {
  // HarmoS: Stichtag 31 July, minimum entry age the completed 4th year, two
  // mandatory Kindergarten years, then the Primarschule (zh.ch Volksschule /
  // Kindergarten; edk.ch/dyn/19795.php). A Kindergarten entrant is 4;0-5;1 on
  // the first day and a first-Klaessler 6;0-7;1 — hence a two-year window each,
  // and a two-year gap between them.
  const kg = () => lifeChallenges.find(c => c.id === 'first-kindergarten')!.suitableAges!;
  const school = () => lifeChallenges.find(c => c.id === 'first-school')!.suitableAges!;

  it('gives each a two-year window', () => {
    expect(kg()).toEqual([4, 5]);
    expect(school()).toEqual([6, 7]);
  });

  it('never lets the two overlap at any age', () => {
    for (let age = 0; age <= 12; age++) {
      const both = topicFitsAge(lifeChallenges.find(c => c.id === 'first-kindergarten')!, age)
        && topicFitsAge(lifeChallenges.find(c => c.id === 'first-school')!, age);
      expect(both).toBe(false);
    }
  });

  it('never shows both on the same grid', () => {
    for (let age = 0; age <= 12; age++) {
      const ids = id(getTrialLifeChallenges(age));
      expect(ids.includes('first-kindergarten') && ids.includes('first-school')).toBe(false);
    }
  });

  it('keeps school-entry topics keyed to the same calendar', () => {
    // Reading is taught from the 1. Klasse; Hausaufgaben bite from the Mittelstufe.
    expect(lifeChallenges.find(c => c.id === 'reading-alone')!.suitableAges![0]).toBe(6);
    expect(lifeChallenges.find(c => c.id === 'homework')!.suitableAges![0]).toBe(7);
  });
});

describe('trial topic list — no declared age', () => {
  it('filters nothing when the age is blank, undefined or unparseable', () => {
    // Nothing is FILTERED without an age — the pool arrives in source order;
    // only the grid cap trims it (see the cap block above).
    const head = id(trialPool).slice(0, TRIAL_GRID_SIZE);
    expect(id(getTrialLifeChallenges(parseChildAge('')))).toEqual(head);
    expect(id(getTrialLifeChallenges(parseChildAge(undefined)))).toEqual(head);
    expect(id(getTrialLifeChallenges(parseChildAge('abc')))).toEqual(head);
    expect(id(getTrialLifeChallenges(null))).toEqual(head);
  });

  it('parseChildAge turns the free-text wizard field into a number or null', () => {
    expect(parseChildAge('5')).toBe(5);
    expect(parseChildAge(7)).toBe(7);
    expect(parseChildAge('')).toBeNull();
    expect(parseChildAge('abc')).toBeNull();
    expect(parseChildAge(null)).toBeNull();
  });
});

describe('trial topic list — SEO deep links (/try?category=…&topic=…)', () => {
  it('keeps an out-of-window deep-linked topic selected and visible', () => {
    // body-changes is [9, 12]; a 4-year-old deep-linking it must still see it.
    const list = getTrialLifeChallenges(4, 'body-changes');
    expect(id(list)).toContain('body-changes');
    expect(list[0].id).toBe('body-changes');
  });

  it('keeps a deep-linked topic that is outside the trial pool visible', () => {
    const nonPooled = lifeChallenges.find(c => !id(trialPool).includes(c.id));
    expect(nonPooled).toBeTruthy();
    expect(id(getTrialLifeChallenges(6, nonPooled!.id))).toContain(nonPooled!.id);
  });

  it('keeps the pin first and inside the cap even when it ranks nowhere', () => {
    // body-changes [9,12] is out of window at 4 AND outside the trial pool: it
    // survives the filter, jumps the ranking and is not cut by the cap.
    const list = id(getTrialLifeChallenges(4, 'body-changes'));
    expect(list[0]).toBe('body-changes');
    expect(list.length).toBe(TRIAL_GRID_SIZE);
    // It displaced the LAST-ranked topic, not the best-fitting one.
    expect(list[1]).toBe(id(getTrialLifeChallenges(4))[0]);
    expect(list.slice(1)).toEqual(id(getTrialLifeChallenges(4)).slice(0, TRIAL_GRID_SIZE - 1));
  });

  it('does not duplicate a deep-linked topic that is already in window', () => {
    const list = id(getTrialLifeChallenges(4, 'first-kindergarten'));
    expect(list.filter(x => x === 'first-kindergarten')).toHaveLength(1);
    expect(list[0]).toBe('first-kindergarten');
  });

  it('ignores an unknown topic id rather than rendering a hole', () => {
    expect(getTrialLifeChallenges(6, 'no-such-topic')).toHaveLength(
      getTrialLifeChallenges(6).length
    );
  });
});

describe('the FULL WIZARD is never capped or ranked', () => {
  it('keeps the Popular shelf at the curated 16, not the widened trial pool', () => {
    expect(id(getLifeChallengesByGroup('popular'))).toEqual(popularLifeChallengeIds);
    expect(popular.length).toBeGreaterThan(TRIAL_GRID_SIZE);
    expect(popular.length).toBeLessThan(trialPool.length);
  });

  it('returns every member of every age shelf, uncapped', () => {
    for (const g of lifeChallengeGroups.filter(x => x.id !== 'popular')) {
      const shelf = getLifeChallengesByGroup(g.id);
      expect(shelf.length).toBe(lifeChallenges.filter(c => c.ageGroup === g.id).length);
      expect(shelf.length).toBeGreaterThan(TRIAL_GRID_SIZE);
    }
  });

  it('still reaches all 64 life challenges through the shelves', () => {
    const reachable = new Set(
      lifeChallengeGroups.flatMap(g => id(getLifeChallengesByGroup(g.id)))
    );
    expect(reachable.size).toBe(lifeChallenges.length);
  });
});

describe('every life challenge carries a window, or is a declared life event', () => {
  // Owner ruling (2026-09-13): all 64 get labelled; exactly eight stay fieldless
  // because they happen TO a child at whatever age they happen.
  const ANY_AGE_LIFE_EVENTS = [
    'moving-house', 'going-vacation', 'parents-splitting', 'visiting-doctor',
    'staying-hospital', 'death-pet', 'grandparent-sick', 'new-sibling',
  ];

  it('labels all 64 — a window, or one of the eight any-age life events', () => {
    expect(lifeChallenges.length).toBe(64);
    const fieldless = lifeChallenges.filter(c => !c.suitableAges).map(c => c.id).sort();
    expect(fieldless).toEqual([...ANY_AGE_LIFE_EVENTS].sort());
  });

  // The five 0-2 topics the owner commissioned on 2026-09-13. They are the only
  // windows allowed to start at 0: the earlier "no developmental topic carries a
  // 0" ruling was made when the catalogue had nothing for an infant at all, and
  // authoring these is what superseded it.
  const INFANT_TOPICS = ['first-foods', 'bath-time', 'first-steps', 'first-words', 'going-outside'];

  it('starts a window at 0 only for the five infant topics', () => {
    for (const c of lifeChallenges) {
      if (!c.suitableAges) continue;
      if (c.suitableAges[0] === 0) expect(INFANT_TOPICS).toContain(c.id);
    }
    expect(lifeChallenges.find(c => c.id === 'going-to-bed')!.suitableAges).toEqual([1, 8]);
  });

  it('keeps every infant topic inside the routine and quest bands (0-2)', () => {
    for (const tid of INFANT_TOPICS) {
      const c = lifeChallenges.find(x => x.id === tid)!;
      expect(c.suitableAges![1]).toBeLessThanOrEqual(2);
      expect(c.ageGroup).toBe('toddler');   // an ordinary shelf, not a special case
    }
  });

  it('gives every topic a liveness and a pole', () => {
    for (const c of lifeChallenges) {
      expect(c.liveness).toBeGreaterThanOrEqual(1);
      expect(c.liveness).toBeLessThanOrEqual(5);
      expect(['friction', 'milestone', 'both']).toContain(c.pole);
    }
  });

  it('keeps the owner-locked windows exactly as ruled', () => {
    const w = (tid: string) => lifeChallenges.find(c => c.id === tid)!.suitableAges;
    expect(w('telling-truth')).toEqual([4, 12]);
    expect(w('dealing-bully')).toEqual([5, 12]);
    expect(w('going-to-bed')).toEqual([1, 8]);
    expect(w('losing-game')).toEqual([4, 12]);
  });

  it('keeps every window well-formed and inside 0-12', () => {
    for (const c of lifeChallenges) {
      if (!c.suitableAges) continue;
      const [lo, hi] = c.suitableAges;
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(12);
    }
  });

  it('leaves ageGroup untouched — it is the wizard picker shelf, not the window', () => {
    const shelves = new Set(lifeChallengeGroups.map(g => g.id));
    for (const c of lifeChallenges) expect(shelves.has(c.ageGroup)).toBe(true);
  });
});

describe('topicFitsAge — the shared window rule (trial filters, wizard dims)', () => {
  it('is inclusive at both ends', () => {
    const c = lifeChallenges.find(x => x.id === 'first-school')!;
    const [lo, hi] = c.suitableAges!;
    expect(topicFitsAge(c, lo)).toBe(true);
    expect(topicFitsAge(c, hi)).toBe(true);
    expect(topicFitsAge(c, 4)).toBe(false);
    expect(topicFitsAge(c, 9)).toBe(false);
  });

  it('treats a missing window and a missing age as any-age', () => {
    const anyAge = lifeChallenges.find(x => !x.suitableAges)!;
    expect(topicFitsAge(anyAge, 0)).toBe(true);
    expect(topicFitsAge(anyAge, 12)).toBe(true);
    const windowed = lifeChallenges.find(x => x.suitableAges)!;
    expect(topicFitsAge(windowed, null)).toBe(true);
    expect(topicFitsAge(windowed, undefined)).toBe(true);
  });
});

describe('adventure themes carry no age data', () => {
  it('so the trial filter leaves them all visible', async () => {
    const { storyTypes } = await import('../../client/src/constants/storyTypes');
    expect(storyTypes.every(t => !('suitableAges' in t))).toBe(true);
  });

  it("a 'both' topic counts toward neither pole — it is exempt from the friction quota and never fills the milestone seat", () => {
    // Pinned because client/src/types/story.ts documented the opposite (a
    // wildcard counting toward whichever side is short) until 2026-09-15, while
    // composeTrialGrid has only ever counted pole === 'friction' toward the
    // quota and reserved the first seat for a pole === 'milestone' topic.
    const MAX_FRICTION = 4; // TRIAL_MAX_FRICTION, private to storyTypes.ts
    for (const age of [3, 5, 7, 9]) {
      const grid = getTrialLifeChallenges(age);
      // Only strict-friction tiles are counted — a 'both' tile does not add to
      // the total, so a grid may hold MAX_FRICTION friction tiles plus 'both's.
      expect(grid.filter(c => c.pole === 'friction').length).toBeLessThanOrEqual(MAX_FRICTION);
      // And the reserved seat goes to a pure milestone, never to a 'both'.
      const milestones = lifeChallenges.filter(c => c.pole === 'milestone' && topicFitsAge(c, age)
        && trialLifeChallengeIds.includes(c.id));
      if (milestones.length) expect(grid.some(c => c.pole === 'milestone')).toBe(true);
    }
  });
});
