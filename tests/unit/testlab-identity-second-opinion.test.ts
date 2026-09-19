import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * THE LAB STAGE THAT MEASURES THE THIRD WITNESS.
 *
 * `reconcileIdentityWithSecondWitness` (4ef21cc6c) is proven byte-identical
 * under every stubbed witness that does not contradict the detector. What was
 * never measured is whether the REAL witness ever contradicts it — and the
 * suspicion is that it will not, because it answers the same question from the
 * same badged image under the same prompt. `identity_second_opinion` is the
 * stage that settles that with one Qwen-VL call per stored contested version:
 * no DINO, no SAM, no story generation, so the only moving part is the witness.
 *
 * These tests pin the stage's ARITHMETIC — which is the part a paid run cannot
 * check for itself. A run that reports "0 vetoes" is only believable if the
 * stage would have counted a veto had one happened, would not have counted one
 * from silence, and replayed the EVALUATOR's names rather than the detector's
 * names the page ended up storing. Every witness here is a stub; nothing in
 * this file spends a cent.
 *
 * Inputs are the committed measured corpus (`fixtures/identity-second-witness.json`
 * — every staging version the vote fires on, plus the contested ones it must
 * not fire on). The expected-character lists are the real stored
 * `bboxDetection.expectedCharacters` for those two versions, read off staging
 * on 2026-09-18.
 */
const require_ = createRequire(import.meta.url);
const { runIdentitySecondOpinionStage } = require_('../../server/lib/testlab.js');
const { checkIdentityAgreement } = require_('../../server/lib/identityAgreement');
const fx = require_('./fixtures/identity-second-witness.json');

const DB = require.resolve('../../server/services/database');
const FIGDET = require.resolve('../../server/lib/figureDetection');

const PAGE_BYTES = 'data:image/png;base64,SGVsbG8=';

/** The stored page image, without a database. */
const dbStub = {
  getStoryImage: async () => ({ image_url: 'https://r2.example/page.png' }),
  imgBytesAsync: async () => PAGE_BYTES,
  // Destructured by loadActivePageImage whether or not the pin uses it; absent,
  // Node warns once per call about a missing property on the swapped module.
  getActiveVersion: async () => 0,
};

type WitnessCall = { imageData: string; figures: any[]; expectedCharacters: any[]; pageLabel: string; opts: any };

/**
 * Run the stage with a stubbed page loader and a stubbed witness.
 *
 * Both modules are swapped in the require cache rather than behind a new
 * production seam: the stage requires them INSIDE the function (as the rest of
 * this file does), so the swap reaches the real code path without adding a
 * test-only argument to it.
 */
async function runWith(ctx: any, params: any, witness: (call: WitnessCall) => any) {
  const prevDb = require.cache[DB];
  const prevFig = require.cache[FIGDET];
  const calls: WitnessCall[] = [];
  require.cache[DB] = { exports: dbStub } as any;
  require.cache[FIGDET] = {
    exports: {
      secondOpinionIdentity: async (imageData: string, figures: any[], expectedCharacters: any[], pageLabel: string, opts: any) => {
        const call = { imageData, figures, expectedCharacters, pageLabel, opts };
        calls.push(call);
        return witness(call);
      },
    },
  } as any;
  try {
    const result = await runIdentitySecondOpinionStage(ctx, { params });
    return { result, calls };
  } finally {
    if (prevDb) require.cache[DB] = prevDb; else delete require.cache[DB];
    if (prevFig) require.cache[FIGDET] = prevFig; else delete require.cache[FIGDET];
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const byKey = (k: string) => fx.versions.find((v: any) => v.key === k);

/**
 * A stored version record in the shape `stories.data.sceneImages[].imageVersions[]`
 * really holds it: `matches[].reference` carries the DETECTOR's name once
 * reconciliation has renamed, and the evaluator's own name survives only in
 * `evaluatorReference`. `renamedInStore: false` is the other real shape — a
 * version whose conflict production never applied.
 */
function versionRecord(v: any, expectedCharacters: string[], { renamedInStore = true } = {}) {
  const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures), {});
  const detectorNameFor = new Map<string, string>((report?.conflicts || []).map((c: any) => [c.evaluator, c.detector]));
  const matches = v.matches.map((m: any) => {
    const det = renamedInStore ? detectorNameFor.get(m.reference) : undefined;
    return det ? { ...clone(m), reference: det, evaluatorReference: m.reference } : clone(m);
  });
  return {
    matches,
    fixableIssues: clone(v.fixableIssues || []),
    bboxDetection: {
      figures: clone(v.detectorFigures),
      expectedCharacters: expectedCharacters.map(name => ({ name })),
      gdinoDiag: { identity: { model: 'gemini-full' } },
    },
  };
}

function ctxFor(v: any, expectedCharacters: string[], opts: { renamedInStore?: boolean; versionIndex?: number } = {}) {
  const versionIndex = opts.versionIndex ?? 0;
  const imageVersions: any[] = [];
  imageVersions[versionIndex] = versionRecord(v, expectedCharacters, { renamedInStore: opts.renamedInStore !== false });
  return {
    storyId: v.storyId,
    pageNumber: v.pageNumber,
    versionIndex,
    scene: { pageNumber: v.pageNumber, imageVersions },
  };
}

// The two pixel-judged versions from Lab set 66 / experiment 1324, with their
// real stored expectedCharacters.
const DETECTOR_RIGHT = byKey('job_1789147573901_m3uam0nxi|p2|v0');
const DETECTOR_RIGHT_CAST = ['Levin', 'Julian'];
const EVALUATOR_RIGHT = byKey('job_1789584708605_rts4wqupm|p18|v0');
const EVALUATOR_RIGHT_CAST = ['Levin', 'Julian', 'Max', 'Kiaan', 'Big Dragon', 'Flämmli'];

/** A witness that repeats the detector's name for every figure. */
const echoesDetector = (call: WitnessCall) => ({
  model: 'qwen-vl-full',
  nameByFigure: new Map(call.figures.map((f: any, i: number) => [i, f.name])),
});

/**
 * A witness that backs the EVALUATOR on every contested figure — built from the
 * conflict report, the one place the two claims sit side by side, keyed by the
 * `detIndex` the conflict carries for exactly this purpose.
 */
function backsEvaluator(v: any) {
  const report = checkIdentityAgreement(clone(v.matches), clone(v.detectorFigures), {});
  return (call: WitnessCall) => ({
    model: 'qwen-vl-full',
    nameByFigure: new Map(call.figures.map((f: any, i: number) => {
      const c = (report?.conflicts || []).find((x: any) => x.detIndex === i);
      return [i, c ? c.evaluator : f.name];
    })),
  });
}

afterEach(() => { delete require.cache[DB]; delete require.cache[FIGDET]; });

describe('identity_second_opinion — what it refuses to run on', () => {
  it('refuses an unpinned target: the conflict belongs to one version, not to the active one', async () => {
    const ctx: any = ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST);
    ctx.versionIndex = null;
    await expect(runWith(ctx, {}, echoesDetector)).rejects.toThrow(/pinned versionIndex/);
  });

  it('fails loudly when the pinned version does not exist', async () => {
    const ctx: any = ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST);
    ctx.versionIndex = 7;
    await expect(runWith(ctx, {}, echoesDetector)).rejects.toThrow(/No stored imageVersions\[7\]/);
  });

  it('fails loudly on a version with no stored figures, and on one with no expected cast', async () => {
    const noFigs: any = ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST);
    noFigs.scene.imageVersions[0].bboxDetection.figures = [];
    await expect(runWith(noFigs, {}, echoesDetector)).rejects.toThrow(/no bboxDetection\.figures/);

    const noCast: any = ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST);
    noCast.scene.imageVersions[0].bboxDetection.expectedCharacters = [];
    await expect(runWith(noCast, {}, echoesDetector)).rejects.toThrow(/no bboxDetection\.expectedCharacters/);
  });
});

describe('identity_second_opinion — it replays the EVALUATOR, not the page as stored', () => {
  it('undoes the stored rename, so the conflict the witness is asked about is the real one', async () => {
    const { result } = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, echoesDetector);
    // Stored, the page says Levin/Julian the DETECTOR's way round. Replayed, it
    // must say what the evaluator said — otherwise both sides agree and there
    // is nothing to measure.
    expect(result.evaluatorMatches).toEqual(DETECTOR_RIGHT.matches.map((m: any) => m.reference));
    expect(result.conflicts.length).toBe(2);
    expect(result.conflicts.map((c: any) => `${c.evaluator}->${c.detector}`).sort())
      .toEqual(DETECTOR_RIGHT.conflictPairs.slice().sort());
  });

  it('a version production never renamed replays identically — evaluatorReference is an undo, not a requirement', async () => {
    const renamed = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST, { renamedInStore: true }), {}, echoesDetector);
    const never = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST, { renamedInStore: false }), {}, echoesDetector);
    expect(never.result.evaluatorMatches).toEqual(renamed.result.evaluatorMatches);
    expect(never.result.conflicts).toEqual(renamed.result.conflicts);
  });

  it('asks the witness with the stored image, the stored figures, the stored cast and the model that already answered', async () => {
    const { result, calls } = await runWith(ctxFor(EVALUATOR_RIGHT, EVALUATOR_RIGHT_CAST, { versionIndex: 0 }), {}, echoesDetector);
    expect(calls.length).toBe(1);
    expect(calls[0].imageData).toBe(PAGE_BYTES);
    expect(calls[0].figures.map((f: any) => f.name)).toEqual(EVALUATOR_RIGHT.detectorFigures.map((f: any) => f.name));
    expect(calls[0].expectedCharacters.map((c: any) => c.name)).toEqual(EVALUATOR_RIGHT_CAST);
    // A first witness asked twice is not a second one.
    expect(calls[0].opts.excludeModel).toBe('gemini-full');
    expect(result.primaryIdentityModel).toBe('gemini-full');
    expect(result.witnessModel).toBe('qwen-vl-full');
  });
});

describe('identity_second_opinion — the veto arithmetic', () => {
  it('a witness that echoes the detector changes nothing, and the stage says so', async () => {
    const { result } = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), { groundTruth: 'detector' }, echoesDetector);
    expect(result.votes.every((v: any) => v.verdict === 'detector')).toBe(true);
    expect(result.vetoed).toBe(0);
    expect(result.withoutWitness.renamed).toBeGreaterThan(0);
    expect(result.withWitness.renamed).toBe(result.withoutWitness.renamed);
    expect(result.renamesWithheld).toBe(0);
    expect(result.vetoClass).toBe('correct-no-veto');
  });

  it('a witness that backs the evaluator withholds the rename — and on a detector-right page that is a FALSE veto', async () => {
    const { result } = await runWith(
      ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), { groundTruth: 'detector' },
      backsEvaluator(DETECTOR_RIGHT),
    );
    expect(result.vetoed).toBeGreaterThan(0);
    expect(result.withWitness.renamed).toBe(0);
    expect(result.renamesWithheld).toBe(result.withoutWitness.renamed);
    expect(result.withWitness.uncorrectableReason).toBe('second-witness-veto');
    expect(result.vetoClass).toBe('false-veto');
  });

  it('the same veto on an evaluator-right page is a TRUE veto — the label comes from the pixels, not from the vote', async () => {
    const ctx = ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST);
    const { result } = await runWith(ctx, { groundTruth: 'evaluator' }, backsEvaluator(DETECTOR_RIGHT));
    expect(result.renamesWithheld).toBeGreaterThan(0);
    expect(result.vetoClass).toBe('true-veto');

    const echoed = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), { groundTruth: 'evaluator' }, echoesDetector);
    expect(echoed.result.renamesWithheld).toBe(0);
    expect(echoed.result.vetoClass).toBe('missed-veto');
  });

  it('without a pixel verdict the entry stays unclassified rather than guessing', async () => {
    const { result } = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, echoesDetector);
    expect(result.groundTruth).toBeNull();
    expect(result.vetoClass).toBeNull();
  });

  it('SILENCE IS NOT A VETO: no answer, a failed call and a third name all rename exactly as today', async () => {
    const baseline = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, echoesDetector);

    const silent = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, () => null);
    expect(silent.result.witnessAnswered).toBe(false);
    expect(silent.result.withWitness.renamed).toBe(baseline.result.withoutWitness.renamed);
    expect(silent.result.renamesWithheld).toBe(0);

    const threw = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, () => { throw new Error('OpenRouter HTTP 503'); });
    expect(threw.result.witnessAnswered).toBe(false);
    expect(threw.result.witnessError).toMatch(/503/);
    expect(threw.result.withWitness.renamed).toBe(baseline.result.withoutWitness.renamed);
    expect(threw.result.renamesWithheld).toBe(0);

    const thirdName = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), {}, (call) => ({
      model: 'qwen-vl-full',
      nameByFigure: new Map(call.figures.map((_f: any, i: number) => [i, 'Kiaan'])),
    }));
    expect(thirdName.result.votes.every((v: any) => v.verdict === 'third-name')).toBe(true);
    expect(thirdName.result.vetoed).toBe(0);
    expect(thirdName.result.renamesWithheld).toBe(0);
  });

  it('the note carries the whole verdict, so the Lab card says it without a new renderer', async () => {
    const { result } = await runWith(ctxFor(DETECTOR_RIGHT, DETECTOR_RIGHT_CAST), { groundTruth: 'detector' }, echoesDetector);
    expect(result.note).toContain('witness qwen-vl-full');
    expect(result.note).toContain('veto 0/2');
    expect(result.note).toContain('pixel truth: detector-right');
  });
});

describe('identity_second_opinion — it never spends a call it cannot learn from', () => {
  it('asks no witness on a clean page, a face-paired page or a non-permutation', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind !== 'vote-fires')) {
      // The cast the witness would be offered is irrelevant here — the point is
      // that it is never offered one.
      const cast = Array.from(new Set([
        ...v.detectorFigures.map((f: any) => f.name),
        ...v.matches.map((m: any) => m.reference),
      ])).filter(Boolean) as string[];
      const { result, calls } = await runWith(ctxFor(v, cast), {}, echoesDetector);
      expect(calls.length, `${v.key} (${v.kind}) must not be asked`).toBe(0);
      expect(result.votes).toEqual([]);
      expect(result.vetoed).toBe(0);
      expect(result.renamesWithheld).toBe(0);
    }
  });

  it('asks exactly one witness on every version the vote fires on', async () => {
    for (const v of fx.versions.filter((x: any) => x.kind === 'vote-fires')) {
      const cast = Array.from(new Set([
        ...v.detectorFigures.map((f: any) => f.name),
        ...v.matches.map((m: any) => m.reference),
      ])).filter(Boolean) as string[];
      const { result, calls } = await runWith(ctxFor(v, cast), {}, echoesDetector);
      expect(calls.length, `${v.key} must be asked exactly once`).toBe(1);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.withoutWitness.renamed).toBeGreaterThan(0);
    }
  });
});
