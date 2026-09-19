/**
 * A VERSION'S `prompt` IS ITS OWN RENDER'S, OR IT IS NOTHING.
 *
 * `buildVersionEntry` (repairPipeline.js) stored `v.prompt || img.prompt || null`
 * and the round-0 `original` version never set `prompt` at all, so EVERY version
 * of a page resolved to one page-level string. The result is not a missing field
 * — it is a wrong one, reported confidently.
 *
 * Measured on staging story job_1789759147125_p08djwhbl, coverImages.initialPage:
 *
 *   v0 source=original            compressedScene 4227 ch  sha c30302473a
 *   v1 source=iterate-round-1     compressedScene 1370 ch  sha 1b39d40f21
 *   v2 source=style-repair-grok   compressedScene 1370 ch  sha 1b39d40f21
 *   ALL THREE .prompt             7366 ch  sha e40958bb51   <- one shared string
 *   that string contains v0's compressedScene: YES / v1's: no / v2's: no
 *
 * `compressedScene` was already resolved per version (resolveVersionCompressedScene)
 * and was correct; `prompt` was not. The containment line is what made it
 * diagnosable at all: a version's sent prose is a slice of the string that render
 * was handed, so a prompt that contains v0's prose and not v1's cannot be v1's.
 * These tests pin that property, and the no-inheritance rule that restores it.
 *
 * Deliberately pins BEHAVIOUR and PLUMBING, never prompt wording: the resolvers
 * are pure and tested directly; the version-creation sites cannot be reached from
 * a unit test (runRepairPipeline needs a whole story), so they are pinned
 * structurally — the same split compressed-scene-lineage.test.ts uses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at load — stub the network boundary
// before requiring it (same pattern as compressed-scene-lineage.test.ts).
const grok = require_('../../server/lib/grok');
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
grok.generateWithGrok = async () => ({ imageData: 'data:image/jpeg;base64,AAAA', modelId: 'grok-imagine-image-2.0', usage: {} });
grok.editWithGrok = grok.generateWithGrok;

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { resolveOwnRenderPrompt, resolveVersionPrompt, resolveVersionCompressedScene } = require_('../../server/lib/repairLogic');
const { repairPageStyle } = require_('../../server/lib/styleRepair');
const { IMAGE_MODELS, resolveGrokImageModel } = require_('../../server/config/models');

const realCallTextModel = textModels.callTextModel;
afterEach(() => { textModels.callTextModel = realCallTextModel; images.clearImageCache?.(); });

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// The rule itself
// ─────────────────────────────────────────────────────────────────────────────

describe('a version record may claim only the prompt its own render was handed', () => {
  // The exact shape of the staging cover: three versions, three different
  // renders, one of which recorded no prompt of its own.
  const PAGE = { prompt: 'THE ORIGINAL 7366-CHAR SCENE PROMPT', compressedScene: 'the original head' };
  const V0 = { source: 'original', prompt: PAGE.prompt };
  const V1 = { source: 'iterate-round-1', description: 'the rewritten brief', prompt: 'THE REWRITE PROMPT sent to the model' };
  const V2 = { source: 'style-repair-grok', prompt: 'Repaint the people into this art style.' };
  const VMECH = { source: 'garment-recolour-round-1' }; // a pixel op — nothing was sent

  it('two versions rendered from different prompts each keep their own', () => {
    expect(resolveOwnRenderPrompt(V0)).toBe(PAGE.prompt);
    expect(resolveOwnRenderPrompt(V1)).toBe('THE REWRITE PROMPT sent to the model');
    expect(resolveOwnRenderPrompt(V2)).toBe('Repaint the people into this art style.');
    // The failure that shipped: three versions, one string.
    const claimed = [V0, V1, V2].map(resolveOwnRenderPrompt);
    expect(new Set(claimed).size).toBe(3);
  });

  it('a version whose prompt is unavailable is null and does NOT inherit', () => {
    expect(resolveOwnRenderPrompt(VMECH)).toBeNull();
    // Specifically: not the page's, and not a neighbour's.
    expect(resolveOwnRenderPrompt(VMECH)).not.toBe(PAGE.prompt);
    expect(resolveOwnRenderPrompt(VMECH)).not.toBe(resolveOwnRenderPrompt(V0));
  });

  it('there is no page argument to borrow from — by construction', () => {
    // A one-argument function cannot grow an `|| img.prompt`, which is exactly
    // the edit that caused this bug.
    expect(resolveOwnRenderPrompt.length).toBe(1);
  });

  it('an empty or whitespace prompt is "none recorded", never a value', () => {
    expect(resolveOwnRenderPrompt({ prompt: '' })).toBeNull();
    expect(resolveOwnRenderPrompt({ prompt: '   \n ' })).toBeNull();
    expect(resolveOwnRenderPrompt(null)).toBeNull();
    expect(resolveOwnRenderPrompt({})).toBeNull();
  });

  it('a version reporting a neighbour prompt is detectable by its own sent prose', () => {
    // THE DIAGNOSTIC FROM THE BUG REPORT, as an invariant: the prose a render
    // received is a slice of the string it was handed. So a version whose
    // compressedScene is absent from its claimed prompt is not that version's.
    const v0 = { source: 'original', prompt: 'HEAD-ZERO plus the rest of the build', compressedScene: 'HEAD-ZERO' };
    const v1 = { source: 'iterate-round-1', description: 'rewrite', prompt: 'HEAD-ONE plus the rewrite tail', compressedScene: 'HEAD-ONE' };
    for (const v of [v0, v1]) {
      const own = resolveOwnRenderPrompt(v);
      expect(own).not.toBeNull();
      expect(own!).toContain(resolveVersionCompressedScene(v, null)!);
    }
    // …and the pre-fix behaviour fails it: v1 carrying v0's prompt does not
    // contain v1's own prose.
    expect(v0.prompt).not.toContain(v1.compressedScene);
  });
});

describe('the page/cover ROOT names the version that shipped', () => {
  const PAGE = { prompt: 'the original page prompt' };

  it('the picked version’s own prompt wins', () => {
    expect(resolveVersionPrompt({ prompt: 'the iterate prompt' }, PAGE)).toBe('the iterate prompt');
  });

  it('an original-lineage winner that recorded none falls back to the page', () => {
    // Deliberate, and asymmetric with resolveVersionCompressedScene: the root
    // prompt is a MODEL input on the repair re-run path (repairPipeline
    // interpolates `${img.prompt}` into the string it sends), so a null there
    // would ship the literal "null" to an image model.
    expect(resolveVersionPrompt({ source: 'inpaint-round-1' }, PAGE)).toBe('the original page prompt');
    expect(resolveVersionPrompt(null, PAGE)).toBe('the original page prompt');
  });

  it('a page that never rendered has no root prompt', () => {
    expect(resolveVersionPrompt(null, {})).toBeNull();
    expect(resolveVersionPrompt({ prompt: '  ' }, { prompt: '' })).toBeNull();
  });

  it('root prompt and root compressedScene describe the SAME version', () => {
    // The incoherence measured on the staging cover: `.prompt` was the original
    // render's while `.compressedScene` had been moved to the latest.
    const picked = { source: 'iterate-round-1', description: 'rewrite', prompt: 'the rewrite prompt', compressedScene: 'the rewrite head' };
    const page = { prompt: 'the original prompt', compressedScene: 'the original head' };
    expect(resolveVersionPrompt(picked, page)).toBe('the rewrite prompt');
    expect(resolveVersionCompressedScene(picked, page)).toBe('the rewrite head');
    // Neither field is left describing the superseded render.
    expect(resolveVersionPrompt(picked, page)).not.toBe(page.prompt);
    expect(resolveVersionCompressedScene(picked, page)).not.toBe(page.compressedScene);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The containment property, at its source
// ─────────────────────────────────────────────────────────────────────────────

describe('a render’s recorded prose is a slice of the string that render was sent', () => {
  const CAP: number = IMAGE_MODELS[resolveGrokImageModel(null).key]?.maxPromptLength || 7900;

  const buildPrompt = (headChars: number) => {
    const sentences: string[] = [];
    for (let i = 0; sentences.join(' ').length < headChars; i++) {
      sentences.push(`Figure ${i} stands near landmark ${i} wearing garment number ${i} in colour ${i}.`);
    }
    return `${sentences.join(' ')}\n\n**REQUIRED OBJECTS**\n- a lantern\n\n**ART STYLE**\nwatercolour.`;
  };

  it('compressedScene is contained in the prompt actually sent', async () => {
    // No text model → the deterministic section-aware cut, which is the branch
    // that guarantees the containment the diagnosis relied on.
    textModels.callTextModel = async () => { throw new Error('offline'); };
    const meta: any = {};
    const sent = await images.shrinkPromptForModel(buildPrompt(CAP + 4000), CAP, 'TEST', null, meta);
    expect(typeof meta.compressedScene).toBe('string');
    expect(sent).toContain(meta.compressedScene);
    // Pair them as a version would store them: own prompt + own prose.
    const version = { source: 'iterate-round-1', description: 'rewrite', prompt: sent, compressedScene: meta.compressedScene };
    expect(resolveOwnRenderPrompt(version)!).toContain(resolveVersionCompressedScene(version, null)!);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// The upstream returns that make the per-version stamp possible
// ─────────────────────────────────────────────────────────────────────────────

describe('a repaint reports the prompt it sent', () => {
  it('repairPageStyle returns its own prompt, so the version need not borrow one', async () => {
    const img = (n: number) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
    const editFn = async () => ({ imageData: img(8), modelId: 'grok-imagine', usage: null });
    const stubMatch = async () => ({ sameStyle: true });
    const compareFn = async () => ({ better: 'after', changed: [] });
    const out = await repairPageStyle(img(4), img(2), { model: 'grok', editFn, compareFn, styleMatchFn: stubMatch });
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt.length).toBeGreaterThan(0);
  });

  it('a Lab prompt override is reported as what was sent, not the default it replaced', async () => {
    const img = (n: number) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
    const editFn = async () => ({ imageData: img(8), modelId: 'grok-imagine', usage: null });
    const stubMatch = async () => ({ sameStyle: true });
    const compareFn = async () => ({ better: 'after', changed: [] });
    const out = await repairPageStyle(img(4), img(2), {
      model: 'grok', editFn, compareFn, styleMatchFn: stubMatch,
      promptOverride: 'A DELIBERATELY DIFFERENT REPAINT WORDING',
    });
    expect(out.prompt).toBe('A DELIBERATELY DIFFERENT REPAINT WORDING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plumbing: every version-creation site stamps its own prompt
// ─────────────────────────────────────────────────────────────────────────────

describe('every render path stamps its own prompt at creation', () => {
  const repair = read('server/lib/repairPipeline.js');
  const imagesSrc = read('server/lib/images.js');
  const pipeline = read('storyJobPipeline.js');

  it('the stored version entry takes ONLY the version’s own prompt', () => {
    // THE BUG, as a source assertion. `resolveOwnRenderPrompt` takes no page
    // argument, so the fallback cannot be re-added without changing the call.
    expect(repair).toContain('prompt: resolveOwnRenderPrompt(v),');
    expect(repair).not.toContain('prompt: v.prompt || img.prompt');
  });

  it('the lineage root (v0 original) carries the page’s prompt as its OWN', () => {
    // Both branches: with and without a scale-repair pre-version.
    expect((repair.match(/prompt: img\.prompt \|\| null,/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('scale-repair, text-space, inpaint, char-fix and style-repair each stamp theirs', () => {
    expect(repair).toContain('prompt: img.scaleRepairPrompt || null,');
    expect(repair).toContain('prompt: c.prompt || (isOriginal ? (img.prompt || null) : null),');
    expect(repair).toContain('prompt: inpaintResult.promptSent || inpaintResult.instruction || null,');
    expect(repair).toContain('prompt: repairResult.promptSent || repairResult.debug?.prompt || null,');
    expect(repair).toContain('prompt: rep.prompt || null,');
    // The style-repair version used to hardcode null and let the builder
    // substitute the page prompt.
    expect(repair).not.toMatch(/source: `style-repair-\$\{styleRepairModel\}`[\s\S]{0,600}?\n\s+prompt: null,/);
  });

  it('the iterate round reads all THREE branches it dispatches to', () => {
    // iteratePage returns promptSent/imagePrompt; iterateCover and the plain
    // regen return `prompt`. Reading only `imagePrompt` nulled every cover
    // iterate, which then inherited the original cover prompt.
    expect(repair).toContain('prompt: result.promptSent || result.imagePrompt || result.prompt || null,');
  });

  it('the generators return the string they actually sent', () => {
    expect(imagesSrc).toContain('promptSent: fullInstruction,');
    expect(imagesSrc).toContain('promptSent: genResult.prompt || null,');
    expect(imagesSrc).toContain('promptSent: imageResult.promptSent || imageResult.prompt || null,');
  });

  it('the page ROOT promotes the picked version through the named resolver', () => {
    expect(repair).toContain('prompt: resolveVersionPrompt(best, img),');
    expect(repair).not.toContain('prompt: best?.prompt || img.prompt,');
  });

  it('the cover ROOT is mirrored the same way its compressedScene is', () => {
    // These two lines are the pair: one of them existed, the other did not, so
    // one cover record narrated two different renders.
    expect(pipeline).toContain('coverImages[coverKey].compressedScene = img.compressedScene ?? null;');
    expect(pipeline).toContain('coverImages[coverKey].prompt = img.prompt ?? coverImages[coverKey].prompt ?? null;');
  });

  it('a version prompt consumer that needs the page’s reads the PAGE record', () => {
    // buildEvalInputs already did this and must keep doing it — it is why a
    // null version prompt cannot starve a judge.
    expect(repair).toContain('prompt: entry.prompt || orig.prompt,');
    // The cover-regen "previous" capture must not let a null version prompt
    // short-circuit its cover-root fallback (`??` did).
    const regen = read('server/routes/regeneration.js');
    expect(regen).toContain("const previousPrompt = previousVersionEntry?.prompt || previousCover?.prompt || null;");
  });
});

describe('the cover path carries the same render identity the page path does', () => {
  const pipeline = read('storyJobPipeline.js');

  it('the cover push into the repair pipeline stamps modelId, like the page path', () => {
    // The page path has always carried `modelId: activeModelId`; the cover push
    // carried none, so a cover's v0 version recorded modelId undefined and could
    // not say which model painted it.
    expect(pipeline).toContain('modelId: activeModelId,');
    const push = pipeline.slice(pipeline.indexOf('rawImages.push({'));
    const block = push.slice(0, push.indexOf('evaluationType:'));
    expect(block).toContain('modelId: coverData.modelId || null,');
  });
});
