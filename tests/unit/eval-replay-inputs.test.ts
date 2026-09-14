/**
 * EVAL REPLAY INPUTS — the Test Lab's eval stages must hand
 * evaluateImageQuality the option set PRODUCTION hands it.
 *
 * Every fixture below is the REAL stored shape, copied out of staging
 * `stories.data` for job_1789348171785_9oxos7dwv ("Vier Buben und ein
 * Drachenei", watercolor) page 13 — the page whose Art Director declared
 * CLO001 ("red zip-up hoodie", owner Levin) `off` and whose Lab evaluation in
 * experiment #1272 nonetheless filed MAJOR "Levin is missing his red zip-up
 * hoodie". wornItems live under sceneMetadata.fullData.wornItems, the visual
 * bible's garments under visualBible.clothing[], and clothingRequirements is
 * keyed name → category → {used, description}. Hand-built objects would have
 * missed the fullData nesting and passed against the broken code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  buildEvalReplayOptions,
  resolveEvalReplayType,
  MIRRORED_EVAL_OPTION_KEYS,
  NOT_MIRRORED_EVAL_OPTION_KEYS,
} = require('../../server/lib/evalReplayInputs');
const { buildEvalClothingContract } = require('../../server/lib/evalPipeline');

const ROOT = path.resolve(__dirname, '../..');
const testlabSrc = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
const imagesSrc = fs.readFileSync(path.join(ROOT, 'server/lib/images.js'), 'utf8');

// ── REAL STORED SHAPES (staging job_1789348171785_9oxos7dwv, page 13) ───────
const VISUAL_BIBLE = {
  mainCharacters: [
    { id: 'CHR_LEVIN', name: 'Levin' },
    { id: 'CHR_JULIAN', name: 'Julian' },
  ],
  secondaryCharacters: [{ id: 'CHR001', name: 'Frau Brunner' }],
  animals: [{ id: 'ANI002', name: 'Ofeli', description: 'a dragon hatchling the size of a large cat. rusty red and gold scales.' }],
  clothing: [{
    id: 'CLO001',
    name: 'red zip-up hoodie',
    label: 'red hoodie',
    pages: [8, 10],
    wornBy: 'Levin',
    howWorn: 'tied loosely by the sleeves into a knot',
    description: 'A red zip-up hoodie sweatshirt with long sleeves and a soft hood, made of thick cotton.',
    appearsInPages: [8, 10],
  }],
  vehicles: [{ id: 'VEH001', name: 'wooden handcart', label: 'market handcart', pages: [13, 15] }],
  artifacts: [],
  locations: [{ id: 'LOC002', name: 'the long stone bridge' }],
};

const CLOTHING_REQUIREMENTS = {
  Max: { summer: { used: false }, winter: { used: false }, costumed: { used: false }, standard: { used: true, description: 'A green crew-neck pullover sweater, orange corduroy trousers, and grey velcro-strap sneakers.' } },
  Kiaan: { summer: { used: false }, winter: { used: false }, costumed: { used: false }, standard: { used: true, description: 'A purple waterproof anorak jacket with a front zip, brown cotton straight-leg trousers, and dark brown leather ankle boots with rubber soles.' } },
  Levin: { summer: { used: false }, winter: { used: false }, costumed: { used: false }, standard: { used: true, description: 'A red zip-up hoodie sweatshirt worn over a white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.' } },
  Julian: { summer: { used: false }, winter: { used: false }, costumed: { used: false }, standard: { used: true, description: 'A yellow quilted vest over a white long-sleeve shirt, mid-blue denim dungaree trousers — square bib panel over the chest held by two shoulder straps — and white rubber-toe sneakers.' } },
};

const SCENE_METADATA = {
  era: 'present day',
  aboard: null,
  objects: ['LOC002', 'VEH001', 'CHR001', 'ANI001', 'ANI002'],
  setting: null,
  clothing: null,
  fullData: {
    shot: 'wide',
    objects: ['LOC002', 'VEH001', 'CHR001', 'ANI001', 'ANI002'],
    setting: null,
    wornItems: [{ id: 'CLO001', owner: 'Levin', state: 'off', location: 'lies somewhere off camera' }],
    background: null,
    characters: [
      { name: 'Julian', depth: 'foreground', looksAt: 'away', clothing: 'standard', position: 'center foreground' },
      { name: 'Levin', depth: 'foreground', looksAt: 'Frau Brunner', clothing: 'standard', position: 'center foreground' },
      { name: 'Max', depth: 'midground', looksAt: 'Frau Brunner', clothing: 'standard', position: 'right midground' },
      { name: 'Frau Brunner', depth: 'background', looksAt: 'away', clothing: 'standard', position: 'right background' },
    ],
    sceneIntent: 'Frau Brunner pushes her loaded handcart away down the bridge into the dark.',
    interactions: [],
    crowdExpected: false,
  },
  thinking: null,
};

/** A testlab loadSceneContext() result for that page. */
function makeCtx(over: any = {}) {
  return {
    storyId: 'job_1789348171785_9oxos7dwv',
    pageNumber: 13,
    scene: {
      pageNumber: 13,
      text: 'Julian weinte in Levins Pullover.',
      prompt: 'ART STYLE: watercolor storybook illustration\n\nFarther down the long stone bridge...',
      sceneDescription: 'Farther down the long stone bridge, Frau Brunner pushes her weathered wooden handcart away into the dark.',
      sceneMetadata: SCENE_METADATA,
      landmarkPhotos: [{ name: 'stone bridge', photoData: 'data:image/jpeg;base64,AAAA' }],
      // Stored shape: an array of NAME STRINGS, not objects. (Which is also why
      // the clothingRequirements branch of the contract builder is dead on this
      // path and the reference photos are what actually carry the outfit.)
      sceneCharacters: ['Levin', 'Julian', 'Max'],
      bboxDetection: { figures: [{ name: 'Levin', box: [1, 2, 3, 4] }, { name: 'Julian', box: [5, 6, 7, 8] }] },
      ...(over.scene || {}),
    },
    layout: {},
    visualBible: VISUAL_BIBLE,
    artStyle: 'watercolor',
    language: 'de',
    languageLevel: 'standard',
    title: 'Vier Buben und ein Drachenei',
    clothingRequirements: CLOTHING_REQUIREMENTS,
    characters: [{ name: 'Levin' }, { name: 'Julian' }, { name: 'Max' }, { name: 'Kiaan' }],
    referencePhotos: [],
    landmarkPhotos: [],
    outlineHint: 'Frau Brunner pushes her handcart away.',
    ...(() => { const { scene, ...rest } = over; return rest; })(),
  };
}

describe('buildEvalReplayOptions — the production option set', () => {
  it('carries every key production passes, from the stored context', () => {
    // Against the OLD code the `image` stage built five of these by hand and
    // three of them (visualBible, clothingRequirements, storyData) did not
    // exist at all; artStyle did not either.
    const { options } = buildEvalReplayOptions(makeCtx());
    for (const key of MIRRORED_EVAL_OPTION_KEYS) {
      expect(options, `missing mirrored key ${key}`).toHaveProperty(key);
    }
    expect(options.visualBible).toBe(VISUAL_BIBLE);
    expect(options.clothingRequirements).toBe(CLOTHING_REQUIREMENTS);
    expect(options.storyData.characters.map((c: any) => c.name)).toEqual(['Levin', 'Julian', 'Max', 'Kiaan']);
    expect(options.sceneMetadata).toBe(SCENE_METADATA);
    expect(options.pageNumber).toBe(13);
    expect(options.era).toBe('present day');
    expect(options.landmarkPhotos).toHaveLength(1);
  });

  it('resolves the art style from the story key, not from a scene description', () => {
    // The Lab hands the judge a scene DESCRIPTION, which carries no ART STYLE
    // block — so a site that omits this option leaves every style-dependent
    // evaluator rule unreachable. Must be the resolved DESCRIPTION, not 'watercolor'.
    const { options } = buildEvalReplayOptions(makeCtx());
    expect(typeof options.artStyle).toBe('string');
    expect(options.artStyle.length).toBeGreaterThan(10);
    expect(options.artStyle).not.toBe('watercolor');
  });

  it('an artStyleOverride A/B judges the style that was actually rendered', () => {
    const base = buildEvalReplayOptions(makeCtx()).options.artStyle;
    const swapped = buildEvalReplayOptions(makeCtx(), { artStyleKey: 'pixar' }).options.artStyle;
    expect(swapped).not.toBe(base);
  });

  it('withholds the figure count unless the caller vouches for the bytes', () => {
    expect(buildEvalReplayOptions(makeCtx()).options.detectedFigures).toBeNull();
    const figs = makeCtx().scene.bboxDetection.figures;
    expect(buildEvalReplayOptions(makeCtx(), { detectedFigures: figs }).options.detectedFigures).toBe(figs);
  });

  it('does NOT pass storyMeta — it is a stats sink, and Lab repeats would multiply-count one page', () => {
    const { options } = buildEvalReplayOptions(makeCtx());
    for (const key of NOT_MIRRORED_EVAL_OPTION_KEYS) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it('reports which keys an A/B displaced, and ignores undefined knobs', () => {
    const { options, overridden } = buildEvalReplayOptions(makeCtx(), {
      overrides: {
        evalTemplateOverride: 'ALTERNATE TEMPLATE',
        complianceModelOverride: null,
        compliancePromptOverride: undefined,
        artStyle: 'a deliberately different style string',
      },
    });
    expect(options.evalTemplateOverride).toBe('ALTERNATE TEMPLATE');
    expect(options.complianceModelOverride).toBeNull();
    expect(options).not.toHaveProperty('compliancePromptOverride');
    expect(overridden).toEqual(['artStyle']); // only a MIRRORED key counts as displaced
  });
});

describe('cover targets', () => {
  it('evaluates a negative page number as a cover, not a scene', () => {
    // Every Lab eval site hard-coded 'scene', so a cover target skipped the
    // cover fidelity reference, the gaze/flat-title exemptions and the text rules.
    expect(resolveEvalReplayType(13)).toBe('scene');
    expect(resolveEvalReplayType(-1)).toBe('cover');
    expect(resolveEvalReplayType(-2)).toBe('cover');
    expect(resolveEvalReplayType(-3)).toBe('cover');
    expect(buildEvalReplayOptions(makeCtx({ pageNumber: -1 })).evaluationType).toBe('cover');
  });

  it('passes the cover TEXT CONTRACT so a textless cover is not marked down for a missing title', () => {
    const { options, coverKey } = buildEvalReplayOptions(makeCtx({ pageNumber: -1 }));
    expect(coverKey).toBe('frontCover');
    expect(['painted', 'appOverlay']).toContain(options.textMode);
    // The contract is the shared resolver's, not a local guess.
    const { resolveCoverTextContract } = require('../../server/lib/coverTypography');
    expect(options).toMatchObject(resolveCoverTextContract('frontCover', {
      titleBaked: false, title: 'Vier Buben und ein Drachenei', dedication: null,
    }));
  });

  it('a baked front cover is judged on its painted title', () => {
    const { options } = buildEvalReplayOptions(makeCtx({ pageNumber: -1, scene: { titleBaked: true } }));
    expect(options.textMode).toBe('painted');
    expect(options.expectedText).toBe('Vier Buben und ein Drachenei');
  });

  it('a page target carries no cover text contract', () => {
    const { options, coverKey } = buildEvalReplayOptions(makeCtx());
    expect(coverKey).toBeNull();
    expect(options.textMode).toBeNull();
    expect(options.expectedText).toBeNull();
  });
});

describe('the defect this fixes — experiment #1272', () => {
  // The page's STORED referencePhotos, verbatim. Note Levin's still names the
  // hoodie: nothing ever persisted the generator's stripped copy, which is the
  // whole reason the eval side has to recompute the strip.
  const STORED_REF_PHOTOS = [
    { name: 'Levin', clothingDescription: 'A red zip-up hoodie sweatshirt worn over a white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.' },
    { name: 'Julian', clothingDescription: 'A yellow quilted vest over a white long-sleeve shirt, mid-blue denim dungaree trousers — square bib panel over the chest held by two shoulder straps — and white rubber-toe sneakers.' },
    { name: 'Max', clothingDescription: 'A green crew-neck pullover sweater, orange corduroy trousers, and grey velcro-strap sneakers.' },
  ];

  const contractFor = (opts: any) => buildEvalClothingContract({
    sceneCharacters: ['Levin', 'Julian', 'Max'],
    referenceImages: STORED_REF_PHOTOS,
    artStyle: 'watercolor storybook illustration',
    sceneHint: null,
    originalPrompt: '',
    ...opts,
  }).block;

  it('with the replayed options, the judge is NOT told Levin wears the hoodie the brief removed', () => {
    const { options } = buildEvalReplayOptions(makeCtx());
    const block = contractFor({
      visualBible: options.visualBible,
      clothingRequirements: options.clothingRequirements,
      sceneMetadata: options.sceneMetadata,
    });
    expect(block).toMatch(/- Levin: /);
    expect(block.toLowerCase()).not.toContain('hoodie');
    expect(block.toLowerCase()).toContain('white long-sleeve pullover');
    // The other two are untouched — only the OFF item's owner is restripped.
    expect(block).toContain('- Max: A green crew-neck pullover sweater');
  });

  it('with the OLD option set (no visualBible) the hoodie survives — the finding #1272 filed', () => {
    // resolveGeneratedOutfit returns the outfit UNCHANGED on a falsy bible
    // (wornItems.js:490). This is the exact input every Lab eval site built.
    const block = contractFor({
      visualBible: null,
      clothingRequirements: CLOTHING_REQUIREMENTS,
      sceneMetadata: SCENE_METADATA,
    });
    expect(block.toLowerCase()).toContain('red zip-up hoodie');
  });

  it('and without the sceneMetadata there is nothing to strip FROM either', () => {
    const block = contractFor({
      visualBible: VISUAL_BIBLE,
      clothingRequirements: CLOTHING_REQUIREMENTS,
      sceneMetadata: null,
    });
    expect(block.toLowerCase()).toContain('red zip-up hoodie');
  });

  it('with no reference outfits at all the contract is empty and clothing goes unjudged', () => {
    const block = contractFor({ referenceImages: [], visualBible: VISUAL_BIBLE, clothingRequirements: null, sceneMetadata: SCENE_METADATA });
    expect(block).toBe('');
  });
});

describe('wiring guards — no Lab eval site may hand-roll its options again', () => {
  const evalCalls = testlabSrc.split('evaluateImageQuality(').slice(1);

  it('every Lab evaluateImageQuality call passes a replay.options, not an object literal', () => {
    expect(evalCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of evalCalls) {
      const args = call.slice(0, call.indexOf('\n    );') >= 0 ? call.indexOf('\n    );') : 1800);
      expect(args).toMatch(/replay\.options/);
    }
  });

  it('no Lab eval site re-derives the art style, the era or the cover contract inline', () => {
    // These were each spelled by hand at three or more sites before.
    const evalRegion = testlabSrc.slice(0, testlabSrc.indexOf('const STAGE_RUNNERS'));
    const inlineArtStyle = (evalRegion.match(/resolveEvalArtStyle\(/g) || []).length;
    expect(inlineArtStyle).toBe(0);
  });

  it('no Lab eval site hard-codes the evaluation type', () => {
    for (const call of evalCalls) {
      const head = call.slice(0, 400);
      expect(head, `a Lab eval call still hard-codes 'scene': ${head.slice(0, 120)}`)
        .not.toMatch(/,\s*'scene',/);
    }
  });

  it('the Lab semantic stage passes the sixth argument production passes', () => {
    const idx = testlabSrc.indexOf('async function runSemanticEvalStage');
    expect(idx).toBeGreaterThan(0);
    const body = testlabSrc.slice(idx, idx + 3500);
    expect(body).toMatch(/evaluateSemanticFidelity\([\s\S]*?semanticOpts/);
    expect(body).toMatch(/buildEvalClothingContract/);
    expect(body).toMatch(/buildExpectedCastBlock/);
  });

  it('PRODUCTION still passes everything the replay mirrors — if it grows a key, this breaks', () => {
    // The production batch eval's evalOptions literal (images.js). This guard is
    // the whole point: a new production option must be added to the mirror, not
    // silently left out of it.
    const start = imagesSrc.indexOf('img.imageData,');
    expect(start, 'production batch eval call site moved — re-point this guard').toBeGreaterThan(0);
    expect(imagesSrc.slice(Math.max(0, start - 200), start)).toContain('await evaluateImageQuality(');
    const block = imagesSrc.slice(start, start + 4200);
    for (const key of MIRRORED_EVAL_OPTION_KEYS) {
      expect(block, `production no longer passes ${key} — the mirror is now wrong`)
        .toMatch(new RegExp(`\\b${key}\\b`));
    }
    for (const key of NOT_MIRRORED_EVAL_OPTION_KEYS) {
      expect(block).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });

  it('production builds its clothing contract through the shared builder', () => {
    const evalSrc = fs.readFileSync(path.join(ROOT, 'server/lib/evalPipeline.js'), 'utf8');
    expect(evalSrc).toMatch(/const contract = buildEvalClothingContract\(\{/);
    // Exactly one implementation of the worn-item strip on the eval side.
    expect((evalSrc.match(/stripOffItemsFromOutfit|resolveGeneratedOutfit\(outfit/g) || []).length)
      .toBeLessThanOrEqual(1);
  });
});
