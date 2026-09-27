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
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
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
  if (/jsonb_array_elements\(data->'sceneImages'\) s WHERE/.test(sql)) return (STORY?.sceneImages || []).map((s: any) => ({ scene_text: JSON.stringify(s) }));
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

// ── empty_scene: the run's own plate code on the run's page data ──────────────
const plates = req('../../server/lib/platePipeline');
const { outlineEmptyScenePromptOf } = plates;

/** The fields of the run's pageData the plate functions read, as preparePageData sets them. */
function productionPlatePageData(scene: any, layout: any) {
  const coverOpts = req('../../server/lib/coverRender').coverRenderOptions(scene.pageNumber, { title: 'The Lantern', dedication: 'For M.', coverTitleMode: null });
  const { pageImageBackend } = PR.pageRenderModel({ sceneMetadata: scene.sceneMetadata, modelOverrides: {}, coverOpts, pageNumber: scene.pageNumber });
  return {
    pageNumber: scene.pageNumber, scene: { sceneDescription: scene.sceneDescription }, sceneMetadata: scene.sceneMetadata,
    sceneCharacters: scene.sceneCharacters, emptyScenePrompt: outlineEmptyScenePromptOf(scene), pageImageBackend, coverOpts,
    landmarkPhotos: [], renderAspect: layout.imageAspect || MODEL_DEFAULTS.pageAspect, textInImage: layout.textInImage !== false,
  };
}
const plateEnv = (pageDataArray: any[], layout: any, extra: any = {}) => ({
  visualBible: STORY.visualBible, inputData: { artStyle: 'watercolor', language: 'en', languageLevel: 'standard', layout }, pageDataArray,
  addUsage: () => {}, imageGenHeartbeat: () => {}, genLog: { info() {}, warn() {}, error() {}, debug() {} }, ...extra,
});
const plateCallsOf = (calls: any[]) => calls.map(c => ({ prompt: c.prompt, photos: c.photos, opts: c.opts }));

describe('empty_scene stage: no params = the run\'s plate for the stored page', () => {
  const qcCalls: any[] = [];
  const editCalls: any[] = [];
  let savedQc: any; let savedEdit: any;
  beforeEach(() => {
    qcCalls.length = 0; editCalls.length = 0;
    savedQc = images.validateEmptyScene; savedEdit = images.editImageWithPrompt;
    // A first attempt that fails with feedback: the run retries once with it.
    images.validateEmptyScene = async (img: string, textPosition: any, label: string, opts: any) => {
      qcCalls.push({ textPosition, label, opts });
      return { pass: false, issues: ['stub issue'], findings: [{ check: 'people', issue: 'stub issue' }], visionFeedback: 'a figure stands on the quay' };
    };
    images.editImageWithPrompt = async (...a: any[]) => { editCalls.push(a); return { imageData: PX, usage: { model: 'stub-edit' } }; };
  });
  afterEach(() => { images.validateEmptyScene = savedQc; images.editImageWithPrompt = savedEdit; });

  // A page off every vantage, on a text-in-image story. The stored page's
  // `textPosition` is the one text-region detection settled on after the
  // render; the plate was masked with the brief's own position, spread-rule
  // enforced — which the pre-fix Lab never used (getTextAreaMask(ctx.textPosition)).
  it('per-page plate: identical prompt, mask, grid, QC options and the fed-back retry', async () => {
    const layout = { mode: 'a4-overlay', imageAspect: '3:4', textInImage: true };
    const scene = storedScene({
      textPosition: 'bottom-right',
      sceneMetadata: { ...META, textPosition: 'top-left', emptyScenePrompt: 'An empty granite quay under a grey sky.', fullData: { ...META.fullData, shot: 'medium' } },
    });
    STORY = { ...storyFor(scene, layout), visualBible: { ...VISUAL_BIBLE, locations: [] } };
    const env = plateEnv([productionPlatePageData(scene, layout)], layout);
    const prod = await plates.renderPagePlate(productionPlatePageData(scene, layout), env);
    const prodGen = plateCallsOf(genCalls); const prodQc = qcCalls.splice(0);
    genCalls = [];
    const ctx = { ...ctxFor(scene, layout), visualBible: STORY.visualBible };
    const r = await testlab.runEmptySceneStage(ctx, { experimentId: 1, params: {} });
    expect(genCalls).toHaveLength(2);
    expect(plateCallsOf(genCalls)).toEqual(prodGen);
    expect(qcCalls).toEqual(prodQc);
    expect(genCalls[0].opts.textAreaMask).toBe(prod.textAreaMask);
    expect(genCalls[0].opts.textAreaMask).toBeTruthy();
    expect(genCalls[1].prompt).toContain('a figure stands on the quay');
    expect(r.promptUsed).toBe(prod.prompt);
    expect(r.plateSource).toBe('page');
    expect(r.qc.attempts).toHaveLength(2);
  });

  // Three pages share one vantage; the target is its aerial page. The run
  // paints the base canvas from the representative (eye-level) page and
  // DERIVES the aerial page's plate from it. The pre-fix Lab painted a fresh
  // plate from the aerial page's own text.
  it('vantage page: the canvas from the representative page, then the derive the run makes for this page', async () => {
    const layout = { mode: 'square-below', imageAspect: '1:1', textInImage: false };
    const vb = {
      ...VISUAL_BIBLE,
      locations: [{
        id: 'LOC001', name: 'the harbour wall', description: 'a low granite sea wall', appearsInPages: [2, 3, 4],
        vantages: [{ id: 'LOC001.1', name: 'quay view', pages: [2, 3, 4], shot: 'medium', description: 'Along the quay.', emptyScenePrompt: 'A granite quay running away from the viewer, moored boats on the right.' }],
      }],
    };
    const page = (pn: number, shot: string) => storedScene({
      pageNumber: pn, vantageId: 'LOC001.1',
      sceneMetadata: { ...META, objects: ['LOC001.1', 'ART001'], fullData: { ...META.fullData, shot } },
    });
    const scenes = [page(2, 'wide'), page(3, 'medium'), page(4, 'aerial')];
    STORY = { ...storyFor(scenes[2], layout), sceneImages: scenes, visualBible: vb };
    const pdas = scenes.map(s => productionPlatePageData(s, layout));
    const { groupPagesByVantage } = req('../../server/lib/storyHelpers');
    const group = groupPagesByVantage(pdas, vb).get('LOC001.1');
    expect(group.pageNumbers).toEqual([2, 3, 4]);
    const prodPlates = await plates.renderVantagePlates('LOC001.1', group, plateEnv(pdas, layout));
    const prodGen = plateCallsOf(genCalls); const prodQc = qcCalls.splice(0); const prodEdits = editCalls.splice(0);
    genCalls = [];
    const r = await testlab.runEmptySceneStage({ ...ctxFor(scenes[2], layout), visualBible: vb }, { experimentId: 1, params: {} });
    expect(plateCallsOf(genCalls)).toEqual(prodGen);
    expect(editCalls).toEqual(prodEdits);
    expect(qcCalls).toEqual(prodQc);
    expect(editCalls.length).toBeGreaterThan(0);
    const prodPage4 = prodPlates.get(4);
    expect(r.plateSource).toBe('vantage');
    expect(r.plateDerivedFor).toBe(prodPage4.plateDerivedFor);
    expect(r.promptUsed).toBe(prodPage4.prompt);
    // The canvas is painted from the representative page (the first eye-level page), not the target.
    expect(genCalls[0].opts.pageNumber).toBe(2);
  });

  it('a cast-0 page off every vantage gets no plate in the run, and the Lab says so', async () => {
    const layout = { mode: 'square-below', imageAspect: '1:1', textInImage: false };
    const scene = storedScene({ sceneCharacters: [], sceneMetadata: { ...META, characters: [], fullData: { ...META.fullData, characters: [] } } });
    STORY = { ...storyFor(scene, layout), visualBible: { ...VISUAL_BIBLE, locations: [] } };
    await expect(testlab.runEmptySceneStage({ ...ctxFor(scene, layout), visualBible: STORY.visualBible }, { experimentId: 1, params: {} }))
      .rejects.toThrow(/no plate/);
    expect(genCalls).toHaveLength(0);
  });
});

// ── quality_eval / semantic_eval / eval_variance: the run's batch eval call ───
const { buildEvalInput } = req('../../server/lib/repairPipeline');
const evalPipeline = req('../../server/lib/evalPipeline');
const sceneValidator = req('../../server/lib/sceneValidator');
const { buildWholeCastReferencePhotos } = req('../../server/lib/storyHelpers');

describe('eval stages: no params = the run\'s first-round page eval', () => {
  const layout = { mode: 'square-below', imageAspect: '1:1', textInImage: false };
  // A third character who is NOT on the page: the run's judge still gets her
  // reference (the whole cast); the pre-fix Lab never did.
  const CAST = [...CHARACTERS, { id: 'c3', name: 'Oma', age: 70, gender: 'woman', description: 'a grandmother', avatars: { standard: 'https://r2/oma.png' } }];
  const evalScene = () => storedScene({
    prompt: 'the prompt the model was sent, with its **REQUIRED OBJECTS** tail',
    // A beats page stores its PLAN line here; the render was made from the brief.
    outlineExtract: 'PLAN: Mira lights the way',
    description: 'PLAN: Mira lights the way',
  });
  const evalCtx = (scene: any) => ({ ...ctxFor(scene, layout), characters: CAST, language: 'de' });

  /** The run's rawImages record for the page (storyJobPipeline.js Phase 5a) and its first-round eval input. */
  function productionEvalInput(scene: any, ctx: any, imageData: string) {
    const rawRecord = {
      pageNumber: scene.pageNumber, imageData, prompt: scene.prompt, compressedScene: null,
      characterPhotos: ctx.referencePhotos, landmarkPhotos: ctx.landmarkPhotos, sceneDescription: scene.sceneDescription,
      text: scene.text, sceneCharacters: scene.sceneCharacters, sceneMetadata: scene.sceneMetadata,
      scene: { sceneDescription: scene.sceneDescription, outlineExtract: scene.outlineExtract },
      // Phase 5b-pre's detection on these bytes.
      sharedBboxDetection: scene.bboxDetection,
    };
    const wholeCast = buildWholeCastReferencePhotos(CAST, 'watercolor', STORY.clothingRequirements);
    return buildEvalInput({ imageData, pageNumber: scene.pageNumber }, rawRecord, wholeCast);
  }

  let batchCalls: any[] = [];
  let savedBatch: any; let savedSem: any;
  beforeEach(() => {
    batchCalls = [];
    savedBatch = images.evaluateImageBatch; savedSem = sceneValidator.evaluateSemanticFidelity;
    images.evaluateImageBatch = async (inputs: any[], options: any) => {
      batchCalls.push({ inputs, options });
      return inputs.map((i: any) => ({ pageNumber: i.pageNumber, evaluated: true, score: 80, qualityScore: 80, semanticScore: 70, figures: [], fixableIssues: [] }));
    };
  });
  afterEach(() => { images.evaluateImageBatch = savedBatch; sceneValidator.evaluateSemanticFidelity = savedSem; });

  it('quality_eval hands evaluateImageBatch the run\'s own input and story options', async () => {
    const scene = evalScene();
    STORY = { ...storyFor(scene, layout), characters: CAST };
    const ctx = evalCtx(scene);
    await testlab.runQualityEvalStage(ctx, { experimentId: 1, params: {} });
    expect(batchCalls).toHaveLength(1);
    const labInput = batchCalls[0].inputs[0];
    expect(labInput).toEqual(productionEvalInput(scene, ctx, PX));
    const opts = batchCalls[0].options;
    expect(opts.storyData.characters).toEqual(CAST);
    expect(opts.visualBible).toBe(VISUAL_BIBLE);
    expect(opts.language).toBe('de');
    expect(opts.evalOptionOverrides).toBeNull();
    // What the judge then receives, through the batch's own builder:
    const call = images.batchEvalQualityCall(labInput, opts);
    expect(call.evalOptions.pagePrompt).toBe(scene.prompt);                    // REQUIRED OBJECTS source
    expect(call.referenceImages.map((r: any) => r.name)).toContain('Oma');       // whole cast
    expect(labInput.sceneHint).toBe(scene.sceneDescription);                   // the brief, never the PLAN line
    expect(call.evalOptions.storyMeta.language).toBe('de');                    // the label language
    expect(call.evalOptions.storyMeta.recordStats).toBe(false);                // no stats rows from the Lab
  });

  it('quality_eval params ride as explicit overrides on top', async () => {
    const scene = evalScene();
    STORY = { ...storyFor(scene, layout), characters: CAST };
    await testlab.runQualityEvalStage(evalCtx(scene), { experimentId: 1, promptOverride: 'ALT', params: { model: 'judge-x', complianceModel: 'cm' } });
    const opts = batchCalls[0].options;
    expect(opts.qualityModelOverride).toBe('judge-x');
    expect(opts.evalOptionOverrides).toEqual({ evalTemplateOverride: 'ALT', complianceModelOverride: 'cm', complianceJudgeOverride: true });
    expect(images.batchEvalQualityCall(batchCalls[0].inputs[0], opts).evalOptions.complianceModelOverride).toBe('cm');
  });

  it('semantic_eval sends the semantic judge exactly what evaluateImageQuality sends it', async () => {
    const scene = evalScene();
    STORY = { ...storyFor(scene, layout), characters: CAST };
    const ctx = evalCtx(scene);
    const semCalls: any[] = [];
    sceneValidator.evaluateSemanticFidelity = async (...a: any[]) => { semCalls.push(a); return { score: 70, semanticIssues: [] }; };
    await testlab.runSemanticEvalStage(ctx, { experimentId: 1 });
    expect(semCalls).toHaveLength(1);
    // Production: evaluateImageQuality on the batch call → prepareEvalJudgeInputs → semanticFidelityOptions.
    const input = productionEvalInput(scene, ctx, PX);
    const call = images.batchEvalQualityCall(input, { visualBible: VISUAL_BIBLE, clothingRequirements: STORY.clothingRequirements, storyData: { characters: CAST }, artStyle: 'watercolor', storyId: 'job_parity', language: 'de', recordStats: false });
    const originalPrompt = evalPipeline.judgedSceneText(call.sceneDescription);
    const prep = evalPipeline.prepareEvalJudgeInputs({
      originalPrompt, referenceImages: call.referenceImages, evaluationType: call.evaluationType, pageContext: 'x',
      storyText: input.pageText, sceneHint: input.sceneHint, sceneCharacters: input.sceneCharacters, evalOptions: call.evalOptions,
      notEvaluated: req('../../server/lib/notEvaluated').createNotEvaluatedRecorder({ pageContext: 'x' }),
    });
    const [img, fidelityRef, prompt, hint, template, opts] = semCalls[0];
    expect(img).toBe(PX);
    expect(fidelityRef).toBe(prep.fidelityRef);
    expect(prompt).toBe(originalPrompt);
    expect(hint).toBe(scene.sceneDescription);
    expect(template).toBeNull();
    expect(opts).toEqual(evalPipeline.semanticFidelityOptions(prep, call.evalOptions));
    // The input the pre-fix stage never passed.
    expect(opts).toHaveProperty('textRules');
    // evaluateImageBatch passes no evalOptions.pageNumber (only storyMeta's), so
    // the run's semantic judge gets null here; the pre-fix Lab sent the page
    // number. Reported for a decision (BACKLOG), not changed here.
    expect(opts.pageNumber).toBeNull();
  });

  it('evaluateImageQuality hands the semantic judge the shared builders\' output (source scan)', () => {
    const src = read('server/lib/evalPipeline.js');
    expect(src).toContain('const judgeInputs = prepareEvalJudgeInputs({ originalPrompt, referenceImages, evaluationType, pageContext, storyText, sceneHint, sceneCharacters, evalOptions, notEvaluated });');
    expect(src).toContain('semanticFidelityOptions(judgeInputs, evalOptions)');
    const imgs = read('server/lib/images.js');
    expect(imgs).toContain('const evalCall = batchEvalQualityCall(img, options);');
    expect(read('server/lib/repairPipeline.js')).toContain('const buildEvalInputs = (imageEntries) => imageEntries.map(entry => buildEvalInput(');
  });
});

// ── consolidate / inpaint: the repair round's consolidator and inpaint calls ──
const feedbackConsolidator = req('../../server/lib/feedbackConsolidator');
const { consolidationInputs, buildInpaintCall } = req('../../server/lib/repairPipeline');
const { entityIssuesForPage } = req('../../server/lib/scoring');

describe('consolidate / inpaint: no params = the repair round\'s calls for the served version', () => {
  const layout = { mode: 'a4-overlay', imageAspect: '3:4', textInImage: true };
  const PLAN = { deduped_issues: [{ issue: 'stub', severity: 'major' }], scene_fix: { instruction: 'stub' } };
  // The page's served version record, as the run stores it.
  const V0 = {
    type: 'original', description: BRIEF, prompt: 'the sent prompt', sceneCharacters: [{ name: 'Mira' }, { name: 'Tobias' }], sceneMetadata: META,
    bboxDetection: STORED_DETECTION, fixableIssues: [{ description: 'the lantern is missing', severity: 'major', type: 'object_presence' }],
    semanticResult: { semanticIssues: [] }, threeStageResult: null, consolidatedPlan: PLAN, finalScore: 60, evalScore: 70,
    readerFindings: [{ fault: 'the text says she holds the lantern' }],
  };
  const consScene = () => storedScene({ prompt: 'the sent prompt', textPosition: 'bottom-left', imageVersions: [V0] });

  let consCalls: any[] = []; let inpaintCalls: any[] = [];
  let savedCons: any; let savedInpaint: any;
  beforeEach(() => {
    consCalls = []; inpaintCalls = [];
    savedCons = feedbackConsolidator.consolidateEvaluation; savedInpaint = images.inpaintPage;
    feedbackConsolidator.consolidateEvaluation = async (args: any) => { consCalls.push(args); return { plan: PLAN, dedupedIssues: PLAN.deduped_issues }; };
    images.inpaintPage = async (imageData: string, evaluation: any, options: any) => { inpaintCalls.push({ imageData, evaluation, options }); return { repaired: true, imageData: PX, instruction: 'stub' }; };
  });
  afterEach(() => { feedbackConsolidator.consolidateEvaluation = savedCons; images.inpaintPage = savedInpaint; });

  it('consolidate: the entity issues, worn clothing, reader findings and version brief the round passes', async () => {
    const scene = consScene();
    STORY = storyFor(scene, layout);
    await testlab.runConsolidateStage(ctxFor(scene, layout), { experimentId: 1, params: {} });
    expect(consCalls).toHaveLength(1);
    const lab = consCalls[0];
    // Production: consolidatePageEval → consolidationInputs on the version's eval.
    const prod = consolidationInputs({
      ev: lab.evalResult, entityIssues: entityIssuesForPage(3, STORY.finalChecksReport.entity).issues,
      orig: { sceneDescription: scene.sceneDescription, landmarkPhotos: [], sceneMetadata: scene.sceneMetadata },
      pageNumber: 3, round: 0, sceneDescriptionOverride: V0.description, readerFindings: V0.readerFindings,
      storyData: STORY, characters: STORY.characters, artStyle: STORY.artStyle, visualBible: VISUAL_BIBLE, storyId: 'job_parity',
    });
    const { promptOverride, modelOverride, ...labInputs } = lab;
    expect(labInputs).toEqual(prod);
    expect(lab.entityIssues.length).toBeGreaterThan(0);                  // pre-fix: []
    expect(lab.readerFindings).toEqual(V0.readerFindings);              // pre-fix: none
    expect(lab.sceneClothing).not.toBeUndefined();                      // pre-fix: none
    // The eval carries what evaluateImageQuality returns and the version does not store.
    expect(lab.evalResult.requiredTexts).toEqual([]);
    expect(typeof lab.evalResult.judgedPrompt).toBe('string');
    expect(lab.evalResult.fixableIssues).toEqual(V0.fixableIssues);
  });

  it('inpaint: the plan the version was scored with and the round\'s own call options', async () => {
    const scene = consScene();
    STORY = storyFor(scene, layout);
    await testlab.runInpaintStage(ctxFor(scene, layout), { experimentId: 1, params: {} });
    expect(consCalls).toHaveLength(0);                                   // the stored plan, not a re-consolidation
    expect(inpaintCalls).toHaveLength(1);
    const lab = inpaintCalls[0];
    const prod = buildInpaintCall({
      img: { pageNumber: 3, sceneDescription: scene.sceneDescription, landmarkPhotos: [], sceneMetadata: scene.sceneMetadata, sharedBboxDetection: STORED_DETECTION },
      latestEval: lab.evaluation, bestSoFar: null, roundNum: null, restampCoverAfter: false,
      storyData: { ...STORY, sceneImages: [{ pageNumber: 3, imageAspect: '3:4', textPosition: 'bottom-left' }] },
      characters: STORY.characters, artStyle: STORY.artStyle, jobId: 'job_parity',
    });
    expect(lab.options).toEqual(prod.options);
    expect(lab.options.consolidatedPlan).toBe(PLAN);
    expect(lab.options.textPosition).toBe('bottom-left');               // pre-fix: none
    expect(lab.options.characterClothing).toBeDefined();                // pre-fix: none
  });

  it('the repair round builds both calls with the shared builders (source scan)', () => {
    const src = read('server/lib/repairPipeline.js');
    expect(src).toMatch(/const res = await consolidateEvaluation\(consolidationInputs\(\{/);
    expect(src).toContain('const result = await images().inpaintPage(inputImage, inpaintEval, inpaintOptions);');
    expect(src).toMatch(/buildInpaintCall\(\{\s*\n\s*img, latestEval, bestSoFar, roundNum, restampCoverAfter/);
  });
});

// ── beats_replan: the run's Step 2 on the run's stored inputs ────────────────
const BP = req('../../server/lib/beatsPipeline');
const CCov = req('../../server/lib/castCoverage');
const textModelsMod = req('../../server/lib/textModels');

describe('beats_replan: no params = the run\'s plan check and re-plan rounds', () => {
  const ARC = 'Mira and Tobias cross the harbour at night to bring the lantern home.';
  const LOGIC = [
    'Want and stakes: Mira wants the lantern home before the tide.',
    'Facts:',
    '- Mira (commissioned)',
    '- Tobias (commissioned)',
    '- the ferryman (new)',
    'Central figure: Mira',
    'Chain:',
    '- Mira finds the lantern',
    '- the ferryman takes them across',
  ].join('\n');
  const REPLY = [
    '---CAST---',
    'Mira — deed page 2: lifts the lantern out of the net, alone — also on pages 1, 4',
    'Tobias — deed page 3: rows the little boat, with Mira — also on pages 1, 4',
    'Ending page 4: Mira and Tobias',
    '---PAGE PLAN---',
    'Page 1: wide — Mira, Tobias — the two reach the harbour wall — the night is set',
    'Page 2: medium — Mira — Mira lifts the lantern out of the net — she has it',
    'Page 3: medium — Tobias, Mira — Tobias rows the little boat — they leave the wall',
    'Page 4: wide — Mira, Tobias — the lantern is hung at home — the house is lit',
  ].join('\n');
  const STORED = () => ({
    ...storyFor(storedScene(), { textInImage: false }), pages: 4, languageLevel: 'standard',
    arcReviewReport: { finalArc: ARC, arcHints: '', logic: LOGIC, centralFigure: ['Mira'] },
    beatsReviewReport: { plannerReply: REPLY, briefsIn: [1, 2, 3, 4].map(n => ({ pageNumber: n, brief: 'PLAN: x' })) },
  });
  // The check names a fault on page 2, so the run re-plans; the re-plan hands
  // back the same division.
  const CHECK_REPLY = [
    '4. Page 2 gives Tobias no arrival',
    'ROSTER 1: people=Mira, Tobias',
    'ROSTER 2: people=Mira',
    'ROSTER 3: people=Tobias, Mira',
    'ROSTER 4: people=Mira, Tobias',
  ].join('\n');
  let modelCalls: any[] = [];
  let savedStream: any;
  beforeEach(() => {
    modelCalls = [];
    savedStream = textModelsMod.callTextModelStreaming;
    textModelsMod.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
      modelCalls.push({ prompt, model, label: opts?.usageLabel });
      const text = /replan/.test(opts?.usageLabel || '') && !/recheck/.test(opts?.usageLabel || '') ? REPLY : CHECK_REPLY;
      return { text, modelId: model, usage: { input_tokens: 1, output_tokens: 1 } };
    };
  });
  afterEach(() => { textModelsMod.callTextModelStreaming = savedStream; });

  it('sends the calls generateStoryViaBeats sends, with the CAST table and the arc\'s figures', async () => {
    STORY = STORED();
    // PRODUCTION: Step 2 as generateStoryViaBeats runs it, on the inputs it holds.
    const readPlan = BP.makePlanReader([1, 2, 3, 4], ARC);
    const plan = readPlan(REPLY).parsed;
    const castTable = CCov.parsePlanCastBlock(REPLY, { listed: CCov.commissionedCast(STORY).listed });
    const logic = PB.parseStoryLogic(`STORY LOGIC:\n${LOGIC}`);
    const inputs = BP.planCheckInputs(STORY, { arcPremiseNames: logic.commissioned, modelOverrides: {} });
    const gl = { info() {}, warn() {}, error() {}, debug() {} };
    const runCheck = BP.createPlanCheckRunner({
      inputData: STORY, approvedArc: ARC, arcHints: '', arcStoryLogic: LOGIC, arcCentralFigure: ['Mira'], castTable,
      commission: inputs.commission, commissionedNames: inputs.commissionedNames, placeNames: inputs.placeNames, maxCast: inputs.maxCast,
      arcInventedNames: logic.invented, arcInventedLimit: PB.arcInventedAllowance(STORY),
      mainName: PB.pickMainCharacters(STORY).focus?.name || null, planCheckModel: inputs.planCheckModel, onChunk: null, gl,
    });
    const check1 = await runCheck('plan_check', plan.pages, plan.pagePlan);
    expect(check1.lines.length).toBeGreaterThan(0);
    const rounds: any[] = [];
    await BP.runReplanRounds({
      inputData: STORY, pageCount: 4, plan, check1, replanRounds: rounds, approvedArc: ARC, arcHints: '', arcStoryLogic: LOGIC,
      arcCentralFigure: ['Mira'], castTable, commission: inputs.commission, commissionedNames: inputs.commissionedNames, maxCast: inputs.maxCast,
      planModel: MODEL_DEFAULTS.outline, readPlan, runCheck, onChunk: null, gl, stage: async () => {}, checkCancellation: async () => {},
      beats: plan.pages, pagePlan: plan.pagePlan,
    });
    const prodCalls = modelCalls.splice(0);
    expect(prodCalls.length).toBeGreaterThanOrEqual(3);                        // check, re-plan, recheck
    // THE LAB, no params.
    const r = await testlab.runBeatsReplanStage({ storyId: 'job_parity' }, { params: {} });
    expect(modelCalls.map(c => [c.label, c.model, c.prompt])).toEqual(prodCalls.map(c => [c.label, c.model, c.prompt]));
    expect(r.report.castTable).toEqual(castTable);                             // pre-fix: dropped
    expect(r.report.rounds.length).toBe(rounds.length);
    expect(modelCalls[0].prompt).toContain('lifts the lantern out of the net'); // the table reaches the check
  });

  it('the run builds Step 2 with the shared functions (source scan)', () => {
    const src = read('server/lib/beatsPipeline.js');
    expect(src).toContain('const readPlan = makePlanReader(expected, approvedArc);');
    expect(src).toMatch(/planCheckInputs\(inputData, \{ arcPremiseNames, modelOverrides \}\)/);
    expect(src).toMatch(/const runCheck = createPlanCheckRunner\(\{/);
    expect(src).toMatch(/\(\{ beats, pagePlan \} = await runReplanRounds\(\{/);
  });
});

// ── scene_review_replay: the run's scene review on the briefs as sent ────────
describe('scene_review_replay: no params = the run\'s review of the briefs it was sent', () => {
  const COVER_BRIEF = 'Mira and Tobias stand on the quay holding the lantern between them, facing the viewer.';
  const SENT = [{ pageNumber: 1, brief: BRIEF }, { pageNumber: -1, brief: COVER_BRIEF }];
  const STORED_REVIEW = () => ({
    ...storyFor(storedScene({ pageNumber: 1, sceneDescription: `${BRIEF}\n(the brief as it shipped, after the review)` }), { textInImage: false }),
    pages: 1,
    arcReviewReport: { centralFigure: ['Mira'] },
    beatsReviewReport: { pagePlan: 'Page 1: medium — Mira, Tobias — Mira holds the lantern up — the way is lit' },
    sceneReviewReport: { briefsIn: SENT },
  });
  let modelCalls: any[] = [];
  let savedStream: any;
  beforeEach(() => {
    modelCalls = [];
    savedStream = textModelsMod.callTextModelStreaming;
    textModelsMod.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
      modelCalls.push({ prompt, model, label: opts?.usageLabel });
      return { text: 'ANALYSIS:\nFAULTED PAGES: none\n', modelId: model, usage: { input_tokens: 1, output_tokens: 1 } };
    };
  });
  afterEach(() => { textModelsMod.callTextModelStreaming = savedStream; });

  it('reviews briefsIn (covers included) with the beats and cover beats the run held', async () => {
    STORY = STORED_REVIEW();
    const { buildCoverBeats } = req('../../server/lib/coverBeats');
    const { coverTypesFor } = req('../../server/lib/coverKeys');
    const beats = BP.makePlanReader([1], '')(STORY.beatsReviewReport.pagePlan).parsed.pages;
    const briefBeats = [...beats, ...buildCoverBeats(STORY, { coverTypes: coverTypesFor(STORY), clothingRequirements: STORY.clothingRequirements, centralFigure: ['Mira'] })];
    const gl = { info() {}, warn() {}, error() {}, debug() {} };
    await BP.runSceneReview({
      inputData: STORY, expansions: SENT.map(x => ({ ...x })), clothingRequirements: STORY.clothingRequirements,
      visualBible: JSON.parse(JSON.stringify(VISUAL_BIBLE)), briefBeats, beats, bibleSections: '', meta: { timings: {}, labelRound: null },
      sceneReviewModel: MODEL_DEFAULTS.sceneReviewModel || MODEL_DEFAULTS.outlineReviewModel, stage: async () => {}, onChunk: null, gl,
    });
    const prodCalls = modelCalls.splice(0);
    expect(prodCalls).toHaveLength(1);
    const r = await testlab.runSceneReviewReplayStage({ storyId: 'job_parity' }, { params: {} });
    expect(modelCalls.map(c => [c.label, c.model, c.prompt])).toEqual(prodCalls.map(c => [c.label, c.model, c.prompt]));
    expect(modelCalls[0].model).toBe(MODEL_DEFAULTS.sceneReviewModel || MODEL_DEFAULTS.outlineReviewModel);
    // The briefs as SENT, the cover among them — never the shipped ones.
    expect(modelCalls[0].prompt).toContain(COVER_BRIEF);
    expect(modelCalls[0].prompt).not.toContain('(the brief as it shipped, after the review)');
    expect(r.briefsIn.map((b: any) => b.pageNumber)).toEqual([1, -1]);
  });

  it('the run reviews through runSceneReview (source scan)', () => {
    expect(read('server/lib/beatsPipeline.js')).toMatch(/const reviewOut = await runSceneReview\(\{/);
  });
});

// ── arc_panel_replay: the run's panel and re-telling on the stored arc ───────
describe('arc_panel_replay: no params = the run\'s panel and re-telling calls', () => {
  const LOGIC = ['STORY LOGIC:', 'Want and stakes: Mila wants to return the egg before night.', 'Opposition: the cold.', 'Facts:',
    '- Mila (commissioned) — can carry the egg; cannot climb the wall', 'Central figure: the egg', 'Chain:',
    '- because the egg is cold, Mila carries it home', '- but the door is shut, so she warms it in her coat'].join('\n');
  const CREATE = [LOGIC, '', 'ARC:', '1. The child finds a lost egg.', '2. The child returns it.', 'CRITIQUE:', 'Logic:', '- none', 'Faults:',
    '1. [MAJOR] (s2) the ending is unearned — "The child returns it"'].join('\n');
  const RETELL = [LOGIC, 'Fixing: the unearned ending.', 'Keeping: the return.', 'Used: Panelist A', 'FINAL ARC:',
    '1. The child finds a lost egg.', '2. The child carries it back to its mother.', 'CRITIQUE:', '1. [MINOR] (s2) quiet — "carries it back"'].join('\n');
  const PANEL = '1. [MAJOR] (s1, s2) CAUSE: nothing says where the nest is — "The child returns it" Smallest change: name the nest.';
  const CREATE_PROMPT = ['# THE COMMISSION', 'x', '# CHALLENGE IDEAS (drawn at random)', 'old heading line', '', '- [C12] cross a river on stones (tests: balance)', '- [C40] find the way in fog (tests: patience)', '# NEXT', 'y'].join('\n');
  const LANDMARKS = [{ name: 'Kapellbrücke', type: 'bridge', wikipediaExtract: 'A covered wooden footbridge.' }];
  let modelCalls: any[] = []; let savedStream: any;
  beforeEach(() => {
    modelCalls = [];
    savedStream = textModelsMod.callTextModelStreaming;
    textModelsMod.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
      modelCalls.push({ prompt, model, temperature: opts?.temperature, effort: opts?.effort });
      const text = /retell/.test(opts?.usageLabel || '') ? RETELL : PANEL;
      return { text, modelId: model, usage: { input_tokens: 1, output_tokens: 5 }, truncation: null };
    };
  });
  afterEach(() => { textModelsMod.callTextModelStreaming = savedStream; });

  it('panel and re-telling prompts carry the run\'s landmarks and challenge draw; the re-telling is the run\'s creator call', async () => {
    const commit = PB.parseArcCreate(CREATE);
    STORY = {
      ...storyFor(storedScene(), { textInImage: false }), pages: 4,
      characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }],
      arcReviewReport: { committed: commit.committed, createPrompt: CREATE_PROMPT },
      replayInputs: { availableLandmarks: LANDMARKS, modelOverrides: null },
    };
    const r = await testlab.runArcPanelReplayStage({ storyId: 'job_parity' }, { params: { retell: true } });
    const inputData = { ...STORY, availableLandmarks: LANDMARKS, modelOverrides: {}, replayInputsStored: true };
    const panelPrompt = PB.buildArcPanelPrompt(inputData, commit.committed);
    const panelists = modelCalls.filter(c => c.prompt === panelPrompt);
    expect(panelists.length).toBe((MODEL_DEFAULTS.arcPanelModels || []).length);
    expect(panelPrompt).toContain('Kapellbrücke');                              // pre-fix: no landmark section
    for (const c of panelists) expect(c.temperature).toEqual(BP.arcTempFor(c.model, MODEL_DEFAULTS.arcPanelTemperature).temperature);
    const retellCall = modelCalls[modelCalls.length - 1];
    const { arcBlock, critique } = PB.splitCommittedBlock(commit.committed);
    const panel = r.runs.filter((x: any) => x.ok);
    const gate = PB.arcRepairFindings({ critique, reviewedArc: arcBlock, panel });
    const challengeIdeas = [...PB.CHALLENGE_IDEAS_HEADING, '', '- [C12] cross a river on stones (tests: balance)', '- [C40] find the way in fog (tests: patience)'].join('\n');
    expect(retellCall.prompt).toBe(PB.buildArcRetellPrompt(inputData, 4, arcBlock, gate.text, { challengeIdeas }));   // pre-fix: a fresh draw
    expect(retellCall.model).toBe(MODEL_DEFAULTS.arcRetellModel);
    expect(retellCall.effort).toBe(MODEL_DEFAULTS.arcRetellEffort);
    expect(r.retell.ok).toBe(true);
    expect(r.replayInputsStored).toBe(true);
  });

  it('the stored landmark list keeps every text field and no image bytes', () => {
    const { landmarksForReplay, resolveReplayInputData } = req('../../server/lib/beatsReplayInputs');
    const stored = landmarksForReplay([{ name: 'Kapellbrücke', photoData: `data:image/jpeg;base64,${'A'.repeat(3000)}`, photoVariants: [{ description: 'the bridge at dusk', photoData: 'B'.repeat(5000) }] }]);
    expect(stored).toEqual([{ name: 'Kapellbrücke', photoVariants: [{ description: 'the bridge at dusk' }] }]);
    expect(landmarksForReplay(undefined)).toBeNull();
    // A story stored before replayInputs replays with none, and says so.
    const old = resolveReplayInputData({ title: 't' });
    expect(old.availableLandmarks).toBeUndefined();
    expect(old.replayInputsStored).toBe(false);
  });

  it('the run makes its creator calls through makeArcCreatorCall (source scan)', () => {
    const src = read('server/lib/beatsPipeline.js');
    expect(src).toContain('const creatorCall = makeArcCreatorCall(onChunk);');
    expect(src).toContain('const tempFor = arcTempFor;');
    expect(read('storyJobPipeline.js')).toMatch(/replayInputs: \{\s*\n\s*availableLandmarks: require\('\.\/server\/lib\/beatsReplayInputs'\)\.landmarksForReplay\(inputData\.availableLandmarks\),/);
  });
});

// ── beats_scenes: the run's Art Director and scene review ────────────────────
describe('beats_scenes (stored plan lines): the run\'s Art Director and review calls', () => {
  const PLAN_1 = 'medium — Mira, Tobias — Mira holds the lantern up — the way is lit';
  const AD_REPLY = [
    '---VISUAL BIBLE---', '```json',
    JSON.stringify({ locations: [{ id: 'LOC001', name: 'the harbour wall', label: 'harbour wall', description: 'a low granite sea wall', appearsInPages: [1] }] }, null, 2),
    '```', '',
    '## Page 1', 'Mira stands on the harbour wall holding the lantern while Tobias crouches beside her.', '', '---METADATA---',
    JSON.stringify({ sceneIntent: 'Mira lights the way', characters: [{ name: 'Mira' }, { name: 'Tobias' }], objects: ['LOC001'], shot: 'medium' }), '',
    '## Page -1', 'Mira and Tobias stand on the quay facing the viewer.', '', '---METADATA---',
    JSON.stringify({ sceneIntent: 'the cover', characters: [{ name: 'Mira' }, { name: 'Tobias' }], objects: ['LOC001'], shot: 'medium' }), '',
  ].join('\n');
  let modelCalls: any[] = []; let savedStream: any;
  beforeEach(() => {
    modelCalls = [];
    savedStream = textModelsMod.callTextModelStreaming;
    textModelsMod.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
      modelCalls.push({ prompt, model, label: opts?.usageLabel });
      const text = /scene_expansion/.test(opts?.usageLabel || '') ? AD_REPLY : 'ANALYSIS:\nFAULTED PAGES: none\n';
      return { text, modelId: model, usage: { input_tokens: 1, output_tokens: 5 } };
    };
  });
  afterEach(() => { textModelsMod.callTextModelStreaming = savedStream; });

  it('briefs and reviews as the run does: the run\'s Art Director call, then the SCENE reviewer', async () => {
    STORY = {
      ...storyFor(storedScene({ pageNumber: 1, outlineExtract: `PLAN: ${PLAN_1}` }), { textInImage: false }), pages: 1,
      coverTypes: ['frontCover'], arcReviewReport: { finalArc: 'Mira lights the way home.', centralFigure: ['Mira'] },
    };
    const r = await testlab.runBeatsScenesStage({ storyId: 'job_parity' }, { params: { plainStoredBeats: true } });
    const labCalls = modelCalls.splice(0);
    // PRODUCTION, on the inputs generateStoryViaBeats holds at that point.
    const gl = { info() {}, warn() {}, error() {}, debug() {} };
    const inputData = { ...STORY, availableLandmarks: undefined, modelOverrides: {}, replayInputsStored: false, pageClothing: null };
    const ad = await BP.runArtDirector({
      inputData, modelOverrides: {}, clothingRequirements: STORY.clothingRequirements, visualBible: null, bibleSections: null,
      sceneModel: MODEL_DEFAULTS.sceneDescription, onChunk: null, gl, meta: { timings: {} }, stage: async () => {},
      beats: [{ pageNumber: 1, planLine: PLAN_1 }], arcCentralFigure: ['Mira'], approvedArc: 'Mira lights the way home.',
    });
    await BP.runSceneReview({
      inputData, expansions: ad.expansions.map((x: any) => ({ pageNumber: x.pageNumber, brief: x.brief })), clothingRequirements: STORY.clothingRequirements,
      visualBible: ad.visualBible, briefBeats: ad.briefBeats, beats: [{ pageNumber: 1, planLine: PLAN_1 }], bibleSections: ad.bibleSections,
      meta: { timings: {} }, sceneReviewModel: MODEL_DEFAULTS.sceneReviewModel, stage: async () => {}, onChunk: null, gl,
    });
    const prodCalls = modelCalls.splice(0);
    expect(labCalls.map(c => [c.label, c.model, c.prompt])).toEqual(prodCalls.map(c => [c.label, c.model, c.prompt]));
    const review = labCalls.find(c => c.label === 'beats_scene_review');
    expect(review.model).toBe(MODEL_DEFAULTS.sceneReviewModel);                 // pre-fix: the beats reviewer's model
    expect(r.sceneExpansions.map((x: any) => x.pageNumber)).toEqual([1, -1]);
  });

  it('the run briefs through runArtDirector (source scan)', () => {
    expect(read('server/lib/beatsPipeline.js')).toMatch(/const ad = await runArtDirector\(\{/);
  });
});

describe('the run still calls the shared builders (source scan)', () => {
  const pipeline = read('storyJobPipeline.js');
  const repair = read('server/lib/repairPipeline.js');
  const lab = read('server/lib/testlab.js');

  it('page render: selection, grid filter, model, prompt, plate mask and options come from pageRenderCall', () => {
    for (const fn of ['selectPageElementRefs', 'keepPageGridElements', 'pageRenderModel', 'makePageImagePrompt', 'pageRenderOptions']) {
      expect(pipeline, `storyJobPipeline.js must call ${fn}`).toContain(`.${fn}(`);
      expect(lab, `testlab.js must call ${fn}`).toContain(`.${fn}(`);
    }
    // The plate's copy-space mask, which the page render attaches, is built by
    // the run's per-page plate (platePipeline.js) and rebuilt by the Lab stage.
    expect(read('server/lib/platePipeline.js')).toContain('.pageTextAreaMask(');
    expect(lab).toContain('.pageTextAreaMask(');
    // No inline second copy of the model routing on the page path.
    expect(pipeline).not.toMatch(/pageImageModel = sceneComplexity === 'complex'/);
  });

  it('repair round: executeCharFixAction builds its call with buildCharFixCall and sends call.request unchanged', () => {
    expect(repair).toMatch(/buildCharFixCall\(\{/);
    expect(repair).toMatch(/repairCharacterMismatch\(currentImageData, call\.avatarPhoto, repairBbox, charName, call\.request\)/);
    expect(lab).toMatch(/require\('\.\/charFixCall'\)/);
  });
});
