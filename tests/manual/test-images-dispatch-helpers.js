/**
 * Faithfulness unit tests for the pure dispatch helpers extracted from
 * server/lib/images.js (roadmap "images.js cluster" #1/#2/#3-4).
 *
 * images.js cannot be require()'d in this environment (native `sharp` dep is
 * absent), so each helper's REAL source text is sliced out of the file and
 * evaluated in an isolated vm context with stubbed MODEL_DEFAULTS / log. Each
 * test asserts the extracted helper returns byte-identical output to the
 * inline expression it replaced, for every relevant input combination.
 *
 * Run: node tests/manual/test-images-dispatch-helpers.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');

// Extract a top-level `function <name>(...) { ... }` by brace-matching from its
// declaration, so we run the ACTUAL production source (not a hand-copy).
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start !== -1, `could not find function ${name} in images.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function loadHelper(name, sandbox) {
  const code = extractFunction(SRC, name) + `\nmodule.exports = ${name};`;
  const ctx = { module: {}, ...sandbox };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.module.exports;
}

let passed = 0;
function check(desc, cond) {
  assert(cond, `FAIL: ${desc}`);
  passed++;
}

// ---------------------------------------------------------------------------
// #3/#4 — resolveOutputAspect(evaluationType, aspectRatioOverride)
// ---------------------------------------------------------------------------
{
  // Distinct sentinel strings so a wrong branch is unmistakable.
  const MODEL_DEFAULTS = { pageAspect: 'PAGE', coverAspect: 'COVER', avatarAspect: 'AVATAR' };
  const resolveOutputAspect = loadHelper('resolveOutputAspect', { MODEL_DEFAULTS });

  // The exact inline expression the helper replaced (3 copy-pasted sites).
  const inline = (evaluationType, aspectRatioOverride) =>
    aspectRatioOverride
      || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
          : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
          : MODEL_DEFAULTS.pageAspect);

  const evalTypes = ['scene', 'cover', 'avatar', 'unknown', undefined, null, ''];
  const overrides = [null, undefined, '3:4', '9:16', '16:9', ''];
  for (const et of evalTypes) {
    for (const ov of overrides) {
      const got = resolveOutputAspect(et, ov);
      const want = inline(et, ov);
      check(`resolveOutputAspect(${JSON.stringify(et)}, ${JSON.stringify(ov)}) === ${JSON.stringify(want)} (got ${JSON.stringify(got)})`, got === want);
    }
  }
  // Spot-check the mapping is what production expects.
  check("scene → pageAspect", resolveOutputAspect('scene', null) === 'PAGE');
  check("cover → coverAspect", resolveOutputAspect('cover', null) === 'COVER');
  check("avatar → avatarAspect", resolveOutputAspect('avatar', null) === 'AVATAR');
  check("override wins over avatar", resolveOutputAspect('avatar', '3:4') === '3:4');
}

// ---------------------------------------------------------------------------
// #2 — truncatePromptForModel(prompt, maxPromptLength, logLabel, modelName?)
// ---------------------------------------------------------------------------
if (SRC.includes('function truncatePromptForModel(')) {
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  const truncatePromptForModel = loadHelper('truncatePromptForModel', { log });

  // Reference: the original per-site behaviour (returns possibly-truncated prompt).
  const inline = (prompt, max) => {
    let out = prompt;
    if (prompt.length > max) out = prompt.substring(0, max - 3) + '...';
    return out;
  };

  const cases = [
    { p: 'x'.repeat(10), max: 20 },   // under
    { p: 'x'.repeat(20), max: 20 },   // exactly at limit → no truncation
    { p: 'x'.repeat(21), max: 20 },   // one over → truncated
    { p: 'x'.repeat(9000), max: 7500 },
    { p: '', max: 30000 },
  ];
  for (const c of cases) {
    warnings.length = 0;
    const got = truncatePromptForModel(c.p, c.max, 'IMAGE GEN', 'some-model');
    const want = inline(c.p, c.max);
    check(`truncate len=${c.p.length} max=${c.max} → len ${got.length} (want ${want.length})`, got === want);
    // Result never exceeds max; when truncated, length is exactly max.
    if (c.p.length > c.max) check(`truncated length == max (${c.max})`, got.length === c.max);
    // Warning emitted iff truncation happened.
    check(`warn emitted iff truncated (len=${c.p.length})`, (warnings.length === 1) === (c.p.length > c.max));
  }

  // Log string is byte-identical to each original site.
  warnings.length = 0;
  truncatePromptForModel('y'.repeat(100), 50, 'IMAGE GEN', 'grok-imagine');
  check('log with modelName matches original', warnings[0] === '✂️ [IMAGE GEN] Prompt too long (100 chars), truncating to 50 for grok-imagine');
  warnings.length = 0;
  truncatePromptForModel('y'.repeat(100), 50, 'IMAGE GEN-ONLY');
  check('log without modelName matches original (site D)', warnings[0] === '✂️ [IMAGE GEN-ONLY] Prompt too long (100 chars), truncating to 50');
}

// ---------------------------------------------------------------------------
// #1 — extractDataImageUrls(characterPhotos)
// ---------------------------------------------------------------------------
if (SRC.includes('function extractDataImageUrls(')) {
  const extractDataImageUrls = loadHelper('extractDataImageUrls', {});

  // Reference: the original inline loop (2 byte-identical Runware copies).
  const inline = (characterPhotos) => {
    const referenceImages = [];
    if (characterPhotos && characterPhotos.length > 0) {
      for (const photoData of characterPhotos) {
        const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
        if (photoUrl && photoUrl.startsWith('data:image')) referenceImages.push(photoUrl);
      }
    }
    return referenceImages;
  };

  const inputs = [
    null,
    undefined,
    [],
    ['data:image/png;base64,AAA'],
    ['data:image/png;base64,AAA', 'https://x/y.png', 'data:image/jpeg;base64,BBB'],
    [{ photoUrl: 'data:image/png;base64,CCC' }, { photoUrl: 'nope' }, { nope: 1 }],
    [null, undefined, { photoUrl: null }, 'data:image/webp;base64,DDD'],
    ['notdata', { photoUrl: undefined }],
  ];
  for (const inp of inputs) {
    const got = extractDataImageUrls(inp);
    const want = inline(inp);
    check(`extractDataImageUrls(${JSON.stringify(inp)}) === ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want));
  }
  // slice(0,3) path used by the avatar Grok branch stays equivalent.
  const many = ['data:image/png;base64,1', 'data:image/png;base64,2', 'data:image/png;base64,3', 'data:image/png;base64,4'];
  check('avatar slice(0,3) equivalence', JSON.stringify(extractDataImageUrls(many.slice(0, 3))) === JSON.stringify(inline(many.slice(0, 3))));
}

console.log(`✅ ALL ${passed} assertions passed (resolveOutputAspect${SRC.includes('function truncatePromptForModel(') ? ' + truncatePromptForModel' : ''}${SRC.includes('function extractDataImageUrls(') ? ' + extractDataImageUrls' : ''})`);
