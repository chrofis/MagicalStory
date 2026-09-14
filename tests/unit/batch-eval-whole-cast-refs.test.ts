import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the batch quality judge gets real references.
// Since character storage normalised to photos[]/avatars.styledAvatars, the
// whole-cast list was built by a filter on `photoUrl || avatars.styled` that
// matches nothing — every batch eval ran with zero reference images and no
// clothing contract (staging job_1789343124794_z2c779f7i: N-16 on all 36
// evals, every main-cast token unresolved).

const { buildWholeCastReferencePhotos } = require_('../../server/lib/clothingResolve.js');

// A character in the STORED shape: no photoUrl, no avatars.styled.
const storedCharacter = (name: string) => ({
  id: `id-${name}`,
  name,
  photos: { primary: `data:image/jpeg;base64,${name}-primary` },
  avatars: {
    standard: `data:image/jpeg;base64,${name}-standard`,
    clothing: { standard: 'blue jumper, grey trousers, brown shoes' },
    styledAvatars: {
      watercolor: { standard: { imageUrl: `https://r2.example/${name}-wc-standard.jpg` } },
    },
  },
});

describe('whole-cast reference photos come from the real resolver', () => {
  const cast = [storedCharacter('Levin'), storedCharacter('Julian')];

  it('a stored-shape character yields a reference with a photo and a clothing contract line', () => {
    const refs = buildWholeCastReferencePhotos(cast, 'watercolor', null);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref.photoUrl).toBeTruthy();
      expect(ref.clothingDescription).toBeTruthy();
    }
    expect(refs.map((r: any) => r.name).sort()).toEqual(['Julian', 'Levin']);
  });

  it('the regressed filter really does match nothing on that shape', () => {
    // Guards the test itself against a fixture that would have passed before.
    const old = cast.filter((c: any) => c.photoUrl || c.avatars?.styled);
    expect(old).toHaveLength(0);
  });

  it('the per-story clothing requirements win over the stored outfit', () => {
    const refs = buildWholeCastReferencePhotos(cast, 'watercolor', {
      Levin: { standard: { used: true, signature: 'red raincoat, yellow boots' } },
    });
    const levin = refs.find((r: any) => r.name === 'Levin');
    expect(levin.clothingDescription).toContain('red raincoat');
  });
});

describe('composeEvalReferencePhotos: page outfit first, whole cast fills the rest', () => {
  const { composeEvalReferencePhotos } = require_('../../server/lib/images.js');

  const pagePhotos = [{ name: 'Levin', photoUrl: 'p1', clothingDescription: 'pirate coat, tricorne hat' }];
  const castPhotos = [
    { name: 'levin', photoUrl: 'c1', clothingDescription: 'blue jumper, grey trousers' },
    { name: 'Julian', photoUrl: 'c2', clothingDescription: 'green shirt' },
  ];

  it('the page outfit beats the story-level outfit for the same character', () => {
    const refs = composeEvalReferencePhotos(pagePhotos, castPhotos);
    const levin = refs.filter((r: any) => String(r.name).toLowerCase() === 'levin');
    expect(levin).toHaveLength(1);
    expect(levin[0].clothingDescription).toContain('pirate coat');
  });

  it('a cast member absent from the page is appended', () => {
    const refs = composeEvalReferencePhotos(pagePhotos, castPhotos);
    expect(refs.map((r: any) => r.name)).toContain('Julian');
  });

  it('an empty whole-cast list never empties a non-empty page list', () => {
    expect(composeEvalReferencePhotos(pagePhotos, [])).toHaveLength(1);
    expect(composeEvalReferencePhotos(pagePhotos, null)).toHaveLength(1);
  });

  it('an empty page list falls back to the whole cast', () => {
    expect(composeEvalReferencePhotos([], castPhotos)).toHaveLength(2);
  });
});

// ── "I had nothing to check" is part of the RESULT (2026-09-14) ─────────────
// The bug above survived seven months because silence from a check that ran
// clean and silence from a check that COULD NOT RUN were the same signal: the
// eval logged "clothing findings suppressed (N-16)" and then returned a
// perfectly normal score, with nothing in the result or the stored story
// saying that dimension was never judged.
//
// RECORDING ONLY. The owner measured page-score stacking the same day and
// deliberately left scoring as-is, so the load-bearing assertion here is that
// the score is BYTE-IDENTICAL with and without the missing input.

const { createNotEvaluatedRecorder, collectNotEvaluated } = require_('../../server/lib/notEvaluated.js');
const evalPipeline = require_('../../server/lib/evalPipeline.js');
const textModels = require_('../../server/lib/textModels.js');

// A fixed, deterministic compliance reply, so the only thing that varies
// between the two runs below is whether the judge got its figures input.
const COMPLIANCE_REPLY = JSON.stringify({
  verdict: 'PASS',
  issues_summary: 'nothing to report',
  fixable_issues: [{ description: 'a minor colour drift on a background prop', severity: 'MINOR', type: 'default' }],
});

async function runThreeStage(withFigures: boolean) {
  const realCall = textModels.callTextModel;
  textModels.callTextModel = async () => ({ text: COMPLIANCE_REPLY, usage: { input_tokens: 10, output_tokens: 10 } });
  try {
    return await evalPipeline.evaluateThreeStage('data:image/png;base64,AAAA', 'a page prompt', 'a scene hint', {
      pageContext: 'p3',
      // A stub template, so the test does not depend on prompts/ being loaded.
      compliancePromptOverride: 'COMPLIANCE / FIGURES: {QUALITY_FIGURES} / PROMPT: {ORIGINAL_PROMPT}',
      inventoryPromise: Promise.resolve('one figure, centre frame'),
      qualityFiguresPromise: withFigures
        ? Promise.resolve({ figures: [{ id: 'F1', description: 'a child, centre frame' }], matches: [{ character: 'Mia', figure: 'F1' }] })
        : null,
    });
  } finally {
    textModels.callTextModel = realCall;
  }
}

describe('notEvaluated — a check that could not run says so in its result', () => {
  it('records the dimension when the input is missing, and records nothing when it is present', async () => {
    const blind = await runThreeStage(false);
    const sighted = await runThreeStage(true);

    // Both produced a normal result of the usual shape.
    for (const r of [blind, sighted]) {
      expect(r).toBeTruthy();
      expect(typeof r.score).toBe('number');
      expect(r.verdict).toBe('PASS');
      expect(Array.isArray(r.fixableIssues)).toBe(true);
      expect(Array.isArray(r.notEvaluated)).toBe(true);
    }

    // Without its figures input, the identity-attribution dimension is named.
    expect(blind.notEvaluated.map((e: any) => e.dimension)).toContain('identity_attribution');
    expect(blind.notEvaluated[0].reason).toBe('quality_figures_unavailable');

    // With it, nothing is recorded.
    expect(sighted.notEvaluated).toEqual([]);

    // THE REGRESSION THAT PROTECTS THE SCORING DECISION: an unjudged dimension
    // is never a deduction. Same score, same findings, both ways.
    expect(blind.score).toBe(sighted.score);
    expect(blind.fixableIssues.length).toBe(sighted.fixableIssues.length);
    expect(blind.issuesSummary).toBe(sighted.issuesSummary);
  });

  it('one entry per (dimension, reason), and the detail never changes the key', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'p7' });
    expect(rec.isEmpty()).toBe(true);
    rec.record('clothing', 'no_clothing_contract', 'first detail');
    rec.record('clothing', 'no_clothing_contract', 'a different detail');
    rec.record('identity', 'reference_photos_unusable', '3/4 photos could not be attached');
    rec.record('', 'ignored');
    expect(rec.list()).toEqual([
      { dimension: 'clothing', reason: 'no_clothing_contract', detail: 'first detail', pageContext: 'p7' },
      { dimension: 'identity', reason: 'reference_photos_unusable', detail: '3/4 photos could not be attached', pageContext: 'p7' },
    ]);
  });

  it('the entry reaches the persisted report structure', () => {
    // The shape repairPipeline rolls up into finalChecksReport.notEvaluated.
    const report = collectNotEvaluated([
      { pageNumber: 1, notEvaluated: [] },
      { pageNumber: 2, notEvaluated: null },
      { pageNumber: 3, notEvaluated: [{ dimension: 'clothing', reason: 'no_clothing_contract', detail: 'N-16' }] },
      { pageNumber: 4, notEvaluated: [{ dimension: 'identity', reason: 'reference_photos_unusable', detail: null }] },
    ]);
    expect(report.entryCount).toBe(2);
    expect(report.dimensions).toEqual(['clothing', 'identity']);
    expect(report.pages.map((p: any) => p.pageNumber)).toEqual([3, 4]);
    expect(report.pages[0].entries[0]).toEqual({ dimension: 'clothing', reason: 'no_clothing_contract', detail: 'N-16' });
    // Nothing to say → null, never an empty husk (same contract as
    // shippedDefective / repairRounds).
    expect(collectNotEvaluated([{ pageNumber: 1, notEvaluated: [] }])).toBeNull();
    expect(collectNotEvaluated(null)).toBeNull();
  });
});
