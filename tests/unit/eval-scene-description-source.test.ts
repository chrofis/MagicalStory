import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { resolveEvalSceneDescription } = require('../../server/lib/sceneMetadata.js');

// BEHAVIOUR PINNED: the BATCH image eval scores a render against the scene
// DESCRIPTION the image model actually received.
//
// Sibling of eval-image-prompt-source.test.ts (e38b3095f), which closed six
// prompt-side sites of this bug and deliberately left this one open. The batch
// eval feeds the judge a DESCRIPTION rather than the full prompt by design:
// resolveEvalArtStyle depends on ORIGINAL_PROMPT carrying no ART STYLE block.
// When the built prompt went over the image model's character cap (measured on
// staging 2026-09-13, job_1789301291267_ueh8h145m: p1 7,939 chars and p4 v0
// 8,317 against grok-imagine-image-2.0's 7,900 cap), shrinkPromptForModel
// LLM-compresses the prompt's HEAD — the scene prose — and sends that. The
// shrink path now hands the compressed head back as `compressedScene`, and it
// is what the judge must score against.
//
// Assert the RULE, not any prompt wording.

const STORED = 'A rainy quay. The girl kneels beside the overturned rowing boat, reaching for the coiled mooring rope.';
const COMPRESSED = 'A rainy quay. The girl kneels by the boat.'; // what the model really got

describe('resolveEvalSceneDescription — the judge scores the description that was sent', () => {
  it('the shrinker fired: the compressed scene block wins', () => {
    expect(resolveEvalSceneDescription({ compressedScene: COMPRESSED, sceneDescription: STORED, prompt: 'P' }))
      .toBe(COMPRESSED);
  });

  it('no shrink: the value is exactly what this site resolved before', () => {
    // Today's expression was `img.sceneDescription || img.prompt || ''`.
    expect(resolveEvalSceneDescription({ sceneDescription: STORED, prompt: 'P' })).toBe(STORED);
    expect(resolveEvalSceneDescription({ compressedScene: null, sceneDescription: STORED })).toBe(STORED);
    expect(resolveEvalSceneDescription({ compressedScene: '   ', sceneDescription: STORED })).toBe(STORED);
    expect(resolveEvalSceneDescription({ sceneDescription: '', prompt: 'P' })).toBe('P');
    expect(resolveEvalSceneDescription({})).toBe('');
    expect(resolveEvalSceneDescription()).toBe('');
  });

  it('the resolved value never carries an ART STYLE block', () => {
    // The invariant the whole site exists for: resolveEvalArtStyle reads the
    // style from elsewhere and needs ORIGINAL_PROMPT free of it. The compressed
    // head is LLM-rewritten, so a compressor echoing a style heading must not
    // reach the judge — the page falls back to its stored description.
    const poisoned = `${COMPRESSED}\n\n**ART STYLE**: watercolour, soft edges.`;
    const resolved = resolveEvalSceneDescription({ compressedScene: poisoned, sceneDescription: STORED, prompt: 'P' });
    expect(resolved).toBe(STORED);
    expect(resolved).not.toMatch(/\*\*ART STYLE/i);
    // And for every clean combination too.
    for (const sources of [
      { compressedScene: COMPRESSED, sceneDescription: STORED },
      { sceneDescription: STORED },
      { prompt: COMPRESSED },
      {},
    ]) {
      expect(resolveEvalSceneDescription(sources)).not.toMatch(/\*\*ART STYLE/i);
    }
  });
});

describe('wiring: the compressed scene block is produced, carried and consumed', () => {
  const images = fs.readFileSync(new URL('../../server/lib/images.js', import.meta.url), 'utf8');
  const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');
  const repair = fs.readFileSync(new URL('../../server/lib/repairPipeline.js', import.meta.url), 'utf8');

  it('shrinkPromptForModel publishes its compressed HEAD, never the assembled prompt', () => {
    expect(images).toMatch(/shrinkPromptForModel\(prompt, maxPromptLength, logLabel, modelName = null, meta = null\)/);
    expect(images).toContain('if (meta) meta.compressedScene = newHead;');
    // The head is taken from strictly before the REQUIRED OBJECTS / ART STYLE
    // tail split — that split is WHY the block can never carry a style section.
    expect(images).toContain("const o = out.indexOf('**REQUIRED OBJECTS');");
    expect(images).toContain('let head = out.slice(0, tailStart);');
    // Not a second copy of the whole prompt (storage cost + IRON RULE hygiene).
    expect(images).not.toContain('meta.compressedScene = assembled');
  });

  it('both shrink call sites feed the out-param', () => {
    expect((images.match(/shrinkPromptForModel\([^)]*promptMeta\)/g) || []).length).toBe(2);
  });

  it('the batch eval resolves through the shared accessor, not an inline chain', () => {
    expect(images).toContain('resolveEvalSceneDescription({');
    // The regressed expression must not be rebuildable.
    expect(images).not.toMatch(/img\.sceneDescription \|\| img\.prompt/);
  });

  it('the field reaches the eval: generation → page record → eval inputs', () => {
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
