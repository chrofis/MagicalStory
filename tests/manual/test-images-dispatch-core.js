/**
 * Faithfulness unit test for `_dispatchImageGeneration` — the shared
 * provider-dispatch core extracted from `callGeminiAPIForImage` and
 * `generateImageOnly` (see docs/decisions.md "One shared provider-dispatch
 * core").
 *
 * images.js cannot be require()'d here (native `sharp`), so the REAL source of
 * `_dispatchImageGeneration` (+ the two pure helpers it calls) is sliced out of
 * the file and run in an isolated vm with every provider/collaborator stubbed to
 * RECORD its call args. Each scenario asserts the core dispatches to the SAME
 * provider fn with the SAME key args the pre-refactor inline ladder used —
 * the expected args are transcribed from the original inline code.
 *
 * Run: node tests/manual/test-images-dispatch-core.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');

function extractFunction(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  assert(start !== -1, `could not find function ${name} in images.js`);
  // Skip the parameter list first (default params like `opts = {}` contain
  // braces that must NOT be counted as the body brace) — paren-match from the
  // first '(' to its close, THEN find the body '{'.
  let p = src.indexOf('(', start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pdepth++;
    else if (src[p] === ')') { pdepth--; if (pdepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);   // body opening brace
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

let passed = 0;
function check(desc, cond) { assert(cond, `FAIL: ${desc}`); passed++; }

// ---------------------------------------------------------------------------
// Build a sandbox with recording stubs + a fresh `calls` ledger per scenario.
// ---------------------------------------------------------------------------
function makeCore() {
  const calls = { runware: [], grokEdit: [], grokGen: [], packRefs: [], extract: [] };

  const sandbox = {
    module: {},
    console: { log() {} },
    Buffer,
    Math,
    Array,
    process: { env: { GEMINI_API_KEY: 'test-key' } },
    log: { info() {}, debug() {}, warn() {}, error() {} },

    CONFIG_DEFAULTS: { imageBackend: 'grok', pageAspect: '3:4' },
    MODEL_DEFAULTS: { pageImage: 'gemini-2.5-flash-image', coverImage: 'gemini-3-pro-image-preview', pageAspect: '3:4', coverAspect: '4:3', avatarAspect: '9:16' },
    IMAGE_MODELS: {
      'grok-imagine': { maxPromptLength: 7500, backend: 'grok', modelId: 'grok-standard' },
      'grok-imagine-pro': { maxPromptLength: 7500, backend: 'grok', modelId: 'grok-pro' },
      'gemini-2.5-flash-image': { maxPromptLength: 30000, backend: 'gemini', temperature: 0.8 },
      'flux-dev': { maxPromptLength: 3000, backend: 'runware' },
    },
    RUNWARE_MODELS: { FLUX_SCHNELL: 'flux-schnell-id', FLUX_DEV: 'flux-dev-id' },
    // Mirrors the real registry-derived resolver in server/config/models.js.
    resolveGrokImageModel: (key) => {
      const cfg = key ? sandbox.IMAGE_MODELS[key] : null;
      return cfg?.backend === 'grok'
        ? { key, modelId: cfg.modelId, isExplicit: true }
        : { key: 'grok-imagine', modelId: 'grok-standard', isExplicit: false };
    },

    isRunwareConfigured: () => true,
    isGrokConfigured: () => true,

    generateWithRunware: async (prompt, opts) => { calls.runware.push({ prompt, opts }); return { imageData: 'RW', modelId: opts.model, usage: { t: 1 } }; },
    editWithGrok: async (prompt, refs, opts) => { calls.grokEdit.push({ prompt, refs, opts }); return { imageData: 'GK', modelId: opts.model, usage: { t: 2 } }; },
    generateWithGrok: async (prompt, opts) => { calls.grokGen.push({ prompt, opts }); return { imageData: 'GKGEN', modelId: opts.model, usage: { t: 3 } }; },
    packReferences: async (refs, opts) => { calls.packRefs.push({ refs, opts }); return ['REF1', 'REF2']; },

    cropImageForSequential: async (x) => x,
    compressImageToJPEG: async (x) => x,
    hashImageData: () => 'HASH',
    compressedRefCache: new Map(),
    r2Lib: { stripDataUriPrefix: (s) => s, bytesFromAnyImage: async () => Buffer.from('x') },
  };

  // Wrap extractDataImageUrls so we can observe it, but keep REAL behaviour.
  const realExtractSrc = extractFunction(SRC, 'extractDataImageUrls');
  const truncSrc = extractFunction(SRC, 'truncatePromptForModel');
  const coreSrc = extractFunction(SRC, '_dispatchImageGeneration');

  // The core now shrinks via `shrinkPromptForModel` (dedupe → LLM compression →
  // hard truncate). Only its budget CONTRACT matters to dispatch faithfulness,
  // so it is aliased to the deterministic truncate here — no model call.
  const shrinkAlias = 'const shrinkPromptForModel = async (p, max, label, model) => truncatePromptForModel(p, max, label, model);';

  const code = `${realExtractSrc}\n${truncSrc}\n${shrinkAlias}\n${coreSrc}\nmodule.exports = _dispatchImageGeneration;`;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { core: sandbox.module.exports, calls };
}

const BASE = {
  logLabel: 'IMAGE GEN',
  verbose: true,
  previousImage: null,
  imageModelOverride: null,
  imageBackendOverride: null,
  landmarkPhotos: [],
  visualBibleGrid: null,
  sceneBackground: null,
  textAreaMask: null,
  onImageReady: null,
  outputAspect: '3:4',
  evaluationType: 'scene',
  usePadExtension: false,
  avatarMode: false,
  pageLabel: '5',
  defaultModel: 'gemini-2.5-flash-image',
  includeSceneBackgroundPart: false,
};

(async () => {
  const PHOTOS = ['data:image/png;base64,AAA'];

  // ── Scenario A: Grok page gen (eval-path defaults, imageBackend=grok) ──────
  {
    const { core, calls } = makeCore();
    const raw = await core('a short prompt', PHOTOS, { ...BASE });
    check('A: provider is grok-primary', raw.provider === 'grok-primary');
    check('A: packReferences called once', calls.packRefs.length === 1);
    const pr = calls.packRefs[0];
    check('A: packRefs refs carry characterPhotos', pr.refs.characterPhotos === PHOTOS);
    check('A: packRefs refs.sceneBackground null', pr.refs.sceneBackground === null);
    check('A: packRefs opts.aspectRatio 3:4', pr.opts.aspectRatio === '3:4');
    check('A: packRefs opts.pageLabel "5"', pr.opts.pageLabel === '5');
    check('A: packRefs opts.padInputWithExtension false (eval path)', pr.opts.padInputWithExtension === false);
    check('A: editWithGrok called (refs non-empty)', calls.grokEdit.length === 1 && calls.grokGen.length === 0);
    const ge = calls.grokEdit[0];
    check('A: editWithGrok prompt untruncated (short)', ge.prompt === 'a short prompt');
    check('A: editWithGrok refs = packReferences output', JSON.stringify(ge.refs) === JSON.stringify(['REF1', 'REF2']));
    check('A: editWithGrok opts.model grok-standard', ge.opts.model === 'grok-standard');
    check('A: editWithGrok opts.aspectRatio 3:4', ge.opts.aspectRatio === '3:4');
    check('A: editWithGrok opts.padInputWithExtension false', ge.opts.padInputWithExtension === false);
    check('A: raw.packedRefs preserved', JSON.stringify(raw.packedRefs) === JSON.stringify(['REF1', 'REF2']));
    check('A: raw.promptSent = grokPrompt', raw.promptSent === 'a short prompt');
    check('A: no runware call', calls.runware.length === 0);
  }

  // ── Scenario A2: Grok prompt truncated to grok max (7500) ─────────────────
  {
    const { core, calls } = makeCore();
    const longPrompt = 'x'.repeat(9000);
    await core(longPrompt, PHOTOS, { ...BASE });
    const ge = calls.grokEdit[0];
    check('A2: grok prompt truncated to 7500', ge.prompt.length === 7500 && ge.prompt.endsWith('...'));
  }

  // ── Scenario B: Gemini page gen → sentinel with built parts ───────────────
  {
    const { core, calls } = makeCore();
    const raw = await core('gemini prompt', PHOTOS, { ...BASE, imageBackendOverride: 'gemini' });
    check('B: provider gemini (sentinel)', raw.provider === 'gemini');
    check('B: no grok/runware call (backend gemini, gemini model)', calls.grokEdit.length === 0 && calls.runware.length === 0);
    check('B: modelId resolved to defaultModel', raw.modelId === 'gemini-2.5-flash-image');
    check('B: parts[0] is the prompt', raw.parts[0].text === 'gemini prompt');
    const imgParts = raw.parts.filter(p => p.inline_data);
    check('B: 1 character image part', imgParts.length === 1);
    check('B: character label present', raw.parts.some(p => p.text === '[Character 1]:'));
    check('B: NO [Background] part (eval path)', !raw.parts.some(p => p.text === '[Background]:'));
    check('B: effectivePrompt present', raw.effectivePrompt === 'gemini prompt');
  }

  // ── Scenario C: Runware dev gen (model-routed flux-dev, steps 30) ──────────
  {
    const { core, calls } = makeCore();
    const raw = await core('dev prompt', PHOTOS, { ...BASE, imageBackendOverride: 'gemini', imageModelOverride: 'flux-dev' });
    check('C: provider runware-routed', raw.provider === 'runware-routed');
    check('C: generateWithRunware called once', calls.runware.length === 1);
    const rw = calls.runware[0];
    check('C: runware model = FLUX_DEV', rw.opts.model === 'flux-dev-id');
    check('C: runware steps = 30 (flux-dev)', rw.opts.steps === 30);
    check('C: runware width/height 1024', rw.opts.width === 1024 && rw.opts.height === 1024);
    check('C: runware referenceImages from extractDataImageUrls', JSON.stringify(rw.opts.referenceImages) === JSON.stringify(['data:image/png;base64,AAA']));
    check('C: runware prompt = effectivePrompt (raw here)', rw.prompt === 'dev prompt');
    check('C: raw.promptSent = effectivePrompt', raw.promptSent === 'dev prompt');
  }

  // ── Scenario C2: primary Runware (imageBackend=runware, steps 4) ──────────
  {
    const { core, calls } = makeCore();
    const raw = await core('cheap prompt', PHOTOS, { ...BASE, imageBackendOverride: 'runware' });
    check('C2: provider runware-primary', raw.provider === 'runware-primary');
    check('C2: runware model FLUX_SCHNELL', calls.runware[0].opts.model === 'flux-schnell-id');
    check('C2: runware steps 4', calls.runware[0].opts.steps === 4);
  }

  // ── Scenario D: Avatar gen (model-routed Grok, avatar-slice refs) ─────────
  {
    const { core, calls } = makeCore();
    const avatarPhotos = ['data:image/png;base64,FACE', 'data:image/png;base64,BODY', 'data:image/png;base64,STYLE', 'data:image/png;base64,EXTRA'];
    const raw = await core('avatar prompt', avatarPhotos, {
      ...BASE,
      imageBackendOverride: 'gemini',
      imageModelOverride: 'grok-imagine-pro',
      avatarMode: true,
      outputAspect: '9:16',
    });
    check('D: provider grok-routed', raw.provider === 'grok-routed');
    check('D: packReferences NOT called (avatar slice path)', calls.packRefs.length === 0);
    check('D: editWithGrok called once', calls.grokEdit.length === 1);
    const ge = calls.grokEdit[0];
    check('D: avatar refs = first 3 data URLs', JSON.stringify(ge.refs) === JSON.stringify(['data:image/png;base64,FACE', 'data:image/png;base64,BODY', 'data:image/png;base64,STYLE']));
    check('D: grok model = PRO (grok-imagine-pro)', ge.opts.model === 'grok-pro');
    check('D: aspect 9:16', ge.opts.aspectRatio === '9:16');
    check('D: pad false (eval path)', ge.opts.padInputWithExtension === false);
  }

  // ── Scenario E: Empty-scene w/ textAreaMask (gen-only primary Grok) ───────
  {
    const { core, calls } = makeCore();
    const raw = await core('empty scene', [], {
      logLabel: 'IMAGE GEN-ONLY',
      verbose: false,
      previousImage: null,
      imageModelOverride: null,
      imageBackendOverride: null, // → default grok
      landmarkPhotos: [],
      visualBibleGrid: null,
      sceneBackground: 'data:image/png;base64,BG',
      textAreaMask: 'MASKDATA',
      onImageReady: null,
      outputAspect: '3:4',
      evaluationType: null,
      usePadExtension: true,
      avatarMode: false,
      pageLabel: '',
      defaultModel: 'gemini-2.5-flash-image',
      includeSceneBackgroundPart: true,
    });
    check('E: provider grok-primary', raw.provider === 'grok-primary');
    check('E: packReferences called once', calls.packRefs.length === 1);
    const pr = calls.packRefs[0];
    check('E: packRefs refs.textAreaMask = MASKDATA', pr.refs.textAreaMask === 'MASKDATA');
    check('E: packRefs refs.sceneBackground = BG', pr.refs.sceneBackground === 'data:image/png;base64,BG');
    check('E: packRefs padInputWithExtension = true (scene plate)', pr.opts.padInputWithExtension === true);
    check('E: packRefs pageLabel = "" (gen-only)', pr.opts.pageLabel === '');
    const ge = calls.grokEdit[0];
    check('E: editWithGrok padInputWithExtension = true', ge.opts.padInputWithExtension === true);
    check('E: editWithGrok model STANDARD', ge.opts.model === 'grok-standard');
  }

  // ── Scenario F: gen-only Gemini fallback adds [Background] part ───────────
  {
    const { core, calls } = makeCore();
    const raw = await core('bg gemini', [], {
      logLabel: 'IMAGE GEN-ONLY', verbose: false,
      previousImage: null, imageModelOverride: null, imageBackendOverride: 'gemini',
      landmarkPhotos: [], visualBibleGrid: null,
      sceneBackground: 'data:image/png;base64,BG', textAreaMask: null, onImageReady: null,
      outputAspect: '3:4', evaluationType: null,
      usePadExtension: true, avatarMode: false, pageLabel: '',
      defaultModel: 'gemini-2.5-flash-image', includeSceneBackgroundPart: true,
    });
    check('F: provider gemini', raw.provider === 'gemini');
    check('F: [Background] part present (gen-only)', raw.parts.some(p => p.text === '[Background]:'));
  }

  console.log(`✅ ALL ${passed} assertions passed (_dispatchImageGeneration faithfulness)`);
})().catch((e) => { console.error(e); process.exit(1); });
