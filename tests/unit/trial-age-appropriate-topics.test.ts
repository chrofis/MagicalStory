import { describe, it, expect } from 'vitest';
import {
  getTrialLifeChallenges,
  getLifeChallengesByGroup,
  topicFitsAge,
  parseChildAge,
  lifeChallenges,
} from '../../client/src/constants/storyTypes';

/**
 * Owner directive (2026-09-13): "for the trial mode we should show only age
 * appropriate challenges. No dimming." The trial FILTERS; the full wizard
 * keeps dim-and-sort. These tests pin the trial behaviour.
 */

const popular = getLifeChallengesByGroup('popular');
const id = (list: { id: string }[]) => list.map(c => c.id);

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

  it('always shows an any-age topic (no suitableAges field)', () => {
    const anyAge = popular.filter(c => !c.suitableAges).map(c => c.id);
    expect(anyAge.length).toBeGreaterThan(0);
    for (const age of [0, 2, 5, 9, 12]) {
      const visible = id(getTrialLifeChallenges(age));
      for (const a of anyAge) expect(visible).toContain(a);
    }
  });

  it('never leaves the trial with an empty topic list at any age 0-12', () => {
    for (let age = 0; age <= 12; age++) {
      expect(getTrialLifeChallenges(age).length).toBeGreaterThanOrEqual(7);
    }
  });

  it('never invents a topic that is not in the popular list (unless pinned)', () => {
    for (let age = 0; age <= 12; age++) {
      for (const c of getTrialLifeChallenges(age)) {
        expect(id(popular)).toContain(c.id);
      }
    }
  });
});

describe('trial topic list — no declared age', () => {
  it('shows everything when the age is blank, undefined or unparseable', () => {
    const full = id(popular);
    expect(id(getTrialLifeChallenges(parseChildAge('')))).toEqual(full);
    expect(id(getTrialLifeChallenges(parseChildAge(undefined)))).toEqual(full);
    expect(id(getTrialLifeChallenges(parseChildAge('abc')))).toEqual(full);
    expect(id(getTrialLifeChallenges(null))).toEqual(full);
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

  it('keeps a deep-linked topic that is not one of the popular 16 visible', () => {
    const nonPopular = lifeChallenges.find(c => !id(popular).includes(c.id));
    expect(nonPopular).toBeTruthy();
    expect(id(getTrialLifeChallenges(6, nonPopular!.id))).toContain(nonPopular!.id);
  });

  it('does not duplicate a deep-linked topic that is already in window', () => {
    const list = id(getTrialLifeChallenges(4, 'first-kindergarten'));
    expect(list.filter(x => x === 'first-kindergarten')).toHaveLength(1);
  });

  it('ignores an unknown topic id rather than rendering a hole', () => {
    expect(getTrialLifeChallenges(6, 'no-such-topic')).toHaveLength(
      getTrialLifeChallenges(6).length
    );
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
