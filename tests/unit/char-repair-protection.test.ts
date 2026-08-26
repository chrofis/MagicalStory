import { describe, it, expect } from 'vitest';

// REGRESSION: the entity-report tier (tier 1, the MOST trusted) returned only
// the target box and no `figures`. The caller builds protectedFaces/protectedBodies
// from that list, so every repair resolving through tier 1 protected NOBODY:
// Grok received a crop with the neighbours unmasked, repainted the whole group,
// the target moved, and the blend gate refused every attempt.
//
// Measured on prod job_1787689073034_1v6ew0y1kae initialPage ("Feurio und die
// vier Buben"): four boys shoulder to shoulder, Julian refused 3/3 at 48/10/53%
// mask IoU and Kiaan at 52%, with "no usable detection for neighbour
// protection — other figures in the mask can be repainted" in the log.

// @ts-expect-error - JS module without types
import { resolveCharBbox } from '../../server/lib/charRepairTarget.js';

const FIGURES = [
  { name: 'Julian', bodyBox: [0.288, 0.204, 0.887, 0.471], faceBox: [0.288, 0.22, 0.54, 0.43] },
  { name: 'Kiaan', bodyBox: [0.21, 0.065, 0.842, 0.302], faceBox: [0.21, 0.08, 0.45, 0.28] },
  { name: 'Levin', bodyBox: [0.191, 0.374, 0.856, 0.669], faceBox: [0.191, 0.39, 0.44, 0.62] },
  { name: 'UNKNOWN', bodyBox: [0.1, 0.1, 0.2, 0.2] },
];

const entityReport = {
  characters: {
    Julian: {
      byClothing: {
        standard: {
          appearances: [
            { pageNumber: -2, faceBox: [0.288, 0.22, 0.54, 0.43], bodyBox: [0.288, 0.204, 0.887, 0.471], clothing: 'standard' },
          ],
        },
      },
    },
  },
};

const bestEval = { bboxDetection: { figures: FIGURES } };

describe('resolveCharBbox — entity tier carries the cast for neighbour protection', () => {
  it('REGRESSION: tier 1 returns figures, so neighbours can be protected', () => {
    // imageData omitted => pairs() short-circuits true, same as an unfingerprinted call.
    const r = resolveCharBbox('Julian', { bestEval, entityReport, pageNumber: -2 });
    expect(r.source).toBe('entity');
    expect(Array.isArray(r.figures)).toBe(true);
    expect(r.figures.length).toBe(FIGURES.length);
    // The caller filters self + UNKNOWN; what matters here is the neighbours are reachable.
    const names = r.figures.map((f: any) => f.name);
    expect(names).toContain('Kiaan');
    expect(names).toContain('Levin');
  });

  it('still returns the entity box and its clothing', () => {
    const r = resolveCharBbox('Julian', { bestEval, entityReport, pageNumber: -2 });
    expect(r.bodyBbox).toEqual([0.288, 0.204, 0.887, 0.471]);
    expect(r.clothing).toBe('standard');
  });

  it('returns an empty cast rather than throwing when no detection exists', () => {
    const r = resolveCharBbox('Julian', { bestEval: {}, entityReport, pageNumber: -2 });
    expect(r.source).toBe('entity');
    expect(r.figures).toEqual([]);
  });

  it('bodyMask is null when the detection came back from the DB (_gdinoMasks is non-enumerable)', () => {
    const r = resolveCharBbox('Julian', { bestEval, entityReport, pageNumber: -2 });
    expect(r.bodyMask).toBeNull();
  });

  it('reuses the detection SAM silhouette when it is still in memory', () => {
    const det: any = { figures: FIGURES };
    Object.defineProperty(det, '_gdinoMasks', {
      value: ['MASK_JULIAN', 'MASK_KIAAN', 'MASK_LEVIN', 'MASK_UNKNOWN'],
      enumerable: false,
    });
    const r = resolveCharBbox('Julian', { bestEval: { bboxDetection: det }, entityReport, pageNumber: -2 });
    // Index-aligned with figures — Julian is index 0.
    expect(r.bodyMask).toBe('MASK_JULIAN');
  });

  it('falls through to a later tier for a character the entity report does not place', () => {
    const r = resolveCharBbox('Max', { bestEval, entityReport, pageNumber: -2 });
    expect(r.source).not.toBe('entity');
  });
});

// @ts-expect-error - JS module without types
import { resolveFigureMask } from '../../server/lib/charRepairTarget.js';

describe('resolveFigureMask — reuse before re-segmenting', () => {
  it('prefers the in-memory detection silhouette', async () => {
    const m = await resolveFigureMask('Julian', { bodyMask: 'IN_MEMORY', figures: FIGURES }, { storyId: 's', pageNumber: -2 });
    expect(m).toBe('IN_MEMORY');
  });

  it('returns null (→ re-segment, reported as a miss) when the character is not among the figures', async () => {
    const m = await resolveFigureMask('Nobody', { figures: FIGURES }, { storyId: 's', pageNumber: -2 });
    expect(m).toBeNull();
  });

  it('returns null without a storyId rather than guessing', async () => {
    const m = await resolveFigureMask('Julian', { figures: FIGURES }, {});
    expect(m).toBeNull();
  });

  it('never throws when the store is unavailable', async () => {
    // pageNumber present, figures present, but the DB layer will refuse outside
    // database mode — the caller must get null, not an exception.
    const m = await resolveFigureMask('Julian', { figures: FIGURES }, { storyId: 's', pageNumber: -2 });
    expect(m === null || Buffer.isBuffer(m)).toBe(true);
  });
});
