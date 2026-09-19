/**
 * THE PROSE THE MODEL RECEIVED MUST REACH THE JUDGE — AND THE STORY.
 *
 * When a built image prompt is over the model's character cap,
 * `shrinkPromptForModel` (images.js) rewrites, dedupes or cuts its HEAD and
 * stamps what it actually sent as `compressedScene`.
 * `resolveEvalSceneDescription` (sceneMetadata.js) hands that string to the
 * judges instead of the pre-shrink brief, so a page is scored against the prose
 * the model really saw.
 *
 * It never arrived. On staging job_1789506283204_3kxqshifx — a story that ran
 * AFTER the stamping fix (c9b4eb9c2) shipped — `compressedScene` was null on all
 * 18 pages and all 30 versions, while nine pages carried the cut's fingerprint
 * and `prompt_compress` ran 38 times. The stamp was not lost in generation: the
 * repair pipeline's per-page OUTPUT whitelist (repairPipeline.js, the object
 * returned per page) carried `prompt` but had no `compressedScene` key at all,
 * so the field died between the render and `storyJobPipeline`'s
 * `compressedScene: img.compressedScene || null`, which then wrote null for
 * every page of every story that ran the repair pipeline.
 *
 * Structural assertions here pin the plumbing that cannot be invoked from a
 * unit test (runRepairPipeline needs a whole story); the lineage rule itself is
 * a pure function and is tested directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);

// images.js destructures grok's exports at load, so stub the network boundary
// before requiring it — same pattern as stored-prompt-is-sent-prompt.test.ts.
const grok = require_('../../server/lib/grok');
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
let sentToProvider: string | null = null;
grok.generateWithGrok = async (prompt: string) => {
  sentToProvider = prompt;
  return { imageData: 'data:image/jpeg;base64,AAAA', modelId: 'grok-imagine-image-2.0', usage: {} };
};
grok.editWithGrok = grok.generateWithGrok;

const images = require_('../../server/lib/images');
const textModels = require_('../../server/lib/textModels');
const { resolveVersionCompressedScene, inheritSceneContract } = require_('../../server/lib/repairLogic');
const { resolveEvalSceneDescription } = require_('../../server/lib/sceneMetadata');
const { IMAGE_MODELS, resolveGrokImageModel } = require_('../../server/config/models');

const CAP: number = IMAGE_MODELS[resolveGrokImageModel(null).key]?.maxPromptLength || 7900;

const realCallTextModel = textModels.callTextModel;
afterEach(() => { textModels.callTextModel = realCallTextModel; images.clearImageCache?.(); });
beforeEach(() => { sentToProvider = null; });

const buildPrompt = (headChars: number) => {
  const sentences: string[] = [];
  for (let i = 0; sentences.join(' ').length < headChars; i++) {
    sentences.push(`Figure ${i} stands near landmark ${i} wearing garment number ${i} in colour ${i}.`);
  }
  return `${sentences.join(' ')}\n\n**REQUIRED OBJECTS**\n- a lantern\n\n**ART STYLE**\nwatercolour.`;
};

/** The same head/tail split sectionAwareCut and sceneHeadOf use. */
const headOf = (prompt: string) => {
  const o = prompt.indexOf('**REQUIRED OBJECTS');
  const t = o >= 0 ? o : prompt.indexOf('**ART STYLE');
  return t > 0 ? prompt.slice(0, t).trim() : '';
};

describe('the shrinker records the exact head it sent', () => {
  it('over the cap: compressedScene equals the scene block of the string handed to the model', async () => {
    // No text model: the deterministic section-aware cut is the guarantee
    // branch, and it must record its result like the compression branch does.
    textModels.callTextModel = async () => { throw new Error('offline'); };
    const built = buildPrompt(CAP + 4000);
    expect(built.length).toBeGreaterThan(CAP);

    const meta: any = {};
    const sent = await images.shrinkPromptForModel(built, CAP, 'TEST', null, meta);

    expect(sent.length).toBeLessThanOrEqual(CAP);
    expect(sent).not.toBe(built);
    expect(typeof meta.compressedScene).toBe('string');
    // The equality that matters: what we recorded IS what we sent.
    expect(meta.compressedScene).toBe(headOf(sent));
    // …and it is the head ALONE, never a second copy of the whole prompt.
    expect(meta.compressedScene).not.toContain('**ART STYLE');
    // The judge reads it in preference to the stored (pre-shrink) brief.
    expect(resolveEvalSceneDescription({
      compressedScene: meta.compressedScene,
      sceneDescription: 'the PRE-shrink brief',
    })).toBe(meta.compressedScene);
  }, 30000);

  it('under the cap: the prompt is untouched and nothing is recorded', async () => {
    const built = buildPrompt(1000);
    expect(built.length).toBeLessThan(CAP);
    const meta: any = {};
    const sent = await images.shrinkPromptForModel(built, CAP, 'TEST', null, meta);
    expect(sent).toBe(built);
    expect(meta.compressedScene).toBeUndefined();
    // No fallback masking: a page that was never shrunk is judged against its
    // stored brief, exactly as before.
    expect(resolveEvalSceneDescription({
      compressedScene: meta.compressedScene ?? null,
      sceneDescription: 'the stored brief',
    })).toBe('the stored brief');
  }, 30000);
});

describe('a version is judged against the prose ITS OWN render received', () => {
  const PAGE = { compressedScene: 'the page head the model got', sceneDescription: 'the page brief' };

  it('an original-lineage version inherits the page it was rendered from', () => {
    expect(resolveVersionCompressedScene({ source: 'original' }, PAGE)).toBe(PAGE.compressedScene);
    expect(resolveVersionCompressedScene({ source: 'inpaint-round-1', description: null }, PAGE))
      .toBe(PAGE.compressedScene);
  });

  it('an iterate rewrite that was ITSELF compressed keeps its own prose', () => {
    const version = { description: 'the rewritten brief', compressedScene: 'the rewrite head the model got' };
    expect(resolveVersionCompressedScene(version, PAGE)).toBe('the rewrite head the model got');
  });

  it('an iterate rewrite that fit under the cap carries none — never the superseded page prose', () => {
    // This is the case a `||` chain gets wrong: the page's sent prose describes
    // a brief this image was never painted from.
    expect(resolveVersionCompressedScene({ description: 'the rewritten brief' }, PAGE)).toBeNull();
    expect(resolveVersionCompressedScene({ description: 'the rewritten brief', compressedScene: '   ' }, PAGE)).toBeNull();
  });

  it('a page that was never shrunk yields null, not an empty string', () => {
    expect(resolveVersionCompressedScene({ source: 'original' }, { sceneDescription: 'brief' })).toBeNull();
    expect(resolveVersionCompressedScene(null, null)).toBeNull();
  });
});

describe('lineage propagates from parent version to child repair', () => {
  it('a repair over an ITERATE inherits the iterate brief AND the iterate prose', () => {
    const parent = { source: 'iterate-round-1', description: 'rewrite brief', compressedScene: 'rewrite head' };
    const child: any = { source: 'inpaint-round-2' };
    inheritSceneContract(child, parent);
    expect(child.description).toBe('rewrite brief');
    expect(child.compressedScene).toBe('rewrite head');
  });

  it('a repair over an ORIGINAL inherits both as null and falls back to the page', () => {
    const parent = { source: 'original', description: null, compressedScene: null };
    const child: any = { source: 'char-fix-round-1' };
    inheritSceneContract(child, parent);
    expect(child.description).toBeNull();
    expect(child.compressedScene).toBeNull();
    expect(resolveVersionCompressedScene(child, { compressedScene: 'page head' })).toBe('page head');
  });

  it('a child that authored its OWN brief never inherits the parent prose', () => {
    const parent = { source: 'original', description: null, compressedScene: 'page head' };
    const child: any = { source: 'iterate-round-1', description: 'a new brief' };
    inheritSceneContract(child, parent);
    expect(child.description).toBe('a new brief');
    expect(child.compressedScene).toBeNull();
  });

  it('a child compressed at its own render keeps its own prose regardless', () => {
    const parent = { source: 'original', description: null, compressedScene: 'page head' };
    const child: any = { source: 'iterate-round-1', description: 'a new brief', compressedScene: 'its own head' };
    inheritSceneContract(child, parent);
    expect(child.compressedScene).toBe('its own head');
  });
});

describe('the field survives every hop between the render and stories.data', () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
  const repair = read('server/lib/repairPipeline.js');
  const imagesSrc = read('server/lib/images.js');
  const pipeline = read('storyJobPipeline.js');

  it('the iterate path carries its own sent prose out of images.js', () => {
    // iteratePageCore renders through generateImageOnly, which stamps it; the
    // result assembly dropped it, so an iterate version had none of its own.
    expect(imagesSrc).toContain('compressedScene: genResult.compressedScene || null');
    expect(imagesSrc).toContain('compressedScene: imageResult.compressedScene || null');
  });

  it('the repair pipeline seeds the lineage root on the original version', () => {
    // Without a value on the `source: 'original'` version, inheritSceneContract
    // has nothing to hand a repair layered on top of it.
    expect((repair.match(/compressedScene: img\.compressedScene \|\| null/g) || []).length)
      .toBeGreaterThanOrEqual(3);
  });

  it('the repair pipeline stamps it on the stored version entry', () => {
    expect(repair).toContain('compressedScene: resolveVersionCompressedScene(v, img)');
  });

  it("the repair pipeline's per-page OUTPUT carries it — the hop that was missing", () => {
    // THE BUG. This whitelist is the only path from a repaired page to
    // storyJobPipeline, and it had no such key.
    expect(repair).toContain('compressedScene: resolveVersionCompressedScene(best, img)');
  });

  it('the pipeline writes what the page carries, with no invented fallback', () => {
    expect(pipeline).toContain('compressedScene: img.compressedScene || null');
    expect(pipeline).toContain('compressedScene: genResult.compressedScene || null');
    // Never substitute the pre-shrink brief for the sent prose.
    expect(pipeline).not.toMatch(/compressedScene:[^\n]*sceneDescription/);
  });
});
