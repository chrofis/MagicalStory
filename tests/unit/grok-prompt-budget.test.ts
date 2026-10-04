import { describe, it, expect } from 'vitest';

// The magenta-extension prefix must not push a Grok edit prompt over the API cap.
//
// `generateImageOnly` fits the prompt to IMAGE_MODELS[tier].maxPromptLength
// (7900, under Grok's hard 8000) — and THEN `editWithGrok` prepends the
// ~612-char magenta-extension instruction, with nothing re-checking the total.
// Measured on staging page 2 of job_1778929895710_ta7mtyd16 (Lab #963/#965):
// sentPrompts = 7871 chars, untruncated, +612 = 8483 →
// "Grok edit API error (400): Prompt length exceeds the maximum allowed length
// of 8000". Every prompt in the ~7289-7900 window failed the same way whenever
// slot 0 was magenta-padded.
//
// The fit now happens where the prefix length is knowable — after assembly, in
// grok.js — with the prefix held OUT of the shrink and reattached verbatim, so
// it cannot be compressed away (losing it bakes the magenta bars into the
// output).

// The body is a real page prompt (production builder), because that is the only
// body the magenta path carries (slot 0 is a scene plate under a page render).
// Since 2026-09-30 a body with no section markers is never blind-cut: the old
// truncate path chopped the END of the prompt, where ART STYLE lives.

import { beforeAll } from 'vitest';
import { createRequire } from 'module';
// @ts-expect-error - JS module without types
import { fitGrokPromptWithPrefix, buildMagentaExtensionPrefix, GROK_MODELS } from '../../server/lib/grok.js';
// @ts-expect-error - JS module without types
import { IMAGE_MODELS } from '../../server/config/models.js';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const { PromptFitError } = require('../../server/lib/promptFitError.js');

const PREFIX = buildMagentaExtensionPrefix({ top: 0, bottom: 0, left: 100, right: 100 });
const CAP = IMAGE_MODELS['grok-imagine'].maxPromptLength;

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown' }],
  mainCharacters: ['c1'], language: 'en', pages: 4, storyCategory: 'adventure',
  storyDetails: 'A night at the harbour.', artStyle: 'watercolor',
};
const emptyBible = { artifacts: [], locations: [], vehicles: [], characters: [] };
const brief = (prose: string) => `${prose}\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'the lamp is lit',
  characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
  shot: 'wide', objects: [], textPosition: 'bottom-left',
})}`;
const build = (prose: string) => String(PB.buildImagePrompt(brief(prose), inputData, null, emptyBible, 1, null, {}));

// A page prompt of exactly `n` chars: the scene prose is padded to reach it.
function pagePrompt(n: number): string {
  const seed = 'The main character kneels.';
  const pad = n - build(seed).length;
  const prose = 'The main character kneels beside the lantern. '.repeat(400).slice(0, seed.length + pad);
  const p = build(prose);
  expect(p.length).toBe(n);
  return p;
}

beforeAll(async () => { await loadPromptTemplates(); });

describe('fitGrokPromptWithPrefix', () => {
  it('leaves a prompt that already fits untouched — prefix + body, no shrink', async () => {
    const short = pagePrompt(6500);
    const out = await fitGrokPromptWithPrefix(PREFIX, short, GROK_MODELS.STANDARD);
    expect(out).toBe(PREFIX + short);
  });

  it('fits a prompt that passes the caller budget but blows the cap with the prefix', async () => {
    // 7871 is the exact measured length that produced the 400.
    const measured = pagePrompt(7871);
    expect(measured.length).toBeLessThanOrEqual(CAP);          // passed the caller's fit
    expect(measured.length + PREFIX.length).toBeGreaterThan(8000); // and blew Grok's cap

    const out = await fitGrokPromptWithPrefix(PREFIX, measured, GROK_MODELS.STANDARD);
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out.startsWith(PREFIX)).toBe(true);
    expect(out).toContain('SOLID BRIGHT MAGENTA');
    expect(out).toContain('NO visible padding boundary');
    expect(out).toContain('ART STYLE');                          // the end of the prompt survives
  });

  it('uses the budget of the tier the model id names, for every Grok tier', async () => {
    for (const modelId of [GROK_MODELS.STANDARD, GROK_MODELS.IMAGE_2, GROK_MODELS.PRO]) {
      const tier = Object.values(IMAGE_MODELS).find(
        (m: any) => m.backend === 'grok' && m.modelId === modelId) as any;
      const out = await fitGrokPromptWithPrefix(PREFIX, pagePrompt(7871), modelId);
      expect(out.length, modelId).toBeLessThanOrEqual(tier.maxPromptLength);
      expect(out).toContain('SOLID BRIGHT MAGENTA');
    }
  });

  it('falls back to the default Grok budget for an unknown model id instead of throwing', async () => {
    const out = await fitGrokPromptWithPrefix(PREFIX, pagePrompt(7871), 'no-such-grok-model');
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out).toContain('SOLID BRIGHT MAGENTA');
  });

  it('never blind-cuts a body without section markers — it throws PromptFitError', async () => {
    const markerless = 'Scene prose sentence number one. '.repeat(1000).slice(0, 7871);
    await expect(fitGrokPromptWithPrefix(PREFIX, markerless, GROK_MODELS.STANDARD))
      .rejects.toMatchObject({ name: PromptFitError.name, message: expect.stringContaining('refusing a blind cut') });
  });
});
