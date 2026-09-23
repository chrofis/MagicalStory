import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveTextStagePictureSpec, buildTextStagePictureSpecs } = require('../../server/lib/sceneMetadata.js');
const { extractRefinablePages } = require('../../server/lib/textRefine.js');

// BEHAVIOUR PINNED: the arc-informed text auditor judges a page against THE SAME
// PICTURE SPEC THE WRITER WROTE IT FROM — the whole locked scene brief — and so
// does the repair pass that acts on its faults.
//
// It did not. `extractRefinablePages` only produced a compact `sceneIntent` from
// `sceneMetadata.sceneIntent` or a JSON `outlineExtract`; in the beats pipeline
// (the pipeline in every environment) beatsPipeline.js sets no `sceneMetadata`
// on the scenes storyJobPipeline hands the refiner, and `outlineExtract` is the
// string "PLAN: …", never JSON. So every beats page fell to
// `sceneDescription.slice(0, 600)` and the auditor saw a blind head cut, while
// the writer (buildStoryTextFromBeatsPrompt) and the repairer
// (buildStoryTextRefinePrompt) both read the brief whole. An event in the
// brief's later paragraphs therefore drew `FAULT[MISMATCH]` and the repair pass
// deleted prose the illustration does contain.
//
// Assert the RULE — the three specs are the same string — not prompt wording.

// A beats page exactly as beatsPipeline.js builds it: no sceneMetadata, a
// "PLAN: …" outlineExtract, and a brief well past 600 characters.
const PARA_1 = 'Wide shot of a rain-dark courtyard at dusk. '.repeat(10);
const PARA_3 = 'In the far corner the grandmother lifts the copper lantern off its hook and the dog bolts for the gate.';
const BRIEF = `${PARA_1}\n\n${'A crowd of market traders packs the arcade behind them. '.repeat(6)}\n\n${PARA_3}`;
const WITH_METADATA = `${BRIEF}\n---METADATA---\n{"characters":["Grandmother"]}`;

const beatsScene = {
  pageNumber: 4,
  text: 'Grandmother reached up for the lantern, and the dog shot away into the rain.',
  sceneDescription: WITH_METADATA,
  outlineExtract: 'PLAN: the grandmother takes down the lantern as the dog bolts',
};

describe('resolveTextStagePictureSpec — auditor spec == writer spec', () => {
  it('the brief used here is the case that regressed: over 600 chars, with the event in the tail', () => {
    expect(BRIEF.length).toBeGreaterThan(600);
    expect(BRIEF.slice(0, 600)).not.toContain('lantern');
  });

  it('a beats page reaches the auditor with the WHOLE brief, not a 600-char head cut', () => {
    const [page] = extractRefinablePages([beatsScene]);
    const auditorSpec = resolveTextStagePictureSpec(page);
    expect(auditorSpec).toBe(BRIEF);
    expect(auditorSpec).toContain('lantern');
    expect(auditorSpec!.length).toBeGreaterThan(600);
  });

  it('the auditor, the writer and the repairer read one identical spec', () => {
    const [page] = extractRefinablePages([beatsScene]);
    // What buildStoryTextFromBeatsPrompt hands the writer (one shared builder
    // since 2026-09-23), and what the repairer reads through the same resolver.
    const writerSpec = buildTextStagePictureSpecs([{ pageNumber: 4, brief: beatsScene.sceneDescription }]).get(4);
    expect(resolveTextStagePictureSpec(page)).toBe(writerSpec);
  });

  it('METADATA is never shown to a text-stage reader', () => {
    expect(resolveTextStagePictureSpec({ sceneDescription: WITH_METADATA })).not.toContain('METADATA');
  });

  it('the compact intent is a last resort, never preferred over the brief', () => {
    expect(resolveTextStagePictureSpec({ sceneBrief: BRIEF, sceneIntent: 'a lantern, a dog' })).toBe(BRIEF);
    expect(resolveTextStagePictureSpec({ sceneIntent: 'a lantern, a dog' })).toBe('a lantern, a dog');
    expect(resolveTextStagePictureSpec({})).toBeNull();
  });
});

describe('Lab audit replay == production', () => {
  // The Lab's audit_replay (testlab.js) rebuilds the auditor's pages from the
  // STORED story. It used to pass `sceneIntent: p.sceneIntent || p.sceneDescription`,
  // handing the replay the FULL brief where production had the 600-char slice —
  // the opposite truncation — and it omitted the arc argument entirely, so
  // STORY_ARC read "(no story was recorded)" three lines after the arc was
  // fetched. Both directions made a prompt A/B read "fewer faults = better".
  it('the replay resolves the same spec and plan line from the stored row that production does in flight', () => {
    const stored = { ...beatsScene, sceneIntent: 'a lantern, a dog' };
    const [replayPage] = extractRefinablePages([stored]);
    const [productionPage] = extractRefinablePages([beatsScene]);
    expect(resolveTextStagePictureSpec(replayPage)).toBe(resolveTextStagePictureSpec(productionPage));
    expect(replayPage.planLine).toBe(productionPage.planLine);
  });

  it('the replay call site passes the arc, its hints and the brief-bearing fields', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(new URL('../../server/lib/testlab.js', import.meta.url), 'utf8');
    expect(src).toContain('H.buildTextAuditPrompt(storyData, pages, arc, { arcHints: resolveReplayArcHints(storyData) })');
    expect(src).toContain("const pages = extractRefinablePages(storyData.sceneImages || []);");
  });
});
