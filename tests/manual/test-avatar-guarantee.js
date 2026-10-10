/**
 * Deterministic unit tests for the styled-avatar MUST guarantee.
 *
 * Part 1 — resolveGuaranteedReference (server/lib/avatarGuarantee.js): pure
 * chain resolver used by ensureStyledAvatarCoverage. Stubbed steps model the
 * real chain: engine A (configured backend) fails → engine B (alternate)
 * retried → static reference fallbacks → never-empty result + warning trail.
 *
 * (Part 2, runStyleTransferPass, was deleted with the two-pass sheet on 2026-10-10.)
 *
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
// Helper: slice a function's source out of a module (the modules cannot be require()'d here: native sharp)
// ────────────────────────────────────────────────────────────────────────────
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
  await part3();
  console.log(`✅ ALL ${passed} assertions passed (avatar MUST guarantee: chain resolver + Pass-2 throw containment + coverage backstop)`);
})().catch(err => {
  console.error('❌ FAIL:', err.message);
  process.exit(1);
});
