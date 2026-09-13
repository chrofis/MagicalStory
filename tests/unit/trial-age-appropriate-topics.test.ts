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
    // the grid by the cap, never by the filter. Age 0 is the age at which no
    // developmental window has opened, so the life events are all that is left.
    const anyAge = trialPool.filter(c => !c.suitableAges).map(c => c.id);
    expect(anyAge.length).toBeGreaterThan(0);
    for (const a of anyAge) {
      expect(topicFitsAge(lifeChallenges.find(c => c.id === a)!, 0)).toBe(true);
      expect(topicFitsAge(lifeChallenges.find(c => c.id === a)!, 12)).toBe(true);
    }
    expect(id(getTrialLifeChallenges(0)).every(x => anyAge.includes(x))).toBe(true);
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

  it('draws from the widened pool — the 16 curated plus 13 age-gated topics', () => {
    expect(trialLifeChallengeIds.length).toBe(popularLifeChallengeIds.length + 13);
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

describe('trial topic grid — ranking, best fit first', () => {
  it('puts the tighter-fitting window first', () => {
    // At 3, potty-training [2,4] (width 3) must beat making-friends [3,12] (10).
    const at3 = id(getTrialLifeChallenges(3));
    expect(at3[0]).toBe('potty-training');
    expect(at3).not.toContain('making-friends');
  });

  it('ranks by window width monotonically, over the whole visible grid', () => {
    for (let age = 0; age <= 12; age++) {
      const widths = id(getTrialLifeChallenges(age)).map(width);
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
      }
    }
  });

  it('breaks a width tie by distance from the window centre', () => {
    // At 6, first-school [5,8] and first-kindergarten [3,6] are both width 4;
    // 6 sits 0.5 from first-school's centre and 1.5 from kindergarten's.
    const at6 = id(getTrialLifeChallenges(6));
    expect(at6.indexOf('first-school')).toBeLessThan(at6.indexOf('first-kindergarten'));
    // …and at 4 the kindergarten window is the centred one, school not yet open.
    const at4 = id(getTrialLifeChallenges(4));
    expect(at4).toContain('first-kindergarten');
    expect(at4).not.toContain('first-school');
  });

  it('sinks the any-age life events below every windowed topic', () => {
    // They are in window at every age, so only the ranking keeps them off the
    // grid once developmental topics exist (age 2 and up).
    for (const age of [2, 5, 9, 12]) {
      for (const c of getTrialLifeChallenges(age)) expect(c.suitableAges).toBeTruthy();
    }
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

  it('still reaches all 59 life challenges through the shelves', () => {
    const reachable = new Set(
      lifeChallengeGroups.flatMap(g => id(getLifeChallengesByGroup(g.id)))
    );
    expect(reachable.size).toBe(lifeChallenges.length);
  });
});

describe('every life challenge carries a window, or is a declared life event', () => {
  // Owner ruling (2026-09-13): all 59 get labelled; exactly eight stay fieldless
  // because they happen TO a child at whatever age they happen.
  const ANY_AGE_LIFE_EVENTS = [
    'moving-house', 'going-vacation', 'parents-splitting', 'visiting-doctor',
    'staying-hospital', 'death-pet', 'grandparent-sick', 'new-sibling',
  ];

  it('labels all 59 — a window, or one of the eight any-age life events', () => {
    expect(lifeChallenges.length).toBe(59);
    const fieldless = lifeChallenges.filter(c => !c.suitableAges).map(c => c.id).sort();
    expect(fieldless).toEqual([...ANY_AGE_LIFE_EVENTS].sort());
  });

  it('gives no developmental topic a window starting at 0', () => {
    // Owner ruling: "no developmental topic carries a 0" — going-to-bed is [1,8].
    for (const c of lifeChallenges) {
      if (c.suitableAges) expect(c.suitableAges[0]).toBeGreaterThanOrEqual(1);
    }
    expect(lifeChallenges.find(c => c.id === 'going-to-bed')!.suitableAges).toEqual([1, 8]);
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
    expect(c.suitableAges).toEqual([5, 8]);
    expect(topicFitsAge(c, 5)).toBe(true);
    expect(topicFitsAge(c, 8)).toBe(true);
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
});
