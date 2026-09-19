/**
 * The Lab's `beats_scenes` stage must not report a truncated all-pages response
 * as a whole measurement.
 *
 * Pinned failure: Test Lab experiment 1275 (`beats_scenes`, story
 * `job_1789420511893_zly5rcdej`, 16 pages). The Art Director's all-pages reply
 * was cut mid-JSON inside page 9 — the stored brief ends literally on
 * `"objects": ["LOC001", "ART002"], "interactions":` — and pages 10-16 never
 * arrived. The stage accepted every `## Page N` chunk verbatim, so it returned
 * sixteen expansions of which seven were empty and one was half a spec, and the
 * run read as a success. Nine of sixteen pages were measured.
 *
 * Production never had that hole (beatsPipeline.js): a brief that fails the
 * scene-brief contract is not merged, the batch is retried once, and whatever is
 * still missing is re-expanded page by page. These tests pin the Lab having the
 * same three behaviours, plus the marker that makes a partial run say so.
 * They pin BEHAVIOUR (which briefs count, what is retried, what is announced),
 * never prompt wording.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { collectAllPagesBriefs, summarizeSceneExpansions } = require('../../server/lib/testlab');

/** A brief that meets the contract: prose, metadata block, sceneIntent. */
function wholeBrief(pageNumber: number) {
  return [
    `The main character stands at the edge of the square while the crowd thins out.`,
    '',
    '---METADATA---',
    JSON.stringify({
      sceneIntent: `page ${pageNumber}: the main character waits`,
      characters: ['the main character'],
      objects: ['LOC001'],
      interactions: [],
      textPosition: 'bottom',
    }, null, 2),
  ].join('\n');
}

/**
 * The REAL page-9 tail from experiment 1275 — the reply stops here, mid-object.
 * Fine in a test fixture; it must never appear in a prompt.
 */
const CUT_BRIEF_1275 = [
  'The main character crosses the courtyard as the light drops behind the roofline.',
  '',
  '---METADATA---',
  '{',
  '  "sceneIntent": "the main character crosses the courtyard",',
  '  "characters": ["the main character"],',
  '  "objects": ["LOC001", "ART002"], "interactions":',
].join('\n');

const pages = (ns: number[]) => ns.map(n => ({ pageNumber: n }));

describe('collectAllPagesBriefs — truncation recovery in the Lab stage', () => {
  it('does not accept the cut page, retries the batch, and falls back per-page', async () => {
    const batchCalls: number[] = [];
    const fallbackCalls: number[] = [];
    const expected = pages([1, 2, 3]);

    const out = await collectAllPagesBriefs({
      expected,
      callBatch: (attempt: number) => {
        batchCalls.push(attempt);
        // Both attempts are cut in the same place — the reply is reproducibly
        // short, which is what makes the per-page fallback the only recovery.
        return Promise.resolve({
          modelId: 'test-model',
          _pages: [
            { pageNumber: 1, text: wholeBrief(1) },
            { pageNumber: 2, text: wholeBrief(2) },
            { pageNumber: 3, text: CUT_BRIEF_1275 },
          ],
        });
      },
      parsePages: (res: { _pages: unknown[] }) => res._pages,
      expandOnePage: (b: { pageNumber: number }) => {
        fallbackCalls.push(b.pageNumber);
        return Promise.resolve({ pageNumber: b.pageNumber, ok: true, fromBeats: wholeBrief(b.pageNumber) });
      },
    });

    // The cut page is NOT a delivered brief.
    expect([...out.byPage.keys()].sort()).toEqual([1, 2]);
    expect(out.byPage.has(3)).toBe(false);
    // Recovery was attempted: the batch ran twice, then the page went per-page.
    expect(batchCalls).toEqual([1, 2]);
    expect(fallbackCalls).toEqual([3]);
    expect(out.recovered).toHaveLength(1);
    expect(out.recovered[0]).toMatchObject({ pageNumber: 3, ok: true, recoveredBy: 'per-page fallback' });
  });

  it('a retry that fills the gap stops there — no per-page call', async () => {
    const fallbackCalls: number[] = [];
    const replies = [
      [{ pageNumber: 1, text: wholeBrief(1) }, { pageNumber: 2, text: CUT_BRIEF_1275 }],
      [{ pageNumber: 1, text: wholeBrief(1) }, { pageNumber: 2, text: wholeBrief(2) }],
    ];
    const out = await collectAllPagesBriefs({
      expected: pages([1, 2]),
      callBatch: (attempt: number) => Promise.resolve({ modelId: 'm', _pages: replies[attempt - 1] }),
      parsePages: (res: { _pages: unknown[] }) => res._pages,
      expandOnePage: (b: { pageNumber: number }) => {
        fallbackCalls.push(b.pageNumber);
        return Promise.resolve({ pageNumber: b.pageNumber, ok: false });
      },
    });
    expect(out.attemptsMade).toBe(2);
    expect(fallbackCalls).toEqual([]);
    expect(out.byPage.get(2).text).toBe(wholeBrief(2));
  });

  it("the first attempt's pages win — a retry can only fill gaps", async () => {
    const out = await collectAllPagesBriefs({
      expected: pages([1, 2]),
      callBatch: (attempt: number) => Promise.resolve({
        modelId: `m${attempt}`,
        _pages: attempt === 1
          ? [{ pageNumber: 1, text: wholeBrief(1) }]
          : [{ pageNumber: 1, text: wholeBrief(11) }, { pageNumber: 2, text: wholeBrief(2) }],
      }),
      parsePages: (res: { _pages: unknown[] }) => res._pages,
      expandOnePage: (b: { pageNumber: number }) => Promise.resolve({ pageNumber: b.pageNumber, ok: false }),
    });
    expect(out.byPage.get(1).text).toBe(wholeBrief(1));
  });

  it('a whole batch nobody can parse is taken as written rather than re-expanded page by page', async () => {
    const fallbackCalls: number[] = [];
    const out = await collectAllPagesBriefs({
      expected: pages([1, 2]),
      callBatch: () => Promise.resolve({
        modelId: 'm',
        _pages: [{ pageNumber: 1, text: CUT_BRIEF_1275 }, { pageNumber: 2, text: CUT_BRIEF_1275 }],
      }),
      parsePages: (res: { _pages: unknown[] }) => res._pages,
      expandOnePage: (b: { pageNumber: number }) => {
        fallbackCalls.push(b.pageNumber);
        return Promise.resolve({ pageNumber: b.pageNumber, ok: false });
      },
    });
    expect(out.byPage.size).toBe(2);
    expect(fallbackCalls).toEqual([]);
  });

  it('a thrown batch call goes straight to the per-page fallback', async () => {
    const fallbackCalls: number[] = [];
    const out = await collectAllPagesBriefs({
      expected: pages([1, 2]),
      callBatch: () => Promise.reject(new Error('provider 503')),
      parsePages: () => [],
      expandOnePage: (b: { pageNumber: number }) => {
        fallbackCalls.push(b.pageNumber);
        return Promise.resolve({ pageNumber: b.pageNumber, ok: true, fromBeats: wholeBrief(b.pageNumber) });
      },
    });
    expect(out.byPage.size).toBe(0);
    expect(fallbackCalls).toEqual([1, 2]);
  });
});

describe('summarizeSceneExpansions — a partial run announces itself', () => {
  it('is null when every page has a brief', () => {
    expect(summarizeSceneExpansions([{ pageNumber: 1, ok: true }, { pageNumber: 2, ok: true }])).toBeNull();
  });

  it('a still-missing page makes the stage report incomplete, naming the page', () => {
    const marker = summarizeSceneExpansions([
      { pageNumber: 1, ok: true },
      { pageNumber: 2, ok: false, error: 'per-page fallback failed' },
      { pageNumber: 3, ok: true },
    ]);
    expect(marker).not.toBeNull();
    expect(marker.measured).toBe(2);
    expect(marker.expected).toBe(3);
    expect(marker.missingPages).toEqual([2]);
    expect(marker.message).toContain('2 of 3 pages measured');
    expect(marker.message).toContain('page(s) 2');
  });

  it('handles a stage that expanded nothing at all', () => {
    expect(summarizeSceneExpansions(null)).toBeNull();
    expect(summarizeSceneExpansions([])).toBeNull();
  });
});
