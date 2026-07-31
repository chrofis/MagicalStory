/**
 * Deterministic unit tests for the styled-avatar MUST guarantee.
 *
 * Part 1 — resolveGuaranteedReference (server/lib/avatarGuarantee.js): pure
 * chain resolver used by ensureStyledAvatarCoverage. Stubbed steps model the
 * real chain: engine A (configured backend) fails → engine B (alternate)
 * retried → static reference fallbacks → never-empty result + warning trail.
 *
 * Part 2 — runStyleTransferPass (server/lib/character2x4Sheet.js): the module
 * can't be require()'d here (native sharp), so the REAL function source is
 * sliced out and run in an isolated vm with the backend + eval stubbed. This
 * asserts the production Pass-2 code:
 *   a. catches per-attempt backend throws (a Gemini IMAGE_OTHER refusal no
 *      longer escapes and destroys the Pass-1 sheet),
 *   b. retries ONCE via the alternate backend after all attempts throw,
 *   c. returns { imageData: null } (→ caller ships Pass 1) instead of
 *      throwing when the alternate backend fails too,
 *   d. does NOT touch the alternate backend when the primary succeeds.
 *
 * Run: node tests/manual/test-avatar-guarantee.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
}

// ────────────────────────────────────────────────────────────────────────────
// Part 1: resolveGuaranteedReference
// ────────────────────────────────────────────────────────────────────────────
const { resolveGuaranteedReference } = require('../../server/lib/avatarGuarantee');

const IMG_B = 'data:image/jpeg;base64,ENGINE_B';
const IMG_STD = 'data:image/jpeg;base64,STANDARD_AVATAR';
const IMG_FACE = 'data:image/jpeg;base64,FACE';

async function part1() {
  // 1. Engine A throws (safety refusal) → engine B succeeds.
  let r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [
      { source: 'engine-A', fn: async () => { throw new Error('IMAGE_OTHER safety refusal'); } },
      { source: 'engine-B', fn: async () => IMG_B },
      { source: 'standard avatar', fn: async () => IMG_STD },
    ],
  });
  ok(r.imageData === IMG_B, '1a: engine B result returned after engine A threw');
  ok(r.source === 'engine-B', '1b: winning source is engine-B');
  ok(r.warnings.length === 1 && /engine-A: threw \(IMAGE_OTHER/.test(r.warnings[0]),
    '1c: engine A failure recorded as warning');

  // 2. Both engines fail (throw + null) → static reference fallback wins.
  r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [
      { source: 'engine-A', fn: async () => { throw new Error('refused'); } },
      { source: 'engine-B', fn: async () => null },
      { source: 'standard avatar', fn: async () => IMG_STD },
      { source: 'face photo', fn: async () => IMG_FACE },
    ],
  });
  ok(r.imageData === IMG_STD, '2a: falls through to standard avatar');
  ok(r.source === 'standard avatar', '2b: source reports the fallback');
  ok(r.warnings.length === 2, '2c: both engine failures recorded');
  ok(/engine-B: unavailable/.test(r.warnings[1]), '2d: null return recorded as unavailable');

  // 3. A step returning a non-data-URI (e.g. an unresolved R2 URL) is skipped.
  r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [
      { source: 'url-step', fn: async () => 'https://r2.example/avatar.jpg' },
      { source: 'face photo', fn: async () => IMG_FACE },
    ],
  });
  ok(r.imageData === IMG_FACE, '3a: URL-shaped value rejected, chain continues');
  ok(/url-step: returned a non data-URI/.test(r.warnings[0]), '3b: non-data-URI warned');

  // 4. Everything fails → imageData null + full warning trail (never throws).
  r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [
      { source: 'engine-A', fn: async () => { throw new Error('down'); } },
      { source: 'body photo', fn: async () => null },
      { source: 'face photo', fn: async () => undefined },
    ],
  });
  ok(r.imageData === null && r.source === null, '4a: exhausted chain yields null');
  ok(r.warnings.length === 4, '4b: 3 step warnings + 1 exhausted marker');
  ok(/ALL steps exhausted for Roger/.test(r.warnings[3]), '4c: exhausted marker names the character');

  // 5. Malformed step (no fn) is tolerated.
  r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [{ source: 'broken' }, { source: 'face photo', fn: async () => IMG_FACE }],
  });
  ok(r.imageData === IMG_FACE, '5a: step without fn skipped');
  ok(/broken: no resolver function/.test(r.warnings[0]), '5b: missing fn warned');

  // 6. First step wins → later steps never invoked.
  let laterCalled = false;
  r = await resolveGuaranteedReference({
    characterName: 'Roger',
    steps: [
      { source: 'engine-A', fn: async () => IMG_B },
      { source: 'engine-B', fn: async () => { laterCalled = true; return IMG_FACE; } },
    ],
  });
  ok(r.imageData === IMG_B && !laterCalled && r.warnings.length === 0,
    '6: short-circuits on first success with no warnings');
}

// ────────────────────────────────────────────────────────────────────────────
// Part 2: runStyleTransferPass sliced from character2x4Sheet.js
// ────────────────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');

function extractFunction(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  assert(start !== -1, `could not find function ${name} in character2x4Sheet.js`);
  // Match the parameter list first (default params may contain braces).
  let p = src.indexOf('(', start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pdepth++;
    else if (src[p] === ')') { pdepth--; if (pdepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const PASS1 = 'data:image/jpeg;base64,PASS1SHEET';
const STYLED = 'data:image/jpeg;base64,STYLED';

function makeSandbox({ backendBehavior }) {
  // backendBehavior(backendUsed, callIndex) → { imageData } or throws.
  const calls = [];
  const sandbox = {
    console,
    process: { env: { GEMINI_API_KEY: 'test-key' } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'gemini', avatarStyleTransferModel: 'gemini-2.5-flash-image' },
    MAX_SHEET_RETRIES: 2,
    buildStyleTransferPrompt: () => 'STYLE_PROMPT',
    styleTransferGenerate: async (prompt, img, backendOverride = null) => {
      const backend = backendOverride || sandbox.MODEL_DEFAULTS.avatarStyleTransferBackend;
      calls.push(backend);
      return backendBehavior(backend, calls.length);
    },
    // Eval accepts everything (valid) so success paths short-circuit.
    evaluateStyledSheetWithGemini: async () => ({ valid: true, finalScore: 9 }),
    require: (mod) => {
      if (/config\/models/.test(mod)) return { MODEL_PRICING: {} };
      throw new Error(`unexpected require in vm: ${mod}`);
    },
  };
  sandbox.__calls = calls;
  return sandbox;
}

async function part2() {
  const fnSrc = extractFunction(SRC, 'runStyleTransferPass');
  ok(fnSrc.includes('alt-backend'), 'slice: extracted source contains the alternate-backend stage');

  const run = async (sandbox) => {
    const context = vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}; __run = runStyleTransferPass;`, context);
    return context.__run({
      pass1ImageData: PASS1,
      facePhoto: 'data:image/jpeg;base64,FACE',
      artStyle: 'pixar',
      characterName: 'Roger',
      usageTracker: null,
    });
  };

  // a+b. Primary backend (gemini) throws on ALL attempts → alternate (grok)
  // retried once and wins; nothing escapes.
  let sb = makeSandbox({
    backendBehavior: (backend) => {
      if (backend === 'gemini') throw new Error('Gemini returned no image (style transfer)');
      return { imageData: STYLED, usage: null, modelId: 'grok-imagine', provider: 'grok' };
    },
  });
  let res = await run(sb);
  ok(res.imageData === STYLED, '7a: alternate backend result returned after all gemini attempts threw');
  ok(sb.__calls.filter(b => b === 'gemini').length === 3, '7b: 3 primary-backend attempts consumed');
  ok(sb.__calls.filter(b => b === 'grok').length === 1, '7c: exactly ONE alternate-backend retry');
  ok(res.attempts.filter(a => a.stage === 'gen-error').length === 3, '7d: each thrown attempt recorded');
  ok(res.attempts.some(a => a.stage === 'alt-backend' && a.backend === 'grok'), '7e: alt-backend attempt recorded');

  // c. BOTH backends fail → returns { imageData: null } (caller ships Pass 1),
  // never throws.
  sb = makeSandbox({
    backendBehavior: () => { throw new Error('everything down'); },
  });
  res = await run(sb);
  ok(res.imageData === null, '8a: both backends failing yields null imageData (Pass 1 ships)');
  ok(sb.__calls.length === 4, '8b: 3 primary + 1 alternate attempts, then stop');
  ok(res.attempts.some(a => a.stage === 'alt-backend-error'), '8c: alternate failure recorded');

  // d. Primary succeeds first try → alternate backend never touched.
  sb = makeSandbox({
    backendBehavior: (backend) => {
      if (backend !== 'gemini') throw new Error('alternate should not be called');
      return { imageData: STYLED, usage: null, modelId: 'gemini-2.5-flash-image', provider: 'gemini_image' };
    },
  });
  res = await run(sb);
  ok(res.imageData === STYLED, '9a: primary success returns styled sheet');
  ok(sb.__calls.length === 1 && sb.__calls[0] === 'gemini', '9b: single primary call, no alternate');

  // e. Primary throws once, then succeeds → retry within primary backend, no alternate.
  sb = makeSandbox({
    backendBehavior: (backend, n) => {
      if (backend !== 'gemini') throw new Error('alternate should not be called');
      if (n === 1) throw new Error('transient 500');
      return { imageData: STYLED, usage: null, modelId: 'gemini-2.5-flash-image', provider: 'gemini_image' };
    },
  });
  res = await run(sb);
  ok(res.imageData === STYLED, '10a: transient primary error consumed by retry');
  ok(sb.__calls.length === 2 && sb.__calls.every(b => b === 'gemini'), '10b: retry stayed on primary backend');
}

// ────────────────────────────────────────────────────────────────────────────
// Part 3: ensureStyledAvatarCoverage sliced from styledAvatars.js
// (styledAvatars.js can't be require()'d — it pulls images.js/sharp — so the
// REAL function runs in a vm with the module-scope collaborators stubbed.)
// ────────────────────────────────────────────────────────────────────────────
const STYLED_SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/styledAvatars.js'), 'utf8');

async function part3() {
  const fnSrc = extractFunction(STYLED_SRC, 'ensureStyledAvatarCoverage');
  ok(fnSrc.includes('resolveGuaranteedReference'), 'slice: coverage fn uses the guarantee chain');

  const makeCoverageSandbox = () => {
    const cache = new Map();
    const genLogEvents = [];
    const auditLogs = new Map();
    const sandbox = {
      console,
      Promise, Map, Set, Array, String, Object, Date, JSON,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => sandbox.__errors.push(m) },
      __errors: [],
      STYLED_AVATAR_BUCKETS: ['costumed', 'standard', 'winter', 'summer'],
      styledAvatarCache: cache,
      guaranteeSeededKeys: new Set(),
      // Mirror prod key shape (scope::name_category_style) minus AsyncLocalStorage.
      getAvatarCacheKey: (n, c, a) => {
        const cat = sandbox.normalizeClothingCategory(c);
        return `scope::${String(n).trim().toLowerCase()}_${cat}_${a}`;
      },
      normalizeClothingCategory: (c) => String(c || 'standard').toLowerCase().startsWith('costumed') ? 'costumed' : String(c || 'standard').toLowerCase(),
      resolveAvatarBytes: async (avatars, cat) => avatars?.[cat] || null,
      getPrimaryPhoto: (char) => char?.photos?.bodyNoBg || null,
      getFacePhoto: (char) => char?.photos?.face || null,
      getImageSizeKB: () => 1,
      cacheContext: { getStore: () => 'scope' },
      _STYLED_LOG_UNSCOPED: '__unscoped__',
      styledAvatarGenerationLogs: auditLogs,
      MAX_GENERATION_LOG_ENTRIES: 50,
      require: (mod) => {
        if (/avatarGuarantee/.test(mod)) return require('../../server/lib/avatarGuarantee');
        if (/generationLogger/.test(mod)) return { getCurrentLogger: () => ({ error: (ev, msg, char, det) => genLogEvents.push({ ev, char, det }) }) };
        if (/\.\/r2/.test(mod)) return { bytesFromAnyImage: async () => null };
        throw new Error(`unexpected require in vm: ${mod}`);
      },
    };
    sandbox.__genLogEvents = genLogEvents;
    sandbox.__auditLogs = auditLogs;
    return sandbox;
  };

  const run = async (sandbox, characters, artStyle, reqs) => {
    const context = vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}; __run = ensureStyledAvatarCoverage;`, context);
    return context.__run(characters, artStyle, reqs);
  };

  const IMG_STD2 = 'data:image/jpeg;base64,ROGER_STANDARD';
  const reqsCostumed = [{ pageNumber: 1, clothingCategory: 'costumed:knight', characterNames: ['Roger'] }];

  // A. Required character, zero styled avatars, standard avatar resolvable →
  // seeded at 'standard', loud error + genLog event + audit entry.
  let sb = makeCoverageSandbox();
  await run(sb, [{ name: 'Roger', avatars: { standard: IMG_STD2 } }], 'pixar', reqsCostumed);
  ok(sb.styledAvatarCache.get('scope::roger_standard_pixar') === IMG_STD2,
    '11a: fallback reference seeded into cache at standard bucket');
  ok(sb.__errors.some(m => /Roger has no styled avatar after retries/.test(m)),
    '11b: loud [AVATAR] error logged');
  ok(sb.__genLogEvents.some(e => e.ev === 'avatar_guarantee_fallback' && e.char === 'Roger'),
    '11c: generationLog avatar_guarantee_fallback emitted');
  ok((sb.__auditLogs.get('scope') || []).some(e => e.characterName === 'Roger' && e.guaranteeFallback),
    '11d: styled-avatar audit entry recorded');
  ok(sb.guaranteeSeededKeys.has('scope::roger_standard_pixar'),
    '11e: seeded key registered as retryable (does not block later real conversion)');

  // B. Character already has a costumed avatar in cache → untouched, silent.
  sb = makeCoverageSandbox();
  sb.styledAvatarCache.set('scope::roger_costumed_pixar', 'data:image/jpeg;base64,SHEET');
  await run(sb, [{ name: 'Roger', avatars: { standard: IMG_STD2 } }], 'pixar', reqsCostumed);
  ok(sb.__errors.length === 0 && sb.__genLogEvents.length === 0,
    '12: covered character triggers nothing');

  // C. Realistic + only standard required → cache miss is NORMAL, no firing.
  sb = makeCoverageSandbox();
  await run(sb, [{ name: 'Roger', avatars: {} }], 'realistic',
    [{ pageNumber: 1, clothingCategory: 'standard', characterNames: ['Roger'] }]);
  ok(sb.__errors.length === 0, '13a: realistic standard-only miss does not fire');
  // …but realistic + costumed required DOES fire.
  sb = makeCoverageSandbox();
  await run(sb, [{ name: 'Roger', avatars: { standard: IMG_STD2 } }], 'realistic', reqsCostumed);
  ok(sb.styledAvatarCache.get('scope::roger_standard_realistic') === IMG_STD2,
    '13b: realistic costumed-required miss fires the guarantee');

  // D. No fallback reference at all → exhausted event, no cache write, no throw.
  sb = makeCoverageSandbox();
  await run(sb, [{ name: 'Roger', avatars: {}, photos: {} }], 'pixar', reqsCostumed);
  ok(sb.styledAvatarCache.size === 0, '14a: nothing seeded when no reference exists');
  ok(sb.__genLogEvents.some(e => e.ev === 'avatar_guarantee_exhausted'),
    '14b: avatar_guarantee_exhausted emitted');

  // E. Character not required by any page → ignored even with empty cache.
  sb = makeCoverageSandbox();
  await run(sb, [{ name: 'Uncle', avatars: {} }], 'pixar', reqsCostumed);
  ok(sb.__errors.length === 0 && sb.styledAvatarCache.size === 0,
    '15: non-required character ignored');
}

(async () => {
  await part1();
  await part2();
  await part3();
  console.log(`✅ ALL ${passed} assertions passed (avatar MUST guarantee: chain resolver + Pass-2 alternate-backend retry + coverage backstop)`);
})().catch(err => {
  console.error('❌ FAIL:', err.message);
  process.exit(1);
});
