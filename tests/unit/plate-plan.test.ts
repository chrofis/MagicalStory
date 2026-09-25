/**
 * A page is derived from its vantage's base plate only for what that base lacks:
 * a camera move when its plate class differs from the class the base was
 * ACTUALLY painted in, a re-light when its light differs (owner, 2026-09-25).
 *
 * Staging job_1790277448294_5herh01j7: p10 (ultra-wide, alone on its vantage, so
 * the base was painted ultra-wide) and p14 (high-angle from a high-angle base)
 * each took a second, needless camera move, because the derive compared the
 * page's class with PLATE_BASE_CLASS only.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { plateEditForPage } = require_('../../server/lib/platePlan');

const dusk = { timeOfDay: 'dusk', weather: 'fog' };
const night = { timeOfDay: 'night', weather: 'fog' };

describe('plateEditForPage', () => {
  it('an ultra-wide page on an ultra-wide base shares it (job 5herh01j7 p10)', () => {
    const e = plateEditForPage({ pageShot: 'ultra-wide', baseShot: 'ultra-wide', pageLight: dusk, baseLight: dusk });
    expect(e).toMatchObject({ camera: false, relit: false });
  });

  it('a high-angle page on a high-angle base shares it (job 5herh01j7 p14)', () => {
    const e = plateEditForPage({ pageShot: 'high-angle', baseShot: 'high-angle', pageLight: night, baseLight: night });
    expect(e).toMatchObject({ camera: false, relit: false });
  });

  it('the same class in another light is re-lit only', () => {
    const e = plateEditForPage({ pageShot: 'high-angle', baseShot: 'high-angle', pageLight: night, baseLight: dusk });
    expect(e).toMatchObject({ camera: false, relit: true, key: 'high-angle|night|fog' });
  });

  it('an angled page on an eye-level base moves the camera', () => {
    const e = plateEditForPage({ pageShot: 'aerial', baseShot: 'medium', pageLight: dusk, baseLight: dusk });
    expect(e).toMatchObject({ camera: true, relit: false, key: 'aerial|' });
  });

  it('every eye-level shot shares an eye-level base', () => {
    for (const shot of ['close-up', 'medium', 'wide', 'over-the-shoulder']) {
      expect(plateEditForPage({ pageShot: shot, baseShot: 'medium' }).camera, shot).toBe(false);
    }
  });

  it('a page that declares no light keeps the base light', () => {
    expect(plateEditForPage({ pageShot: 'medium', baseShot: 'medium', pageLight: null, baseLight: night }).relit).toBe(false);
  });

  it('pages drawn on the same image get the same key; the base key is the base class with no light', () => {
    const a = plateEditForPage({ pageShot: 'close-up', baseShot: 'medium', pageLight: dusk, baseLight: dusk });
    const b = plateEditForPage({ pageShot: 'wide', baseShot: 'medium', pageLight: dusk, baseLight: dusk });
    expect(a.key).toBe(b.key);
    expect(a.key).toBe('eye-level|');
  });
});

describe('the vantage derive loop uses it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
  it('skips a page that needs neither a camera move nor a re-light', () => {
    expect(src).toContain('if ((!camera && !relit) || derivedPlates.has(key)) continue;');
    expect(src).toContain("plateEditForPage({ pageShot: shotOfPage(pn), baseShot: vantageShot, pageLight: lightOfPage(pn), baseLight })");
    expect(src).not.toContain('baseShotForDerive');
  });
  it('books the derive under the provider that ran it', () => {
    expect(src).not.toMatch(/addUsage\('gemini_image', r\.usage/);
    expect(src).toContain("addUsage(String(r.usage.model || '').startsWith('grok-imagine') ? 'grok' : 'gemini_image', r.usage");
  });
  it("editImageWithPrompt's Gemini path reports the Gemini model it called, not the Grok key it fell back from", () => {
    const images = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'images.js'), 'utf8');
    expect(images).toContain('usage: { inputTokens, outputTokens, thinkingTokens, model: geminiModelId } }');
    expect(images).toContain('return { imageData: null, usage: { inputTokens, outputTokens, model: geminiModelId } };');
  });
});
