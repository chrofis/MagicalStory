/**
 * ONE LLM TRY PER RENDER, EVEN FOR NON-ASCII PROSE (owner rule 2026-09-30; code
 * review 2026-10-04 S3). The provider cap is UTF-8 bytes. The shorten used to
 * aim at a CHARACTER budget with a 20-char margin, so German/French prose came
 * back over the byte cap and shrinkPromptForModel tightened and shortened again:
 * a second LLM call and a second prompt_shrink event for one render.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FX = require('./fixtures/page-prompt-fit-job_1790529840433_ar4u7qry3.json');
const pageRender = require('../../server/lib/pageRenderCall.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const images = require('../../server/lib/images.js');
const shorten = require('../../server/lib/sceneShorten.js');
const { promptBytes, PromptFitError } = require('../../server/lib/promptFitError.js');

const CAP = 7900;
const ORIGINAL_TRY = shorten.shortenSceneOnce;
let calls = 0;
afterEach(() => { shorten.shortenSceneOnce = ORIGINAL_TRY; });

function buildGerman(sceneChars: number) {
  const page = FX.pages[0];
  const [prose, meta] = page.sceneDescription.split('---METADATA---');
  const extra = ' Der Nebel zieht über das Wasser und die Möwen rufen von der fernen Mauer.';
  let longer = prose.trim();
  while (longer.length < sceneChars) longer += extra;
  const sceneDescription = `${longer.slice(0, sceneChars)}.\n\n---METADATA---${meta}`;
  const inputData = { artStyle: FX.artStyle, language: FX.language, languageLevel: FX.languageLevel, layout: FX.layout };
  const tier = pageRender.pageRenderModel({ sceneMetadata: page.sceneMetadata, pageNumber: page.pageNumber });
  return String(pageRender.makePageImagePrompt({
    sceneDescription, inputData, sceneCharacters: page.sceneCharacters, visualBible: FX.visualBible,
    pageNumber: page.pageNumber, characterPhotos: page.referencePhotos, pageImageModel: tier.pageImageModel,
  })(page.vbRefElementIds));
}

beforeAll(async () => { await loadPromptTemplates(); });

describe('byte-aware scene shorten', () => {
  it('a non-ASCII over-cap page costs exactly one LLM call and fits the byte cap', async () => {
    const prompt = buildGerman(4707);
    expect(promptBytes(prompt)).toBeGreaterThan(CAP);
    calls = 0;
    // A faithful model: returns as many characters as it was allowed.
    shorten.shortenSceneOnce = async (prose: string, target: number) => { calls++; return prose.slice(0, target); };
    const out = await images.shrinkPromptForModel(prompt, CAP, 'TEST bytes', 'grok-test');
    expect(calls).toBe(1);
    expect(promptBytes(out)).toBeLessThanOrEqual(CAP);
  });

  it('a prompt cap that is missing is an error, not an unfitted prompt', async () => {
    await expect(images.shrinkPromptForModel('x'.repeat(100), undefined as any, 'TEST nocap')).rejects.toBeInstanceOf(PromptFitError);
  });
});
