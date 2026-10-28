/**
 * Strip painter (pdf.js createStripPainter / prefetchStripBackgrounds): every strip call of a book starts
 * up front at a throttled rate, the first failure stops new starts, progress counts. No network, paint is a stand-in.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const { createStripPainter, prefetchStripBackgrounds } = cjs('../../server/lib/pdf.js');

const story = (n: number) => ({
  sceneImages: Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, imageData: 'x' })),
});
const pages = (n: number) => Array.from({ length: n }, (_, i) => `text ${i + 1}`);
const geo = { interiorW: 1, interiorH: 1, imageBottom: 1 };

describe('strip painter', () => {
  it('starts every strip of a 2-story book before the first resolves', async () => {
    const starts: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const paint = async () => { starts.push(Date.now()); await gate; return { buffer: Buffer.alloc(0), edge: 'bottom' }; };
    const stats: any = { grokCalls: 0 };
    const painter = createStripPainter(stats, { paint, intervalMs: 5 });
    const a = prefetchStripBackgrounds(story(6), pages(6), geo, 'grok', stats, painter);
    const b = prefetchStripBackgrounds(story(6), pages(6), geo, 'grok', stats, painter);
    await new Promise(r => setTimeout(r, 120));
    expect(starts.length).toBe(12);          // all in flight, none resolved yet (gate closed)
    release();
    await Promise.all([...a.values(), ...b.values()]);
  });

  it('spaces starts by at least the interval', async () => {
    const starts: number[] = [];
    const paint = async () => { starts.push(Date.now()); return null; };
    const painter = createStripPainter({}, { paint, intervalMs: 30 });
    const m = prefetchStripBackgrounds(story(5), pages(5), geo, 'grok', {}, painter);
    await Promise.all(m.values());
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[0]).toBeGreaterThanOrEqual(i * 30 - 10);   // timer jitter margin
    expect(starts[4] - starts[0]).toBeLessThan(400);
  });

  it('stops starting calls after the first failure and surfaces it when awaited', async () => {
    let started = 0;
    const paint = async () => { started++; if (started === 1) throw new Error('boom'); return null; };
    const painter = createStripPainter({}, { paint, intervalMs: 20 });
    const m = prefetchStripBackgrounds(story(5), pages(5), geo, 'grok', {}, painter);
    await expect(m.get(1)).rejects.toThrow('boom');
    await expect(m.get(5)).rejects.toThrow('boom');
    expect(started).toBe(1);
  });

  it('reports done/total progress', async () => {
    const seen: Array<[number, number]> = [];
    const stats: any = { onProgress: (d: number, t: number) => seen.push([d, t]) };
    const painter = createStripPainter(stats, { paint: async () => null, intervalMs: 1 });
    const m = prefetchStripBackgrounds(story(3), pages(3), geo, 'grok', stats, painter);
    await Promise.all(m.values());
    expect(seen[2]).toEqual([0, 3]);
    expect(seen[seen.length - 1]).toEqual([3, 3]);
  });

  it('paints nothing for the mirror fill', () => {
    expect(prefetchStripBackgrounds(story(3), pages(3), geo, 'mirror', {}).size).toBe(0);
  });
});
