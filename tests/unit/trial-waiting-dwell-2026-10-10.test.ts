import { describe, it, expect } from 'vitest';
import { avatarPoolSources, nextAvatarSource, avatarFigureOf, HERO_FIGURE } from '../../client/src/utils/trialPoll';

// Owner iPhone trial (2026-10-10): "first avatar rotation is now too fast, vanishes almost immediately". The picture on
// screen was re-resolved whenever the pool changed; now it only changes when the timer (or an arrow) says so.
const url = (l: string) => `https://images-staging.magicalstory.ch/characters/u/c/slides/${l}-${'a'.repeat(24)}.jpg`;
const BODY_ROW = ['standard-front-body', 'standard-threeQuarter-body', 'standard-profile-body'].map(url);
const SHEET = ['costumed-default-front-head', 'costumed-default-front-body', 'standard-front-head', 'standard-front-body',
  'standard-threeQuarter-head', 'standard-threeQuarter-body', 'standard-profile-head', 'standard-profile-body'].map(url);
const HERO = 'data:image/jpeg;base64,AAAA';
const DWELL = 6000; // the avatar + funny line dwell in TrialGenerationPage's rotation effect

describe('waiting screen: a picture is never cut short by a pool update', () => {
  it('hero at t0, body-row slides at +2 s, sheet slides at +30 s: every picture shows the full dwell', () => {
    const shown = new Set<string>();
    let slides: string[] = [];
    let displayed: string = HERO;
    shown.add(HERO_FIGURE);
    let since = 0;
    const log: { src: string; ms: number }[] = [];
    for (let t = 0; t <= 120000; t += 500) {
      if (t === 2000) slides = BODY_ROW;
      if (t === 30000) slides = SHEET;
      if (t - since >= DWELL) { // the timer fires; the pool is read at that moment
        log.push({ src: displayed, ms: t - since });
        displayed = nextAvatarSource(avatarPoolSources(HERO, slides), shown, displayed, HERO)!;
        since = t;
      }
    }
    expect(log.length).toBeGreaterThan(10);
    for (const l of log) expect(l.ms).toBeGreaterThanOrEqual(DWELL);
    const figs = log.slice(0, 3).map(l => (l.src === HERO ? HERO_FIGURE : avatarFigureOf(l.src)));
    expect(new Set(figs).size).toBe(3); // the three body figures show once before the round can restart
  });
});
