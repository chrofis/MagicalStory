import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { resolveEvalSceneDescription } = require('../../server/lib/sceneMetadata.js');

// BEHAVIOUR PINNED (owner, 2026-09-26; supersedes 2026-09-13): the BATCH image
// eval scores a render against the page's WHOLE brief, shrunk page or not.
//
// The batch eval feeds the judge a scene DESCRIPTION rather than the full
// prompt by design: resolveEvalArtStyle depends on ORIGINAL_PROMPT carrying no
// ART STYLE block. Until 2026-09-26 a page whose built prompt went over the
// image model's cap was judged against `compressedScene` (the post-shrink head
// of the built prompt) while every other page was judged against its brief.
// The standing rule is "every critic judges the source the generator was given,
// uncut"; `compressedScene` stays a record of what was sent.
//
// Assert the RULE, not any prompt wording.

const STORED = 'A rainy quay. The girl kneels beside the overturned rowing boat, reaching for the coiled mooring rope.';
const COMPRESSED = 'A rainy quay. The girl kneels by the boat.'; // what the model really got

describe('resolveEvalSceneDescription — the judge scores the whole brief', () => {
  it('the shrinker fired: the whole brief still wins; the sent head is not an input', () => {
    expect(resolveEvalSceneDescription({ compressedScene: COMPRESSED, sceneDescription: STORED, prompt: 'P' }))
      .toBe(STORED);
  });

  it('no shrink: the value is exactly what this site resolved before', () => {
    // Today's expression was `img.sceneDescription || img.prompt || ''`.
    expect(resolveEvalSceneDescription({ sceneDescription: STORED, prompt: 'P' })).toBe(STORED);
    expect(resolveEvalSceneDescription({ sceneDescription: '   ', prompt: 'P' })).toBe('P');
    expect(resolveEvalSceneDescription({ sceneDescription: '', prompt: 'P' })).toBe('P');
    expect(resolveEvalSceneDescription({})).toBe('');
    expect(resolveEvalSceneDescription()).toBe('');
  });
});

describe('wiring: the compressed scene block is produced and carried as a record', () => {
  const images = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
  const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');
  const repair = fs.readFileSync(new URL('../../server/lib/repairPipeline.js', import.meta.url), 'utf8');

  it('shrinkPromptForModel publishes its compressed HEAD, never the assembled prompt', () => {
    expect(images).toMatch(/shrinkPromptForModel\(prompt, maxPromptLength, logLabel, modelName = null, meta = null\)/);
    // Both surviving branches stamp it through ONE accessor (the paid LLM
    // branch that used to stamp `newHead` was deleted 2026-09-21).
    expect(images).toContain('if (meta) meta.compressedScene = sceneHeadOf(out) || undefined;');
    expect(images).toContain('if (meta) meta.compressedScene = sceneHeadOf(cut.text) || undefined;');
    // The head is taken from strictly before the protected must-keep tail
    // (REQUIRED OBJECTS / KEY STORY ELEMENTS / SEASON / COMPOSITION GUIDELINES /
    // ART STYLE, whichever comes first) — that split is WHY the block can never
    // carry a style section.
    expect(images).toContain('const tailStart = protectedTailStart(prompt);');
    expect(images).toContain('return tailStart > 0 ? prompt.slice(0, tailStart).trim()');
    // Not a second copy of the whole prompt (storage cost + IRON RULE hygiene).
    expect(images).not.toContain('meta.compressedScene = assembled');
  });

  it('both shrink call sites feed the out-param', () => {
    // Both dispatcher call sites go through fitPrompt, which hands the meta to
    // shrinkPromptForModel (a plate prompt carries no scene block to record).
    expect((images.match(/fitPrompt\([^)]*promptMeta\)/g) || []).length).toBe(2);
    expect(images).toContain(': await shrinkPromptForModel(p, cap, logLabel, model, meta);');
  });

  it('the batch eval resolves through the shared accessor, not an inline chain', () => {
    expect(images).toContain('resolveEvalSceneDescription({');
    // …and hands it no post-shrink head.
    expect(images).not.toMatch(/resolveEvalSceneDescription\(\{\s*compressedScene/);
    // The regressed expression must not be rebuildable.
    expect(images).not.toMatch(/img\.sceneDescription \|\| img\.prompt/);
  });

  it('the record reaches the page and every version: generation → page record → versions', () => {
    expect(images).toContain('compressedScene: shrinkMeta.compressedScene');
    expect(pipeline).toContain('compressedScene: genResult.compressedScene || null');
    expect(pipeline).toContain('compressedScene: img.compressedScene || null');
    // The lineage rule moved into one resolver (repairLogic) once the same
    // question had to be answered again at final assembly — see
    // tests/unit/compressed-scene-lineage.test.ts for its behaviour.
    expect(repair).toContain('compressedScene: resolveVersionCompressedScene(entry, orig)');
    expect(repair).toContain('compressedScene: img.compressedScene || null');
    // …and it must survive the repair pipeline's output whitelist, which is
    // where it was being dropped on every page of every full story.
    expect(repair).toContain('compressedScene: resolveVersionCompressedScene(best, img)');
  });
});
