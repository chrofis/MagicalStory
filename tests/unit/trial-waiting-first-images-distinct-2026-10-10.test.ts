import { describe, it, expect } from 'vitest';
import { avatarPoolSources, nextAvatarSource, resolveCurrentAvatar, avatarFigureOf, HERO_FIGURE } from '../../client/src/utils/trialPoll';

// Owner iPhone trial (user 10e1d43c, 2026-10-10): "the full body comes twice at the start". The hero (a data URI, the front
// body cell of the standard sheet) is shown first; the slide lists then carry that very figure as standard-front-body.
const url = (label: string, h = 'a'.repeat(24)) => `https://images-staging.magicalstory.ch/characters/u/c/slides/${label}-${h}.jpg`;
// The stored list of that user's character row (preGeneratedAvatarSlides), in order.
const FINAL = ['costumed-default-front-head', 'costumed-default-front-body', 'standard-front-head', 'standard-front-body',
  'costumed-default-threeQuarter-head', 'costumed-default-threeQuarter-body', 'standard-threeQuarter-head', 'standard-threeQuarter-body',
  'costumed-default-profile-head', 'costumed-default-profile-body', 'standard-profile-head', 'standard-profile-body'].map(l => url(l, 'b'.repeat(24)));
const BODY_ROW = ['standard-front-body', 'standard-threeQuarter-body', 'standard-profile-body'].map(l => url(l, 'c'.repeat(24)));
const HERO = 'data:image/jpeg;base64,AAAA';

/** The component's logic: the effect records the first picture, the timer advances, slide lists replace the pool in stages. */
function simulate(stages: { atStep: number; slides: string[] }[], steps: number) {
  const shown = new Set<string>();
  let slides: string[] = [];
  let displayed: string | null = null;
  const seen: string[] = [];
  for (let step = 0; step < steps; step++) {
    for (const s of stages) if (s.atStep === step) slides = s.slides;
    const pool = avatarPoolSources(HERO, slides);
    const current = resolveCurrentAvatar(pool, shown, displayed, HERO);
    if (displayed === null && pool[0]) { if (pool[0] === HERO) shown.add(HERO_FIGURE); displayed = pool[0]; }
    seen.push(current!);
    displayed = nextAvatarSource(pool, shown, current, HERO);
  }
  return seen.map(s => (s === HERO ? HERO_FIGURE : avatarFigureOf(s)));
}

describe('waiting screen: the first pictures are distinct figures', () => {
  it('hero, then the body-row slides, then the finished list', () => {
    const f = simulate([{ atStep: 1, slides: BODY_ROW }, { atStep: 3, slides: FINAL }], 8);
    expect(new Set(f.slice(0, 6)).size).toBe(6);
    expect(f.slice(0, 3).filter(x => x === HERO_FIGURE)).toHaveLength(1);
  });
  it('the finished list already there at the first slot (hero never shown) keeps its own order', () => {
    const f = simulate([{ atStep: 0, slides: FINAL }], 8);
    expect(new Set(f.slice(0, 6)).size).toBe(6);
  });
  it('slides arriving right after the hero never repeat the hero figure', () => {
    const f = simulate([{ atStep: 1, slides: FINAL }], 6);
    expect(f[0]).toBe(HERO_FIGURE);
    expect(f.slice(1)).not.toContain(HERO_FIGURE);
  });
  it('without a hero the old behaviour is unchanged', () => {
    const shown = new Set<string>();
    expect(resolveCurrentAvatar(['x', 'y'], shown, 'gone', null)).toBe('x');
  });
});
