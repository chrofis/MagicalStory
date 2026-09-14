import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { buildStoryEvalOptions } = require('../../server/lib/evalReplayInputs.js');
const { parseHoldsId } = require('../../server/lib/coverHolds.js');
const { MODEL_DEFAULTS } = require('../../server/config/models.js');

// A REAL staging story's shape (job_1789348171785_9oxos7dwv, pulled 2026-09-14):
// a cover root record carries imageData / prompt / description / eval fields and
// NO titleBaked flag (app-side typography), and the title + dedication live at
// the story root — which is exactly why the endpoints' hand-built
// "TEXT REQUIREMENT - CRITICAL" line was wrong.
const stored = JSON.parse(fs.readFileSync(
  new URL('./fixtures/cover-eval-mirror-job_1789348171785_9oxos7dwv.json', import.meta.url),
  'utf8',
));

const storyData: any = {
  title: 'Die Reise der Tiere',
  dedication: 'Für Mia',
  artStyle: 'watercolor',
  characters: [{ name: 'Mia', age: 6 }],
  clothingRequirements: { Mia: { category: 'everyday' } },
  visualBible: { artifacts: [{ id: 'ART001', name: 'Laterne', description: 'a brass lantern' }] },
};
const coverRecord: any = { ...stored.coverRoot, description: 'A portrait before the lantern.' };

describe('stored-story eval options — the endpoints stop spelling their own', () => {
  it('a cover carries the bible, the wardrobe, the cast and the art style', () => {
    const { options, evaluationType, coverKey } = buildStoryEvalOptions(storyData, coverRecord, -1);
    expect(evaluationType).toBe('cover');
    expect(coverKey).toBe('frontCover');
    // Each of these was absent at all three endpoints; every one silently
    // disables a check (see evalReplayInputs.js header).
    expect(options.visualBible).toBe(storyData.visualBible);
    expect(options.clothingRequirements).toBe(storyData.clothingRequirements);
    expect(options.storyData.characters).toEqual(storyData.characters);
    expect(options.artStyle).toBeTruthy();
  });

  it('a TEXTLESS app-side cover is not asked to show its title', () => {
    const { options } = buildStoryEvalOptions(storyData, coverRecord, -1);
    if (MODEL_DEFAULTS.appSideCoverType) {
      // The regressed behaviour appended:
      //   TEXT REQUIREMENT - CRITICAL: The image MUST include this exact title
      // to a cover whose art is generated textless — a correct cover judged as
      // missing its title.
      expect(options.textMode).toBe('appOverlay');
      expect(options.expectedText).toBeNull();
    } else {
      expect(options.expectedText).toBe(storyData.title);
    }
  });

  it('a baked front cover IS letter-checked against the title', () => {
    const { options } = buildStoryEvalOptions(storyData, { ...coverRecord, titleBaked: true }, -1);
    expect(options.textMode).toBe('painted');
    expect(options.expectedText).toBe(storyData.title);
  });

  it('the dedication is read from the story root when the cover record has none', () => {
    const { options } = buildStoryEvalOptions(storyData, { ...coverRecord, titleBaked: true }, -2);
    expect(options.expectedText).toBe('Für Mia');
  });

  it('a page target gets scene type and no cover text contract', () => {
    const { options, evaluationType, coverKey } = buildStoryEvalOptions(storyData, stored.page, 3);
    expect(evaluationType).toBe('scene');
    expect(coverKey).toBeNull();
    expect(options.expectedText).toBeNull();
    expect(options.pageNumber).toBe(3);
  });
});

describe('holds ids — one vocabulary for every cover path', () => {
  it('a held garment resolves instead of leaking its raw VB id', () => {
    // coverComposite / compositeCastBuilder accepted ART|ANI|LOC|VEH, so a
    // `holds: CLO002` fell through to `holds ${holds}` and pasted the raw id
    // into the prompt — while the worn/held dedupe exists precisely for CLO.
    expect(parseHoldsId('CLO002')).toBe('CLO002');
    expect(parseHoldsId('ART001')).toBe('ART001');
    expect(parseHoldsId('ANI003')).toBe('ANI003');
    expect(parseHoldsId('VEH001')).toBe('VEH001');
  });

  it('a location is not a holdable thing', () => {
    expect(parseHoldsId('LOC004')).toBeNull();
  });

  it('prose, emptiness and "nothing" are all no id', () => {
    expect(parseHoldsId('a brass lantern')).toBeNull();
    expect(parseHoldsId('nothing')).toBeNull();
    expect(parseHoldsId('')).toBeNull();
    expect(parseHoldsId(null)).toBeNull();
  });

  it('WIRING GUARD: no cover module keeps a private holds regex', () => {
    for (const f of ['coverIterate.js', 'coverComposite.js', 'compositeCastBuilder.js']) {
      const src = fs.readFileSync(new URL(`../../server/lib/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/\(\?:ART\|ANI\|(?:VEH\|CLO|LOC\|VEH)\)\\d\+/);
      expect(src, f).toContain('parseHoldsId');
    }
  });
});

describe('wiring guard — the three regeneration cover eval endpoints', () => {
  const src = fs.readFileSync(new URL('../../server/routes/regeneration.js', import.meta.url), 'utf8');

  it('no endpoint hand-writes a cover TEXT REQUIREMENT any more', () => {
    // Only in prose now (the comment recording why it was removed), never in
    // a string the evaluator receives.
    expect(src).not.toMatch(/\+=\s*['`][^'`]*TEXT REQUIREMENT/);
    expect(src).not.toMatch(/evalPrompt\s*\+=/);
  });

  it('all three cover eval sites build their options from the shared resolver', () => {
    expect((src.match(/buildStoryEvalOptions\(storyData,/g) || []).length).toBe(3);
  });

  it('no cover active-version lookup passes a negative page number', () => {
    // getActiveVersion keys covers by 'frontCover' / 'initialPage' / 'backCover';
    // -1/-2/-3 matched no stored key and fell through to v0.
    // Both cover-capable endpoints (re-evaluate, eval-replay) resolve a cover
    // key first; the page-only sites keep the plain page number.
    expect((src.match(/getActiveVersion\(id,\s*versionKey\)/g) || []).length).toBeGreaterThanOrEqual(5);
    for (const m of src.matchAll(/getActiveVersion\(id,\s*pageNumber\)/g)) {
      const before = src.slice(Math.max(0, m.index! - 1500), m.index!);
      expect(before, 'a cover-capable site must key by cover type').not.toContain("evaluationType = 'cover'");
    }
  });

  it('the cover-edit endpoint no longer evaluates with four bare positionals', () => {
    expect(src).not.toMatch(/evaluateImageQuality\(editResult\.imageData,\s*coverPrompt,\s*\[\],\s*'cover'\)/);
  });
});
