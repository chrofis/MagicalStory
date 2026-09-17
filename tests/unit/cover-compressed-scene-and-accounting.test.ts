/**
 * THREE THINGS A PAID RUN MUST WRITE DOWN.
 *
 * All three were measured absent on staging and all three are plumbing: a
 * value is produced, and a whitelist between the producer and `stories.data`
 * has no key for it.
 *
 * 1. **A COVER'S SENT PROSE.** `generateImageOnly` stamps the post-shrink scene
 *    block as `compressedScene` when a built prompt goes over the model's cap
 *    (tests/unit/compressed-scene-lineage.test.ts pins that). The PAGE path was
 *    fixed in 434ea1e89; the COVER path never stamped it at all — three
 *    separate output whitelists in `iterateCover` carried `prompt` and no such
 *    key, and so did every cover record in storyJobPipeline. Measured on
 *    staging job_1789584708605_rts4wqupm: `compressedScene` ABSENT on all three
 *    cover roots and null on all three v0 versions. `prompt` on a cover is the
 *    PRE-shrink build, so a shrunk cover left no record of what the model read.
 *
 * 2. **VISUAL BIBLE REFERENCE-SHEET RENDERS.** They go through
 *    `callGeminiAPIForImage` with no `usageTracker` threaded to them, so they
 *    appeared under NO `byFunction` key. On staging job_1789506283204_3kxqshifx
 *    `tokenUsage.grok` booked 52 image calls and `gemini_image` booked 0, while
 *    that run rendered 4+ reference-sheet batches.
 *
 * 3. **WHAT THE REPAIR ROUND APPLIED.** `textRefineReport.roundTrace` reported
 *    `appliedCount: null` for round 1 — the most expensive text call in the
 *    chain ($0.94 on that same run) — while rounds 2 and 3 reported 7 and 0.
 *
 * The cover assembly and the refine chain cannot be invoked from a unit test
 * (both need a whole story and paid calls), so the hops are pinned
 * structurally — the same technique compressed-scene-lineage.test.ts uses for
 * the page path. The pure parts (the shrinker's stamp, the lineage resolver,
 * the usage sink) are exercised for real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const coverIterate = read('server/lib/coverIterate.js');
const pipeline = read('storyJobPipeline.js');
const refSheets = read('server/lib/referenceSheets.js');
const textRefine = read('server/lib/textRefine.js');

// ── 1. A COVER'S SENT PROSE ──────────────────────────────────────────────────

describe('a cover records the prose its render actually received', () => {
  it('iterateCover carries it out of every one of its three result shapes', () => {
    // The direct render, the composite return and the final return are three
    // independent whitelists in ONE function; a cover leaves through exactly
    // one of them, so a key on two of the three is still a silent drop.
    expect(coverIterate).toContain('compressedScene: genResult.compressedScene || null');
    expect((coverIterate.match(/compressedScene: imageResult\.compressedScene \|\| null/g) || []).length)
      .toBeGreaterThanOrEqual(2);
  });

  it('the initial cover render carries it into the cover record', () => {
    // Two generation sites (the streaming cover and the trial front cover) and
    // the coverImages whitelist they both feed.
    expect(pipeline).toContain('compressedScene: coverResult.compressedScene || null');
    expect((pipeline.match(/compressedScene: result\.compressedScene \|\| null/g) || []).length)
      .toBeGreaterThanOrEqual(2);
  });

  it('the cover enters the repair pipeline with it, so v0 can resolve it', () => {
    // resolveVersionCompressedScene falls back to the PAGE record for an
    // original-lineage version; without this the original cover version
    // resolves to null however the render went.
    expect(pipeline).toContain('compressedScene: coverData.compressedScene || null');
  });

  it('the shipped version\'s value is mirrored back onto the cover root', () => {
    // A page gets this free (its stored record IS the pipeline mapping); a
    // cover is copied back field by field, so a repaired cover otherwise keeps
    // the ORIGINAL render's prose beside a rewrite's pixels.
    expect(pipeline).toContain('coverImages[coverKey].compressedScene = img.compressedScene ?? null');
  });

  it('no cover path ever substitutes the pre-shrink build for the sent prose', () => {
    // Null means "was not shrunk". A fallback to `prompt` or to the brief would
    // make every cover look shrunk and hand the judges the wrong string.
    for (const src of [coverIterate, pipeline]) {
      expect(src).not.toMatch(/compressedScene:[^\n]*\b(sceneDescription|coverPrompt)\b/);
    }
  });

  it('an original-lineage cover version resolves the root, and null stays null', () => {
    const { resolveVersionCompressedScene } = require_('../../server/lib/repairLogic');
    const shrunkCover = { compressedScene: 'the head the cover model got', sceneDescription: 'the cover brief' };
    expect(resolveVersionCompressedScene({ source: 'original' }, shrunkCover))
      .toBe('the head the cover model got');
    // The under-cap cover: nothing recorded, nothing invented.
    const plainCover = { compressedScene: null, sceneDescription: 'the cover brief' };
    expect(resolveVersionCompressedScene({ source: 'original' }, plainCover)).toBeNull();
  });
});

// ── 2. REFERENCE-SHEET RENDER ACCOUNTING ─────────────────────────────────────

describe('a Visual Bible reference-sheet render is costed like every other image call', () => {
  const { runWithUsageSink } = require_('../../server/lib/usageContext');
  const {
    recordReferenceSheetUsage,
    REFERENCE_SHEET_USAGE_LABEL,
  } = require_('../../server/lib/referenceSheets');

  type Booked = { provider: string; usage: any; label: string; modelId: string | null };
  const bookedBy = (result: any, label?: string): Booked[] => {
    const booked: Booked[] = [];
    runWithUsageSink(
      (provider: string, usage: any, label2: string, modelId: string) =>
        booked.push({ provider, usage, label: label2, modelId }),
      () => recordReferenceSheetUsage(result, label),
    );
    return booked;
  };

  it('books the grid render under its own byFunction label', () => {
    const booked = bookedBy({
      imageData: 'data:image/jpeg;base64,AAAA',
      modelId: 'gemini-3-pro-image',
      usage: { input_tokens: 1200, output_tokens: 1300 },
    });
    expect(booked).toHaveLength(1);
    expect(booked[0].label).toBe(REFERENCE_SHEET_USAGE_LABEL);
    expect(booked[0].provider).toBe('gemini_image');
    expect(booked[0].usage).toEqual({ input_tokens: 1200, output_tokens: 1300 });
    expect(booked[0].modelId).toBe('gemini-3-pro-image');
  });

  it('books under the provider that actually rendered it, not always Gemini', () => {
    expect(bookedBy({ modelId: 'grok-imagine-image-2.0', usage: {} })[0].provider).toBe('grok');
    expect(bookedBy({ modelId: 'runware:101@1', usage: {} })[0].provider).toBe('runware');
    expect(bookedBy({ modelId: null, usage: {} })[0].provider).toBe('gemini_image');
  });

  it('a gate/solo re-render is a SECOND paid render and gets its own bucket', () => {
    const label = `${REFERENCE_SHEET_USAGE_LABEL}_rerender`;
    expect(bookedBy({ modelId: 'gemini-3-pro-image', usage: {} }, label)[0].label).toBe(label);
  });

  it('books nothing when the provider reported no usage, and never throws', () => {
    expect(bookedBy(null)).toHaveLength(0);
    expect(bookedBy({ imageData: 'x', modelId: 'm' })).toHaveLength(0);
  });

  it('outside a job there is no sink and the render is unaffected', () => {
    // Test Lab, scripts and tests run with no usage context; accounting must
    // be a no-op there rather than an exception on a paid render.
    expect(() => recordReferenceSheetUsage({ modelId: 'm', usage: {} })).not.toThrow();
  });

  it('every reference-sheet render call site books its usage', () => {
    // Two renders exist: the batch grid and the cell-gate / missing-reference
    // solo re-render. Both are paid, so both are booked.
    const renders = (refSheets.match(/await callGeminiAPIForImage\(/g) || []).length;
    const books = (refSheets.match(/recordReferenceSheetUsage\(/g) || []).length;
    expect(renders).toBeGreaterThanOrEqual(2);
    // One definition + one call per render.
    expect(books).toBe(renders + 1);
  });
});

// ── 3. WHAT THE REPAIR ROUND APPLIED ─────────────────────────────────────────

describe('every text-refine round records how much it landed', () => {
  it('the whole-page passes record their changed-page count', () => {
    // runRepairPass serves round 1 (repair) and both corrective passes
    // (repetition_fix, length_fix). They rewrite WHOLESALE — findings in as
    // prose, whole page blocks back — so there is no per-finding applier; the
    // comparable unit is the page.
    expect(textRefine).toContain('appliedCount: changedPages.length');
  });

  it('the trace no longer treats appliedCount as lector-only', () => {
    // `null` must keep ONE meaning across the trace: this round recorded
    // nothing. Reading it as "not applicable here" is what hid a $0.94 call.
    expect(pipeline).toContain('appliedCount: r.appliedCount ?? null');
    expect(pipeline).not.toContain('// Lector only: how many of its findings');
  });

  it('a wholesale round counts only pages whose text actually changed', () => {
    // The rule the implementation encodes: a returned page identical to the
    // base is not an application, exactly as a dropped lector finding is not.
    const base = [{ pageNumber: 1, text: 'a' }, { pageNumber: 2, text: 'b' }, { pageNumber: 3, text: 'c' }];
    const returned = new Map([[1, 'a'], [2, 'B!']]);   // p1 returned unchanged, p3 not returned
    const next = base.map(p => ({ ...p, text: returned.get(p.pageNumber) || p.text }));
    const changedPages = next.filter((p, idx) => p.text !== base[idx].text).map(p => p.pageNumber);
    expect(changedPages).toEqual([2]);
    expect(changedPages.length).toBe(1);
  });
});

// ── 4. THE LAB REPLAY SEES THE SAME BIBLE PRODUCTION DOES ────────────────────

describe('the scene-review replay is given the Visual Bible, as production is', () => {
  const testlab = read('server/lib/testlab.js');

  it('the replay stage passes the story\'s bible', () => {
    // Without it buildSceneReviewPrompt emits NO `# VISUAL BIBLE — STATED
    // OBJECTS` block at all, so a replay can never see a state's page range,
    // never emit a corrected entry, and check 9f under-reports against the
    // production run the stage exists to mirror.
    expect(testlab).toMatch(/prompt = buildSceneReviewPrompt\(storyData, scenes, \{[\s\S]{0,200}?visualBible: storyData\.visualBible,/);
  });

  it('the block it unlocks lists a stated object with its state page ranges', async () => {
    const { loadPromptTemplates } = require_('../../server/services/prompts');
    await loadPromptTemplates();
    const PB = require_('../../server/lib/promptBuilders');
    const inputData = { characters: [{ name: 'Mila' }], language: 'de', pages: 2 };
    const scenes = [{ pageNumber: 1, brief: 'A hallway.' }, { pageNumber: 2, brief: 'The same hallway.' }];
    const visualBible = {
      artifacts: [{
        id: 'ART001',
        name: 'the lantern',
        description: 'a brass lantern',
        states: [
          { id: 'ART001.1', name: 'unlit', delta: 'dark glass', pages: [1] },
          { id: 'ART001.2', name: 'lit', delta: 'warm glow', pages: [2] },
        ],
      }],
    };
    const withBible = PB.buildSceneReviewPrompt(inputData, scenes, { visualBible });
    const without = PB.buildSceneReviewPrompt(inputData, scenes, {});
    expect(without).not.toContain('# VISUAL BIBLE — STATED OBJECTS');
    expect(withBible).toContain('# VISUAL BIBLE — STATED OBJECTS');
    expect(withBible).toContain('ART001.1');
    expect(withBible).toContain('pages [1]');
    expect(withBible).toContain('pages [2]');
  });
});
