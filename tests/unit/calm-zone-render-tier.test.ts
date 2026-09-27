import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// A calm-zone retry is a RE-RENDER of the page, so it renders on the page
// tier (MODEL_DEFAULTS.pageRenderImage). Before 2026-09-26 the production
// text-space re-render (storyJobPipeline.js) and POST-REPAIR-TEXT
// (repairPipeline.js) passed `img.sceneMetadata?.pageImageModel` — a field
// nothing writes — and the Lab text_zone stage passed no model at all, so all
// three resolved to generateImageOnly's default: MODEL_DEFAULTS.pageImage, the
// EDIT tier (Standard). ensureCalmZone now states the tier once and every
// caller forwards it.

// @ts-expect-error - JS module without types
import { ensureCalmZone } from '../../server/lib/textSpaceRepair.js';
// @ts-expect-error - JS module without types
import { MODEL_DEFAULTS } from '../../server/config/models.js';
// @ts-expect-error - JS module without types
import { loadPromptTemplates } from '../../server/services/prompts.js';
// @ts-expect-error - JS module without types
import { getTextAreaMask } from '../../server/lib/textMasks.js';

const ROOT = path.resolve(__dirname, '../..');

/** A page of pure noise: no calm pixel anywhere, so the gate must re-render. */
async function busyPage(): Promise<string> {
  const w = 256, h = 256;
  const raw = Buffer.alloc(w * h * 3);
  let x = 12345;
  for (let i = 0; i < raw.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; raw[i] = x & 0xff; }
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return png.toString('base64');
}

describe('calm-zone re-render tier', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('ensureCalmZone asks every retry for the page render tier', async () => {
    const calls: any[] = [];
    await ensureCalmZone({
      imageData: await busyPage(),
      text: 'word '.repeat(60).trim(),
      textPosition: 'top-left',
      pageNumber: 3,
      languageLevel: 'standard',
      textAreaMask: getTextAreaMask('top-left', 'standard'),
      sceneDescription: 'A child stands in a meadow.',
      generateImage: async (_prompt: string, opts: any) => { calls.push(opts); return null; },
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const opts of calls) {
      expect(opts.imageModelOverride).toBe(MODEL_DEFAULTS.pageRenderImage);
      // The edit/inpaint tier is a different key; a retry must never land on it by default.
      expect(MODEL_DEFAULTS.pageRenderImage).not.toBe(MODEL_DEFAULTS.pageImage);
    }
  });

  // Each caller builds its own generateImage closure around generateImageOnly;
  // the tier reaches the render only if the closure forwards it.
  const callers: Array<[string, string]> = [
    ['storyJobPipeline.js', "label: 'CALM-ZONE'"],
    ['server/lib/repairPipeline.js', "label: 'POST-REPAIR-TEXT'"],
    ['server/lib/testlab.js', "label: 'LAB TEXT-ZONE'"],
  ];
  for (const [file, anchor] of callers) {
    it(`${file} forwards the tier ensureCalmZone passes`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const at = src.indexOf(anchor);
      expect(at, `anchor ${anchor}`).toBeGreaterThan(-1);
      const closure = src.slice(at, at + 900);
      expect(closure).toMatch(/imageModelOverride: opts\.imageModelOverride,/);
      expect(closure).not.toMatch(/pageImageModel/);
    });
  }
});
