import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { avatarPoolSources, nextAvatarSource, avatarFigureOf } from '../../client/src/utils/trialPoll';

const avatarSlides = require('../../server/lib/avatarSlides');
const sceneComposite = require('../../server/lib/sceneComposite');

/** Run the slideshow `n` steps over a pool that may change between steps; returns the pictures shown in order. */
function run(n: number, poolAt: (step: number) => string[], start: string | null = null) {
  const shown = new Set<string>();
  const seen: string[] = [];
  let cur = start ?? poolAt(0)[0] ?? null;
  for (let i = 0; i < n; i++) {
    if (cur) seen.push(cur);
    cur = nextAvatarSource(poolAt(i), shown, cur);
  }
  return seen;
}

describe('trial waiting-screen avatar rotation (owner iPhone 2026-10-09: the main avatar came up too often at the start)', () => {
  it('the hero steps aside once slides exist, so the front figure is not shown twice', () => {
    expect(avatarPoolSources('data:hero', [])).toEqual(['data:hero']);
    expect(avatarPoolSources('data:hero', ['u1', 'u2'])).toEqual(['u1', 'u2']);
    expect(avatarPoolSources(null, [])).toEqual([]);
    expect(avatarPoolSources(null, ['u1', 'u1', 'u2'])).toEqual(['u1', 'u2']);
  });

  it('no picture repeats before all have shown, then the round starts again', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const seen = run(10, () => pool);
    expect(seen.slice(0, 5)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(new Set(seen.slice(5, 10)).size).toBe(5);
  });

  it('slides arriving in stages append without restarting: the pictures already shown wait for the rest', () => {
    // hero alone, then 3 early slides, then 12 once the sheet is done (a replaced list, as the server writes it)
    const early = ['b0', 'b1', 'b2'];
    const full = ['h0', 'b0', 'h1', 'b1', 'h2', 'b2', 'c0', 'cb0', 'c1', 'cb1', 'c2', 'cb2'];
    const seen = run(14, (step) => (step < 2 ? ['hero'] : step < 5 ? early : full));
    // after the hero (step 0-1) the early slides show once each, and the full list then serves the unshown ones first
    expect(seen.slice(0, 2)).toEqual(['hero', 'hero']);
    const afterFull = seen.slice(5);
    expect(new Set(afterFull.slice(0, 9)).size).toBe(9);          // nine distinct pictures before any repeats
    expect(afterFull.indexOf('h0')).toBeGreaterThanOrEqual(0);
  });

  it('a pool of one stays on its picture', () => {
    expect(run(4, () => ['only'])).toEqual(['only', 'only', 'only', 'only']);
  });
});

describe('server: every slide carries its figure label', () => {
  it('buildAvatarSlides labels cells variant-pose-kind', async () => {
    const { figuresOf } = require('../../server/lib/clientAvatarImages');
    const png = await sharp({ create: { width: 256, height: 512, channels: 3, background: '#fff' } }).png().toBuffer();
    vi.spyOn(sceneComposite, 'cropAvatarCell').mockResolvedValue({ body: png, face: png });
    const sheet = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const uri = `data:image/jpeg;base64,${sheet.toString('base64')}`;
    const slides = await avatarSlides.buildAvatarSlides({ standard: uri, costumed: { default: uri } });
    expect(figuresOf(slides)?.slice(0, 4)).toEqual(['costumed-default-front-head', 'costumed-default-front-body', 'standard-front-head', 'standard-front-body']);
    vi.restoreAllMocks();
  });
});

describe('one figure never repeats when the early body-row slides are replaced by the finished sheet (figure label in the URL)', () => {
  const u = (figure: string, hash: string) => `https://img/characters/u/c/slides/${figure}-${hash.padEnd(24, '0')}.jpg`;
  it('avatarFigureOf reads the label before the hash', () => {
    expect(avatarFigureOf(u('standard-front-body', 'ab'))).toBe('standard-front-body');
    expect(avatarFigureOf('data:image/png;base64,xx')).toBe('data:image/png;base64,xx');
  });
  it('the same figure under new bytes is not shown again before the rest', () => {
    const early = [u('standard-front-body', 'a1'), u('standard-threeQuarter-body', 'a2'), u('standard-profile-body', 'a3')];
    const full = [u('costumed-default-front-head', 'b1'), u('standard-front-body', 'b2'), u('standard-threeQuarter-body', 'b3'), u('standard-profile-body', 'b4'), u('costumed-default-front-body', 'b5')];
    const seen = run(8, (step) => (step < 2 ? early : full));
    expect(seen.slice(0, 3).map(avatarFigureOf)).toEqual(['standard-front-body', 'standard-threeQuarter-body', 'standard-profile-body']);
    expect(new Set(seen.slice(3, 5).map(avatarFigureOf))).toEqual(new Set(['costumed-default-front-head', 'costumed-default-front-body']));
  });
  it('the pool keeps one picture per figure', () => {
    expect(avatarPoolSources(null, [u('x-front-body', 'a'), u('x-front-body', 'b')])).toHaveLength(1);
  });
});
