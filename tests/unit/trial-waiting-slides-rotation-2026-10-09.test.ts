import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { avatarPoolSources, nextAvatarSource } from '../../client/src/utils/trialPoll';

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

describe('server: a picture the cutters returned twice shows once', () => {
  it('buildAvatarSlides drops byte-identical cells', async () => {
    const png = await sharp({ create: { width: 256, height: 512, channels: 3, background: '#fff' } }).png().toBuffer();
    // every cell of the sheet is the same picture -> one slide per distinct cell
    vi.spyOn(sceneComposite, 'cropAvatarCell').mockResolvedValue({ body: png, face: png });
    const sheet = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const slides = await avatarSlides.buildAvatarSlides({ standard: `data:image/jpeg;base64,${sheet.toString('base64')}` });
    expect(slides).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
