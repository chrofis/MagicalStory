import { describe, it, expect } from 'vitest';
import { nextAvatarSource, avatarFigureOf, HERO_FIGURE } from '../../client/src/utils/trialPoll';

// Owner 2026-10-11: "it first shows only images looking at the viewer, then all images looking left. Mix them. Head straight,
// body 45, head 180, body 90, head 45, body straight ... 2 images standard, 2 costumed".
const POSES = ['front', 'threeQuarter', 'profile', 'back'];
const url = (f: string) => `https://img/characters/u/c/slides/${f}-${'0'.repeat(24)}.jpg`;
const full = (variants: string[]) => variants.flatMap(v => POSES.flatMap(p => ['head', 'body'].map(k => `${v}-${p}-${k}`)));

function rotate(figures: string[], first: string | null = null, steps = figures.length): string[] {
  const pool = figures.map(url);
  const shown = new Set<string>();
  const out: string[] = [];
  let cur: string | null = first ? pool.find(p => avatarFigureOf(p) === first)! : nextAvatarSource(pool, shown, null);
  for (let i = 0; i < steps; i++) { out.push(avatarFigureOf(cur!)); cur = nextAvatarSource(pool, shown, cur); }
  return out;
}

describe('avatar turning order', () => {
  it('a full two-variant set follows the owner pattern: head 0, body 45, head 180, body 90, head 45, body 0; variant every 2', () => {
    const order = rotate(full(['standard', 'costumed-default']));
    expect(order.slice(0, 6).map(f => f.replace(/^[a-z-]+?-(front|threeQuarter|profile|back)-/, '$1-')))
      .toEqual(['front-head', 'threeQuarter-body', 'back-head', 'profile-body', 'threeQuarter-head', 'front-body']);
    expect(order.slice(0, 6).map(f => f.startsWith('standard') ? 'S' : 'C').join('')).toBe('SSCCSS');
    expect(new Set(order).size).toBe(16);                            // every figure once before any repeat
  });

  it('whatever the pool, heads and bodies alternate, a pose never follows itself, and the variant changes every 2', () => {
    const order = rotate(full(['standard', 'costumed-default']));
    for (let i = 1; i < order.length - 2; i++) {
      const a = order[i - 1].split('-'), b = order[i].split('-');
      expect(b[b.length - 1]).not.toBe(a[a.length - 1]);             // head <-> body
      expect(b[b.length - 2]).not.toBe(a[a.length - 2]);             // pose changes
    }
    const variants = order.map(f => f.startsWith('standard') ? 'S' : 'C');
    for (let i = 0; i < 12; i += 2) expect(variants[i]).toBe(variants[i + 1]);
  });

  it('after the hero (standard front body) the order carries on with a head, not the same pose again', () => {
    const order = rotate(full(['standard', 'costumed-default']), HERO_FIGURE, 4);
    expect(order[0]).toBe(HERO_FIGURE);
    expect(order[1]).toMatch(/-head$/);
    expect(order[1]).not.toMatch(/-front-/);
  });

  it('one variant keeps the pose and head/body rules', () => {
    const order = rotate(full(['standard']));
    expect(order.slice(0, 6)).toEqual(['standard-front-head', 'standard-threeQuarter-body', 'standard-back-head', 'standard-profile-body', 'standard-threeQuarter-head', 'standard-front-body']);
    expect(new Set(order).size).toBe(8);
  });

  it('a pool that only has the early body row still goes through its figures once', () => {
    const order = rotate(['standard-front-body', 'standard-threeQuarter-body', 'standard-profile-body'], 'standard-front-body');
    expect(order).toEqual(['standard-front-body', 'standard-threeQuarter-body', 'standard-profile-body']);
  });
});
