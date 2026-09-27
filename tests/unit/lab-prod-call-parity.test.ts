/**
 * WITH NO PARAMS, THE TEST LAB SENDS WHAT PRODUCTION SENDS (owner, 2026-09-27:
 * "The Lab must use 100% identical code to production").
 *
 * Each stage below is run with the network and the DB stubbed, on a stored
 * page fixture, and the call it makes (model, prompt text, reference images,
 * options) is compared with the call production's own builders produce for the
 * same page. The production side is built from the SAME exported builders the
 * story run calls (pageRenderCall.js for the page render, charFixCall.js for
 * the repair round), and a source scan pins that the run still calls them — so
 * a divergence on either side fails here.
 *
 * Divergences this pins closed (all measured 2026-09-27 on the pre-fix code):
 *   image       — inputData without `layout` (COPY SPACE sent on text-below
 *                 stories), grid selection without objects[] / id fallback, the
 *                 route's reference mode never applied, a text mask on plateless
 *                 and vantage pages, `artStyle` passed as a render option.
 *   char_repair — own box ladder, buildClothingDescription instead of the
 *                 requirement signature + worn state, no wardrobe-state sheet,
 *                 a forced 'blended' mode and 'face' target, no borrowed-label /
 *                 reference-gap guard, no face-integrity gate, covers never
 *                 restamped.
 *
 * Pins behaviour and the mechanism, never prompt wording.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const req = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let BIG = PX; // a repaint result long enough to pass the run's size check; built in beforeAll

const images = req('../../server/lib/images');
const database = req('../../server/services/database');
const referenceSheets = req('../../server/lib/referenceSheets');
const entityConsistency = req('../../server/lib/entityConsistency');
const charRepairTarget = req('../../server/lib/charRepairTarget');
const faceIntegrityGate = req('../../server/lib/faceIntegrityGate');
const coverEvalLayer = req('../../server/lib/coverEvalLayer');
const imageCompositing = req('../../server/lib/imageCompositing');
const { loadPromptTemplates } = req('../../server/services/prompts');
const PB = req('../../server/lib/promptBuilders');
const PR = req('../../server/lib/pageRenderCall');
const { applyReferenceMode } = req('../../server/lib/clothingResolve');
const { decidePageRoute } = req('../../server/lib/imageRouter');
const { MODEL_DEFAULTS } = req('../../server/config/models');
const { buildCharFixCall } = req('../../server/lib/charFixCall');
const testlab = req('../../server/lib/testlab');

// ── stubs: network + DB only ────────────────────────────────────────────────
let genCalls: any[] = [];
let repairCalls: any[] = [];
let restampCalls: any[] = [];
let STORY: any = null;
images.generateImageOnly = async (prompt: string, photos: any[], opts: any) => {
  genCalls.push({ prompt, photos, opts });
  return { imageData: PX, modelId: `stub:${opts.imageModelOverride}`, prompt };
};
images.repairCharacterMismatch = async (imageData: string, avatar: string, bbox: any, name: string, opts: any) => {
  repairCalls.push({ imageData, avatar, bbox, name, opts });
  return { imageData: BIG, promptSent: 'stub repair prompt', blackoutImage: PX, grokRawResult: PX, method: 'stub' };
};
images.bboxPairsWith = () => true;
referenceSheets.buildVisualBibleGrid = async (els: any[]) => ({ rawElements: els, stubGrid: els.map(e => e.id).join(',') });
entityConsistency.getStyledAvatarForClothing = async (c: any, style: string, cat: string) => `styled:${c?.name}:${style}:${cat}`;
charRepairTarget.resolveFigureMask = async () => null;
faceIntegrityGate.checkFaceIntegrity = async () => ({ ok: true, available: true, reason: null });
imageCompositing.fetchFigureMaskPng = async () => null;
coverEvalLayer.resolveCoverEvalImage = async () => ({ imageData: PX, versionIndex: 0, layer: 'art' });
coverEvalLayer.restampRepairedCover = async (story: any, key: string, art: string, o: any) => {
  restampCalls.push({ key, art, o });
  return { servedImageData: `${art}#stamped`, artImageData: art };
};
database.getNextVersionIndex = async () => 7;
database.saveStoryImage = async () => {};
database.getActiveVersion = async () => 0;
database.getStoryImage = async () => ({ image_data: PX, image_url: null, version_index: 0 });
database.imgBytesAsync = async (row: any) => row.image_data || null;
database.dbQuery = async (sql: string) => {
  if (/FROM stories WHERE id/.test(sql)) return [{ data: STORY, user_id: 'u1' }];
  if (/image_type = 'empty_scene'/.test(sql)) return [{ image_data: PX, image_url: null }];
  return [];
};

beforeAll(async () => {
  await loadPromptTemplates();
  const sharp = req('sharp');
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
  BIG = `data:image/png;base64,${buf.toString('base64')}`;
});
beforeEach(() => { genCalls = []; repairCalls = []; restampCalls = []; });

// ── fixture: one stored page ────────────────────────────────────────────────
const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', description: 'a girl with a brown braid', avatars: { standard: 'https://r2/mira.png' } },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', description: 'a small boy with black curls', avatars: { standard: 'https://r2/tobias.png' } },
];
const VISUAL_BIBLE: any = {
  mainCharacters: CHARACTERS.map(c => ({ id: c.id, name: c.name })),
  secondaryCharacters: [], animals: [], vehicles: [], clothing: [],
  locations: [{ id: 'LOC001', name: 'the harbour wall', description: 'a low granite sea wall', appearsInPages: [3] }],
  artifacts: [
    // On this page by the bible's own page list.
    { id: 'ART001', name: 'brass lantern', description: 'a dented brass lantern', appearsInPages: [3], referenceImageUrl: 'https://r2/art001.png' },
    // Filed under another page, cited by the brief's objects[] — production
    // selects it, the pre-fix Lab never did.
    { id: 'ART002', name: 'coiled rope', description: 'a thick tarred rope', appearsInPages: [9], referenceImageUrl: 'https://r2/art002.png' },
  ],
};
const BRIEF = [
  'Mira stands on the harbour wall holding the brass lantern while Tobias crouches beside the coiled rope.',
  '',
  '---METADATA---',
  JSON.stringify({
    sceneIntent: 'Mira lights the way',
    shot: 'medium',
    characters: [{ name: 'Mira', position: 'centre' }, { name: 'Tobias', position: 'left' }],
    objects: ['ART001', 'ART002'],
    textPosition: 'top-left',
  }, null, 2),
].join('\n');
const META = req('../../server/lib/sceneMetadata').extractSceneMetadata(BRIEF);

const STORED_DETECTION = {
  sourceImageFp: 'fp1',
  figures: [
    { name: 'Mira', faceBox: [0.10, 0.40, 0.25, 0.55], bodyBox: [0.10, 0.35, 0.90, 0.60] },
    { name: 'Tobias', faceBox: [0.40, 0.05, 0.52, 0.18], bodyBox: [0.40, 0.02, 0.92, 0.25] },
  ],
  characterDescriptions: { Mira: { richDescription: 'girl, brown braid, freckles' } },
};

function storedScene(over: any = {}) {
  return {
    pageNumber: 3,
    sceneDescription: BRIEF,
    sceneMetadata: META,
    sceneCharacters: [{ name: 'Mira' }, { name: 'Tobias' }],
    sceneCharacterClothing: { Mira: 'standard', Tobias: 'standard' },
    text: 'Mira held the lantern high.',
    textPosition: 'top-left',
    vantageId: null,
    bboxDetection: STORED_DETECTION,
    // Not a story cell crop, so the route's 'loose' mode splits it into its
    // face/body variants — the reference transformation production applies.
    referencePhotos: [
      { name: 'Mira', photoUrl: PX, photoType: 'styled-standard', clothingDescription: 'a yellow raincoat', variantUrls: { face: 'https://r2/mira-face.png', body: 'https://r2/mira-body.png' } },
      { name: 'Tobias', photoUrl: PX, photoType: 'styled-standard', clothingDescription: 'a grey tunic', variantUrls: { face: 'https://r2/tob-face.png', body: 'https://r2/tob-body.png' } },
    ],
    ...over,
  };
}
function storyFor(scene: any, layout: any) {
  return {
    id: 'job_parity', title: 'The Lantern', dedication: 'For M.', artStyle: 'watercolor', language: 'en', languageLevel: 'standard',
    layout, characters: CHARACTERS, visualBible: VISUAL_BIBLE,
    clothingRequirements: {
      Mira: { standard: { used: true, signature: 'a mustard-yellow oilskin cape', description: 'a yellow raincoat' } },
      Tobias: { standard: { used: true, description: 'a grey knitted tunic' } },
    },
    sceneImages: [scene],
    // The run's repair round char-fixes a CRITICAL routable entity finding.
    finalChecksReport: { entity: { characters: { Mira: { issues: [{ type: 'face_mismatch', severity: 'critical', pageNumbers: [3, -1], description: 'stub' }] } } } },
  };
}
const ctxFor = (scene: any, layout: any) => ({
  storyId: 'job_parity', pageNumber: scene.pageNumber, scene, layout,
  visualBible: VISUAL_BIBLE, artStyle: 'watercolor', language: 'en', languageLevel: 'standard',
  title: 'The Lantern', dedication: 'For M.', characters: CHARACTERS, clothingRequirements: storyFor(scene, layout).clothingRequirements,
  referencePhotos: scene.referencePhotos.map((p: any) => ({ ...p })),
  landmarkPhotos: [], textPosition: scene.textPosition, target: {},
});

// ── the production page render, composed as storyJobPipeline.js composes it ──
async function productionPageCall(ctx: any, plate: string | null) {
  const pageNumber = ctx.pageNumber;
  const meta = ctx.scene.sceneMetadata;
  // The fields of the job's inputData the page prompt reads; the stored story
  // carries the job's values.
  const inputData = { artStyle: ctx.artStyle, language: ctx.language, languageLevel: ctx.languageLevel, layout: ctx.layout };
  const coverOpts = req('../../server/lib/coverRender').coverRenderOptions(pageNumber, { title: ctx.title, dedication: ctx.dedication });
  const pageData: any = { pageNumber, sceneMetadata: meta, sceneCharacters: ctx.scene.sceneCharacters };
  // preparePageData
  const refs = PR.selectPageElementRefs(ctx.visualBible, pageNumber, meta);
  const { pageImageModel, pageImageBackend } = PR.pageRenderModel({ sceneMetadata: meta, modelOverrides: {}, coverOpts, pageNumber });
  const makeImagePrompt = PR.makePageImagePrompt({
    sceneDescription: ctx.scene.sceneDescription, inputData, sceneCharacters: ctx.scene.sceneCharacters,
    visualBible: ctx.visualBible, pageNumber, characterPhotos: ctx.referencePhotos, pageImageModel, coverOpts,
  });
  const renderAspect = coverOpts ? coverOpts.aspectRatio : (ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect);
  const textInImage = coverOpts ? true : (ctx.layout?.textInImage !== false);
  // pageRoutes
  const route = decidePageRoute(pageData, {}, MODEL_DEFAULTS);
  const refMode = route.refMode || MODEL_DEFAULTS.referenceMode || 'strict';
  // Phase 5a-pre (per-page plate): the plate's mask
  const plateMask = plate ? PR.pageTextAreaMask({
    textInImage, rawTextPosition: coverOpts?.textPosition || meta?.textPosition || null, pageNumber, languageLevel: ctx.languageLevel,
  }) : null;
  // Phase 5a-pre-grid
  const hasPlate = !!applyReferenceMode({ mode: refMode, characterPhotos: [], visualBibleGrid: null, landmarkPhotos: [], sceneBackground: plate, sceneMetadata: meta }).sceneBackground;
  const kept = PR.keepPageGridElements(refs, { hasPlate, sceneMetadata: meta });
  const grid = kept.length > 0 ? await referenceSheets.buildVisualBibleGrid(kept, []) : null;
  const prompt = makeImagePrompt(kept.map((e: any) => e.id).filter(Boolean));
  // Phase 5a
  const refApplied = applyReferenceMode({
    mode: refMode, characterPhotos: ctx.referencePhotos, visualBibleGrid: grid, landmarkPhotos: ctx.landmarkPhotos,
    sceneBackground: plate, sceneMetadata: meta,
  });
  const options = PR.pageRenderOptions({
    page: pageData, renderAspect, pageImageModel, pageImageBackend, refApplied, textInImage, plateTextAreaMask: plateMask, coverOpts,
  });
  return { prompt, photos: refApplied.characterPhotos, options };
}

const labOptionsMinusMechanics = (o: any) => { const { skipCache, ...rest } = o; return rest; };

describe('image stage: no params = the production page render', () => {
  for (const [label, layout] of [
    ['text-below story', { mode: 'square-below', imageAspect: '1:1', textInImage: false }],
    ['text-in-image story', { mode: 'a4-overlay', imageAspect: '3:4', textInImage: true }],
  ] as const) {
    it(`${label}: identical model, prompt, references and options`, async () => {
      const scene = storedScene();
      const ctx = ctxFor(scene, layout);
      const prod = await productionPageCall(ctxFor(scene, layout), PX);
      const r = await testlab.runImageStage(ctx, { experimentId: 1, autoEval: false, params: {} });
      expect(genCalls).toHaveLength(1);
      const lab = genCalls[0];
      expect(lab.prompt).toBe(prod.prompt);
      expect(lab.photos).toEqual(prod.photos);
      expect(labOptionsMinusMechanics(lab.opts)).toEqual(prod.options);
      expect(lab.opts.skipCache).toBe(true);
      expect(r.promptUsed).toBe(prod.prompt);
    });
  }

  it('selects the element the brief cites by objects[] although the bible files it elsewhere', async () => {
    await testlab.runImageStage(ctxFor(storedScene(), { textInImage: false }), { experimentId: 1, autoEval: false, params: {} });
    expect(genCalls[0].opts.visualBibleGrid.rawElements.map((e: any) => e.id).sort()).toEqual(['ART001', 'ART002']);
  });

  it('applies the route reference mode to the stored references', async () => {
    await testlab.runImageStage(ctxFor(storedScene(), { textInImage: false }), { experimentId: 1, autoEval: false, params: {} });
    // cast 2 → 'loose' → each non-cell reference becomes its face and body variant
    expect(genCalls[0].photos.map((p: any) => p.photoVariant)).toEqual(['face', 'body', 'face', 'body']);
  });

  it('a text-below story gets no copy-space mask and the same prompt as production, not a text-in-image one', async () => {
    const scene = storedScene();
    await testlab.runImageStage(ctxFor(scene, { textInImage: false }), { experimentId: 1, autoEval: false, params: {} });
    const below = genCalls[0];
    genCalls = [];
    await testlab.runImageStage(ctxFor(scene, { textInImage: true }), { experimentId: 1, autoEval: false, params: {} });
    const overlay = genCalls[0];
    expect(below.opts.textAreaMask).toBeNull();
    expect(overlay.opts.textAreaMask).toBeTruthy();
    // The layout reaches the prompt: the two differ only by what textInImage adds.
    expect(below.prompt).not.toBe(overlay.prompt);
  });

  it('a vantage-plate page carries no mask (the run stores none for vantage plates)', async () => {
    await testlab.runImageStage(ctxFor(storedScene({ vantageId: 'LOC001.1' }), { textInImage: true }), { experimentId: 1, autoEval: false, params: {} });
    expect(genCalls[0].opts.textAreaMask).toBeNull();
  });

  it('params.imageModel is the one explicit model override', async () => {
    await testlab.runImageStage(ctxFor(storedScene(), { textInImage: false }), { experimentId: 1, autoEval: false, params: { imageModel: 'gemini-2.5-flash-image' } });
    expect(genCalls[0].opts.imageModelOverride).toBe('gemini-2.5-flash-image');
  });
});

describe('char_repair stage: no params = the production repair round', () => {
  const layout = { mode: 'square-below', imageAspect: '1:1', textInImage: false };

  it('sends the avatar, box and request the run\'s repair round builds for the stored page', async () => {
    const scene = storedScene();
    STORY = storyFor(scene, layout);
    const ctx = ctxFor(scene, layout);
    const prod = await buildCharFixCall({
      storyData: STORY, characters: STORY.characters, artStyle: STORY.artStyle, img: scene,
      decision: { charName: 'Mira', issueTypes: ['face_mismatch'] }, currentImageData: PX,
      bestEval: { bboxDetection: scene.bboxDetection, matches: undefined }, entityReport: STORY.finalChecksReport.entity, jobKey: STORY.id,
    });
    expect(prod.failure).toBeUndefined();
    const r = await testlab.runCharRepairStage(ctx, { experimentId: 1, params: { characterName: 'Mira' } });
    expect(repairCalls).toHaveLength(1);
    const lab = repairCalls[0];
    expect(lab.avatar).toBe(prod.avatarPhoto);
    expect(lab.bbox).toEqual(prod.repairBbox);
    const { addStep, ...labOpts } = lab.opts;
    expect(typeof addStep).toBe('function');
    // The request, and nothing else: no mode flag, no axis, no override.
    expect(labOpts).toEqual(prod.request);
    expect(r.imageType).toBe('scene');
  });

  it('the clothing text is the run\'s (requirement signature + page worn state), not buildClothingDescription', async () => {
    const scene = storedScene();
    STORY = storyFor(scene, layout);
    await testlab.runCharRepairStage(ctxFor(scene, layout), { experimentId: 1, params: { characterName: 'Mira' } });
    expect(repairCalls[0].opts.clothingDescription).toContain('mustard-yellow oilskin cape');
  });

  it('a refused repair is refused as the run refuses it (face-integrity gate)', async () => {
    const scene = storedScene();
    STORY = storyFor(scene, layout);
    const saved = faceIntegrityGate.checkFaceIntegrity;
    faceIntegrityGate.checkFaceIntegrity = async () => ({ ok: false, available: true, reason: 'stub unreadable' });
    try {
      await expect(testlab.runCharRepairStage(ctxFor(scene, layout), { experimentId: 1, params: { characterName: 'Mira' } }))
        .rejects.toThrow(/face_integrity/);
    } finally {
      faceIntegrityGate.checkFaceIntegrity = saved;
    }
  });

  it('a cover is repaired on its art and restamped before it is stored', async () => {
    const cover = storedScene({ pageNumber: -1 });
    STORY = { ...storyFor(storedScene(), layout), coverImages: { frontCover: cover } };
    const ctx = ctxFor(cover, layout);
    const r = await testlab.runCharRepairStage(ctx, { experimentId: 1, params: { characterName: 'Mira' } });
    expect(restampCalls).toHaveLength(1);
    expect(restampCalls[0].key).toBe('frontCover');
    expect(restampCalls[0].o.restamp).toBe(true);
    expect(r.imageType).toBe('frontCover');
  });
});

describe('edit_image on a plate: the derive call the run makes', () => {
  it('passes the plate model, the book style and the LAYOUT aspect (the run\'s layoutAspect), never null', async () => {
    const calls: any[] = [];
    const saved = images.editImageWithPrompt;
    const savedQc = images.validateEmptyScene;
    images.editImageWithPrompt = async (...a: any[]) => { calls.push(a); return { imageData: PX, usage: { model: 'stub' } }; };
    images.validateEmptyScene = async () => ({ pass: true, issues: [], findings: [] });
    try {
      const scene = storedScene();
      STORY = storyFor(scene, { imageAspect: '3:4', textInImage: false });
      await testlab.runEditImageStage(ctxFor(scene, { imageAspect: '3:4', textInImage: false }), { experimentId: 1, params: { source: 'empty_scene', instruction: 'lower the camera' } });
      expect(calls).toHaveLength(1);
      const [, , model, refs, artStyle, aspect, opts] = calls[0];
      expect(model).toBe(MODEL_DEFAULTS.emptyScenePlateModel);
      expect(refs).toEqual([]);
      expect(artStyle).toBe('watercolor');
      expect(aspect).toBe('3:4');
      expect(opts).toEqual({ plateDerive: true });
    } finally {
      images.editImageWithPrompt = saved;
      images.validateEmptyScene = savedQc;
    }
  });
});

describe('the run still calls the shared builders (source scan)', () => {
  const pipeline = read('storyJobPipeline.js');
  const repair = read('server/lib/repairPipeline.js');
  const lab = read('server/lib/testlab.js');

  it('page render: selection, grid filter, model, prompt, plate mask and options come from pageRenderCall', () => {
    for (const fn of ['selectPageElementRefs', 'keepPageGridElements', 'pageRenderModel', 'makePageImagePrompt', 'pageTextAreaMask', 'pageRenderOptions']) {
      expect(pipeline, `storyJobPipeline.js must call ${fn}`).toContain(`.${fn}(`);
      expect(lab, `testlab.js must call ${fn}`).toContain(`.${fn}(`);
    }
    // No inline second copy of the model routing on the page path.
    expect(pipeline).not.toMatch(/pageImageModel = sceneComplexity === 'complex'/);
  });

  it('repair round: executeCharFixAction builds its call with buildCharFixCall and sends call.request unchanged', () => {
    expect(repair).toMatch(/buildCharFixCall\(\{/);
    expect(repair).toMatch(/repairCharacterMismatch\(currentImageData, call\.avatarPhoto, repairBbox, charName, call\.request\)/);
    expect(lab).toMatch(/require\('\.\/charFixCall'\)/);
  });
});
