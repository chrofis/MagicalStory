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

// @ts-expect-error - JS module without types
import { fitGrokPromptWithPrefix, buildMagentaExtensionPrefix, GROK_MODELS } from '../../server/lib/grok.js';
// @ts-expect-error - JS module without types
import { IMAGE_MODELS } from '../../server/config/models.js';

const PREFIX = buildMagentaExtensionPrefix({ top: 0, bottom: 0, left: 100, right: 100 });
const CAP = IMAGE_MODELS['grok-imagine'].maxPromptLength;

// A prompt with no REQUIRED OBJECTS / ART STYLE tail markers takes the
// deterministic dedupe → truncate path inside shrinkPromptForModel: no LLM
// compression call, so this test makes no network request.
const body = (n: number) => 'Scene prose sentence number one. '.repeat(1000).slice(0, n);

describe('fitGrokPromptWithPrefix', () => {
  it('leaves a prompt that already fits untouched — prefix + body, no shrink', async () => {
    const short = body(500);
    const out = await fitGrokPromptWithPrefix(PREFIX, short, GROK_MODELS.STANDARD);
    expect(out).toBe(PREFIX + short);
  });

  it('fits a prompt that passes the caller budget but blows the cap with the prefix', async () => {
    // 7871 is the exact measured length that produced the 400.
    const measured = body(7871);
    expect(measured.length).toBeLessThanOrEqual(CAP);          // passed the caller's fit
    expect(measured.length + PREFIX.length).toBeGreaterThan(8000); // and blew Grok's cap

    const out = await fitGrokPromptWithPrefix(PREFIX, measured, GROK_MODELS.STANDARD);
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out.startsWith(PREFIX)).toBe(true);
    expect(out).toContain('SOLID BRIGHT MAGENTA');
    expect(out).toContain('NO visible padding boundary');
  });

  it('uses the budget of the tier the model id names, for every Grok tier', async () => {
    for (const modelId of [GROK_MODELS.STANDARD, GROK_MODELS.IMAGE_2, GROK_MODELS.PRO]) {
      const tier = Object.values(IMAGE_MODELS).find(
        (m: any) => m.backend === 'grok' && m.modelId === modelId) as any;
      const out = await fitGrokPromptWithPrefix(PREFIX, body(7871), modelId);
      expect(out.length, modelId).toBeLessThanOrEqual(tier.maxPromptLength);
      expect(out).toContain('SOLID BRIGHT MAGENTA');
    }
  });

  it('falls back to the default Grok budget for an unknown model id instead of throwing', async () => {
    const out = await fitGrokPromptWithPrefix(PREFIX, body(7871), 'no-such-grok-model');
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out).toContain('SOLID BRIGHT MAGENTA');
  });
});
