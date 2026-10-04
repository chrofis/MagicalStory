/**
 * A PAGE THAT DOES NOT FIT IS SHORTENED, NEVER LEFT WITHOUT AN IMAGE (owner,
 * 2026-09-30: "They must be shortened. One try. If not cut enough mechanically
 * cut things till it fits.").
 *
 * Before this date a page whose scene + must-keep blocks overran Grok's 7,900
 * cap threw PromptFitError and rendered NO image: smoke job_1790529840433_ar4u7qry3
 * p1/p4, the dragon front cover, and the dragon p18 repair (rewritten scene
 * 4,707 + must-keep 3,911 = 8,618). Now the scene prose gets one LLM try, then a
 * sentence cut from its end. The labelled blocks — THIS IMAGE DEPICTS, HEIGHT
 * ORDER, AGE & PROPORTIONS, DISTINCTIVE FEATURES, card frames, WORN ITEMS — and
 * the protected tail are never touched.
 *
 * The fixture is the stored smoke page inputs, built by the production builder;
 * the scene is lengthened to the size the p18 repair rewrite reached.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/page-prompt-fit-job_1790529840433_ar4u7qry3.json');
const pageRender = require('../../server/lib/pageRenderCall.js');
const { IMAGE_MODELS } = require('../../server/config/models.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const images = require('../../server/lib/images.js');
const shorten = require('../../server/lib/sceneShorten.js');

const ORIGINAL_TRY = shorten.shortenSceneOnce;
let calls: Array<{ prose: string; target: number }> = [];
function llmReturns(fn: (prose: string, target: number) => string | null) {
  calls = [];
  shorten.shortenSceneOnce = async (prose: string, target: number) => { calls.push({ prose, target }); return fn(prose, target); };
}
afterEach(() => { shorten.shortenSceneOnce = ORIGINAL_TRY; });

/** Stored page 1, its scene prose lengthened to `sceneChars` (the p18 rewrite reached 4,707). */
function build(sceneChars: number) {
  const page = FX.pages[0];
  const [prose, meta] = page.sceneDescription.split('---METADATA---');
  const extra = ' The fog drifts over the water and the gulls call from the far wall.';
  let longer = prose.trim();
  while (longer.length < sceneChars) longer += extra;
  const sceneDescription = `${longer.slice(0, sceneChars)}.\n\n---METADATA---${meta}`;
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const tier = pageRender.pageRenderModel({ sceneMetadata: page.sceneMetadata, pageNumber: page.pageNumber });
  const prompt = String(pageRender.makePageImagePrompt({
    sceneDescription, inputData, sceneCharacters: page.sceneCharacters, visualBible: FX.visualBible,
    pageNumber: page.pageNumber, characterPhotos: page.referencePhotos, pageImageModel: tier.pageImageModel,
  })(page.vbRefElementIds));
  return { prompt, cap: IMAGE_MODELS[tier.pageImageModel].maxPromptLength, model: tier.pageImageModel };
}

/** Every labelled paragraph of the head and the whole protected tail, as the
 *  deterministic bullet merge (step 1, unchanged) leaves them. */
function fixedParts(built: string) {
  const prompt = images.dedupeIdenticalBullets(built);
  const tailStart = images.PROMPT_NEVER_CUT
    .filter((k: any) => k.marker).map((k: any) => prompt.indexOf(k.marker)).filter((i: number) => i >= 0)
    .reduce((a: number, b: number) => Math.min(a, b), Infinity);
  const droppable = /^(Generate a SINGLE|When the FIRST reference|\*\*HEIGHT ORDER|\*\*Composition|\*\*DEPTH AND SIZE|\*\*COUNTS)/;
  const head = prompt.slice(0, tailStart).split('\n\n')
    .filter((p: string) => p.trim() && shorten.isLabelledBlock(p) && !droppable.test(p));
  // The tail: every paragraph the ranked drops may not remove (the drops that
  // run before the scene is touched are the only ones allowed).
  const tail = prompt.slice(tailStart).split('\n\n').filter((p: string) => p.trim() && !droppable.test(p));
  return [...head, ...tail];
}

beforeAll(async () => { await loadPromptTemplates(); });

describe('a page whose scene overruns the cap is shortened, not left without an image', () => {
  it('the case: the stored page with a p18-sized scene does not fit on block drops alone', () => {
    const { prompt, cap } = build(4707);
    expect(images.promptFloor(prompt)).toBeGreaterThan(cap);
  });

  it('the LLM try gives nothing usable: the prose is cut at sentence ends until it fits', async () => {
    const { prompt, cap, model } = build(4707);
    llmReturns(() => null);
    const meta: any = {};
    const out: string = await images.shrinkPromptForModel(prompt, cap, 'TEST p18', model, meta);
    expect(calls).toHaveLength(1);                               // one try, never a second
    expect(out.length).toBeLessThanOrEqual(cap);
    for (const block of fixedParts(prompt)) expect(out).toContain(block);  // byte-exact
    expect(out).toContain('Daniel lunges');                      // the page's opening survives
    expect(meta.compressedScene).toBeTruthy();                   // the judges read the cut scene
    expect(out).toContain(meta.compressedScene);
  });

  it('the LLM shortens enough: its prose is sent and nothing is cut mechanically', async () => {
    const { prompt, cap, model } = build(4707);
    llmReturns((prose, target) => prose.slice(0, target - 50).replace(/\s+\S*$/, '') + ' SHORTENED_BY_LLM.');
    const out: string = await images.shrinkPromptForModel(prompt, cap, 'TEST p18', model);
    expect(calls).toHaveLength(1);
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).toContain('SHORTENED_BY_LLM.');
    for (const block of fixedParts(prompt)) expect(out).toContain(block);
  });

  it('the LLM shortens too little: the rest is cut from the end of its prose', async () => {
    const { prompt, cap, model } = build(4707);
    llmReturns((prose) => 'LLM_START ' + prose.slice(0, prose.length - 100));
    const out: string = await images.shrinkPromptForModel(prompt, cap, 'TEST p18', model);
    expect(calls).toHaveLength(1);
    expect(out.length).toBeLessThanOrEqual(cap);
    expect(out).toContain('LLM_START');
  });

  it('the LLM is asked for exactly the room the page has', async () => {
    const { prompt, cap, model } = build(4707);
    llmReturns(() => null);
    await images.shrinkPromptForModel(prompt, cap, 'TEST p18', model);
    const { prose, target } = calls[0];
    expect(target).toBeLessThan(prose.length);
    expect(images.promptFloor(prompt) - (prose.length - target)).toBeLessThanOrEqual(cap);
  });

  it('a page that fits on block drops alone never calls the LLM', async () => {
    // 900 chars of scene: the stored page's room once size is never cut
    // (2026-10-04) is ~1,150, so this page is over the cap as built and fits
    // on the ranked drops alone.
    const { prompt, cap, model } = build(900);
    expect(prompt.length).toBeGreaterThan(cap);
    expect(images.promptFloor(prompt)).toBeLessThanOrEqual(cap);
    llmReturns(() => { throw new Error('must not be called'); });
    const out: string = await images.shrinkPromptForModel(prompt, cap, 'TEST fits', model);
    expect(calls).toHaveLength(0);
    expect(out.length).toBeLessThanOrEqual(cap);
  });

  it('must-keep blocks alone over the cap: fails loudly, nothing labelled is cut', async () => {
    const { prompt, model } = build(1600);
    llmReturns(() => null);
    await expect(images.shrinkPromptForModel(prompt, 3000, 'TEST tiny cap', model))
      .rejects.toMatchObject({ name: 'PromptFitError' });
  });
});

describe('the pieces', () => {
  it('labelled blocks are recognised; scene prose is not', () => {
    for (const p of ['**WORN ITEMS ON THIS PAGE:**\n- x', 'AGE & PROPORTIONS (render each…', 'DISTINCTIVE FEATURES (on every page…',
      'REFERENCE CARD FRAMES (match each…', 'EXACT POSES:\n- a', '- bullet', 'Generate a SINGLE illustration', 'When the FIRST reference photo'])
      expect(shorten.isLabelledBlock(p), p).toBe(true);
    for (const p of ['On a foggy autumn morning along the quay, Daniel lunges.', 'From the perspective of the small rowboat…'])
      expect(shorten.isLabelledBlock(p), p).toBe(false);
  });

  it('cutAtSentence ends on a full sentence', () => {
    expect(shorten.cutAtSentence('One two. Three four. Five six.', 22)).toBe('One two. Three four.');
    expect(shorten.cutAtSentence('Short.', 50)).toBe('Short.');
  });
});
