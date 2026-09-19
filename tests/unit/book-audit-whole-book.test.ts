import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/**
 * THE AUDIT READS THE WHOLE BOOK IN ONE CALL.
 *
 * It used to split the book into 6-page chunks for three reasons, all measured
 * false on job_1789759147125_p08djwhbl (18 pages, gemini-2.5-flash, temp 0):
 * the inline-data ceiling is never approached (18 images = 7.2k prompt tokens),
 * attention does not thin toward the tail, and "the questions are per-page so
 * nothing is lost by splitting" is the assumption that made the object-scale
 * question measure nothing. One call cost $0.026 against $0.041-0.051, took
 * 40-43 s against 68-86 s, and thought LESS in total (8.8-9.2k vs 14.6-18.6k).
 * Fault COUNTS prove nothing either way — run-to-run variance is larger than
 * the gap between the modes — so nothing here pins a count.
 *
 * The 24-page guard: the 18-page book wrote 9.5k output tokens against a
 * 65,536 ceiling (15%). 24 pages is ~20% of it, ~5x headroom.
 */

const bookAudit = require_('../../server/lib/bookAudit.js');

const page = (n: number) => ({
  pageNumber: n,
  text: `page ${n} text`,
  imageData: 'data:image/jpeg;base64,AAAA',
});

async function withStubbedFetch(answer: string, fn: (calls: any[]) => Promise<any>) {
  const calls: any[] = [];
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }],
        usageMetadata: {},
      }),
    } as any;
  };
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  try {
    const result = await fn(calls);
    return { calls, result };
  } finally {
    (globalThis as any).fetch = original;
  }
}

describe('the whole book goes in one call', () => {
  const runAudit = (pageCount: number) => withStubbedFetch(
    'FAULT[IMG][MINOR]: p1 — x\nFAULTS: 1',
    () => bookAudit.auditStoryBook(
      { id: 's1', sceneImages: Array.from({ length: pageCount }, (_, i) => page(i + 1)) },
      { objectScale: false }),
  );

  it('an 18-page book is ONE call carrying all 18 images', async () => {
    const { calls, result } = await runAudit(18);
    expect(calls.length).toBe(1);
    expect(calls[0].contents[0].parts.filter((p: any) => p.inline_data).length).toBe(18);
    expect(result.pagesRead.length).toBe(18);
  });

  it('the guard is 24 pages — a longer book splits, at most 24 per call', async () => {
    expect(bookAudit.MAX_PAGES_PER_CALL).toBe(24);
    expect((bookAudit as any).CHUNK_PAGES).toBeUndefined();
    const { calls } = await runAudit(30);
    expect(calls.map((c: any) => c.contents[0].parts.filter((p: any) => p.inline_data).length))
      .toEqual([24, 6]);
  });

  it('a 24-page book still fits in one call', async () => {
    const { calls } = await runAudit(24);
    expect(calls.length).toBe(1);
  });
});

describe('the object-size question keeps its own call — measured, not assumed', () => {
  const visualBible = { artifacts: [{ id: 'ART001', label: 'dragon egg' }] };
  const propPages = [2, 3, 5, 9, 14];
  const scenes = propPages.map(n => ({ ...page(n), sceneMetadata: { objects: ['ART001'] } }));

  const run = (sceneImages: any[], answer: string) => withStubbedFetch(
    answer, () => bookAudit.auditStoryBook({ id: 's1', visualBible, sceneImages }, {}));

  /**
   * Appending the size question to the single whole-book call was built and run
   * on job_1789759147125_p08djwhbl (gemini-2.5-flash, temp 0): the reader's-eye
   * pass returned 5 and 6 faults on two folded runs, where the same call without
   * it returned 16 on the same book the same day. So the book is read in one
   * call and the size question is asked in a second one — two calls per story,
   * down from four.
   */
  it('the reading call carries NO size question; the size question is a second call', async () => {
    const { calls, result } = await run(
      scenes, 'FAULT[IMG][MINOR]: p3 — x\nFAULTS: 1\nSCALE[SMALLER]: dragon egg — p9');
    expect(calls.length).toBe(2);
    const reading = calls[0].contents[0].parts.map((p: any) => p.text).filter(Boolean).join('\n');
    expect(reading).not.toMatch(/OBJECT SIZE/);
    const question = calls[1].contents[0].parts[0].text;
    expect(question).toMatch(/OBJECT SIZE/);
    expect(question).toMatch(/p2, p3, p5, p9, p14/);   // the whole book, never a fragment
    expect(calls[1].contents[0].parts.filter((p: any) => p.inline_data).length).toBe(5);
    expect(result.objectScale.objects[0].smaller).toEqual([9]);
    expect(result.objectScale.pagesAsked).toEqual(propPages);
    // Flagged, never repaired: the scale answer stays out of the repair routing.
    expect(result.byRoute.IMG.length).toBe(1);
    expect(result.byRoute.IMG[0].line).not.toMatch(/SCALE/);
  });

  it('a scale reply with no answer is NOT EVALUATED, never clean', async () => {
    const { result } = await run(scenes, 'FAULTS: 0');
    expect(result.objectScale.findings).toEqual([]);
    expect(result.objectScale.objects[0].evaluated).toBe(false);
    expect(result.objectScale.notEvaluated.map((e: any) => e.reason)).toContain('no_scale_answer');
  });

  it('a chunked book asks it once over the whole book, after the reading calls', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...page(i + 1),
      sceneMetadata: { objects: propPages.includes(i + 1) ? ['ART001'] : [] },
    }));
    const { calls, result } = await run(many, 'FAULTS: 0\nSCALE[LARGER]: dragon egg — p3');
    expect(calls.length).toBe(3);                      // 24 + 6 pages, then the scale call
    expect(calls[2].contents[0].parts[0].text).toMatch(/p2, p3, p5, p9, p14/);
    expect(result.objectScale.objects[0].larger).toEqual([3]);
  });
});
