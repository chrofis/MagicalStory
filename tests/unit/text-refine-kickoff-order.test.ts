import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * C1 (pipeline review 2026-09-20) — the text-refine chain is the long pole in
 * front of the whole repair phase: every stage after page generation joins on
 * it (the first eval reads `pageText`, the text-space gate sizes the calm zone
 * from the page's word count, the book audit reads the shipped prose). So the
 * chain must start the MOMENT its own inputs are final — the page text and the
 * Visual Bible — and never wait on something it does not read.
 *
 * Measured on job_1789853503332_riqncqg1i: page text was final at 22:09:50 CH
 * and `text_refine_start` fired at 22:10:49, because the kickoff sat below the
 * landmark-photo race and `await referenceSheetPromise`. 59 s of the join's
 * 588 s wait bought nothing.
 *
 * The pipeline is one ~8k-line function with no free way to execute it, so the
 * ordering is pinned on the source: the kickoff must appear before the two
 * awaits it must not wait on, and after the point where page text is final.
 */
describe('text refinement kickoff ordering (storyJobPipeline)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'storyJobPipeline.js'),
    'utf8'
  );

  const at = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `anchor not found in storyJobPipeline.js: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('starts the refine chain before the landmark-photo race and the reference-sheet await', () => {
    const kickoff = at('textRefinePromise = startBackgroundRefine(');
    const landmarkRace = at('LANDMARK_FETCH_TIMEOUT_MS = 75_000');
    const refSheetAwait = at('const refResult = await referenceSheetPromise;');

    expect(kickoff).toBeLessThan(landmarkRace);
    expect(kickoff).toBeLessThan(refSheetAwait);
  });

  it('starts the refine chain only after page text is final, and never on a text-only job', () => {
    // `expandedScenes` carries the page text; nothing rewrites it after the
    // beats return, which is where it is assigned.
    const scenesFinal = at('expandedScenes = beatsResult.scenes;');
    const textOnlyReturn = at('// Text-only jobs return HERE');
    const kickoff = at('textRefinePromise = startBackgroundRefine(');

    expect(kickoff).toBeGreaterThan(scenesFinal);
    // Below the skipImages early return: a text-only job returns before the
    // kickoff and must not leave a paid chain running behind it.
    expect(kickoff).toBeGreaterThan(textOnlyReturn);
  });

  it('still joins the chain before anything reads the page text', () => {
    const kickoff = at('textRefinePromise = startBackgroundRefine(');
    const join = at('await joinTextRefinement([rawImages]);');
    const textRegion = at("const { ensureCalmZone } = require('./server/lib/textSpaceRepair');");
    const repairPipeline = at('await runUnifiedRepairPipeline(rawImages, {');

    expect(kickoff).toBeLessThan(join);
    expect(join).toBeLessThan(textRegion);
    expect(join).toBeLessThan(repairPipeline);
  });
});
