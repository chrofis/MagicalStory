/**
 * Faithfulness unit test for `_maybeGenerateComposite` — the composite-vs-direct
 * router that makes `composite` a first-class OPTION on the shared image path
 * (generateImageWithQualityRetry). See docs/decisions.md "Covers = images;
 * composite is a shared-path option".
 *
 * Proves the OWNER PRINCIPLE mechanically:
 *   • composite absent / false  → returns null (→ shared path runs the DIRECT
 *     generate+eval path, byte-unchanged). generateCoverViaComposite NOT called.
 *     This is the PAGE PATH — pages never set the option, so they are unaffected.
 *   • composite true + landmark  → routes to generateCoverViaComposite ONCE with
 *     the mapped inputs, returns an imageResult marked composite:true, score
 *     null, usage {cost:0.04}, compositeDebug = generator debug.
 *   • composite true + NO landmark → returns null (invented-location fallback →
 *     direct), generator NOT called.
 *   • composite true + generator throws → returns null (fallback → direct).
 *
 * images.js cannot be require()'d here (native `sharp`), so the REAL source of
 * `_maybeGenerateComposite` is sliced out of the file and run in an isolated vm
 * with `log` + `require('./coverComposite')` stubbed to RECORD calls.
 *
 * Run: node tests/manual/test-composite-option-dispatch.js
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
  // paren-match the param list first (default params contain braces)
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

let passed = 0;
function check(desc, cond) { assert(cond, `FAIL: ${desc}`); passed++; }

// Build a sandbox with a recording generateCoverViaComposite + a fresh ledger.
function makeFn({ throws = false } = {}) {
  const calls = { composite: [] };
  const compositeReturn = {
    imageData: 'data:image/jpeg;base64,COMPOSITE',
    modelId: 'grok-imagine-image',
    prompt: 'PASS2-PROMPT',
    totalAttempts: 1,
    debug: { sequence: ['A', 'B'], pass1Output: 'P1', pass2Output: 'P2' },
  };
  const sandbox = {
    module: {},
    Buffer,
    console: { log() {} },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    require: (mod) => {
      if (mod === './coverComposite') {
        return {
          generateCoverViaComposite: async (args) => {
            calls.composite.push(args);
            if (throws) throw new Error('boom');
            return compositeReturn;
          },
        };
      }
      throw new Error(`unexpected require(${mod})`);
    },
  };
  const code = extractFunction(SRC, '_maybeGenerateComposite') + `\nmodule.exports = _maybeGenerateComposite;`;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { fn: sandbox.module.exports, calls, compositeReturn };
}

const LANDMARK = Buffer.from('landmark-bytes');
const CI = {
  coverKey: 'frontCover',
  characters: [{ name: 'A' }, { name: 'B' }],
  coverHint: { objects: ['ART001'] },
  sceneDescription: 'a scene',
  vbGrid: Buffer.from('grid'),
  landmarkBuf: LANDMARK,
  sceneBackground: 'data:image/jpeg;base64,BG',
  artStyle: 'oil',
  title: 'My Title',
  dedication: 'For X',
  styleHint: 'oil storybook',
  visualBible: { locations: [] },
  orient: 'turned-source',
};

(async () => {
  // ── PAGE PATH: composite option absent → null, generator NOT called ──────
  {
    const { fn, calls } = makeFn();
    const r = await fn({ landmarkPhotos: [], visualBibleGrid: null }, null, '[PAGE 5] ');
    check('page path (composite absent) → returns null', r === null);
    check('page path → generateCoverViaComposite NOT called', calls.composite.length === 0);
  }

  // ── composite explicitly false → null, generator NOT called ──────────────
  {
    const { fn, calls } = makeFn();
    const r = await fn({ composite: false, compositeInputs: CI }, null, '');
    check('composite:false → returns null', r === null);
    check('composite:false → generator NOT called', calls.composite.length === 0);
  }

  // ── composite true but NO landmark buffer → null (invented-location) ──────
  {
    const { fn, calls } = makeFn();
    const r = await fn({ composite: true, compositeInputs: { ...CI, landmarkBuf: null } }, null, '');
    check('composite:true + no landmark → returns null (direct fallback)', r === null);
    check('composite:true + no landmark → generator NOT called', calls.composite.length === 0);
  }

  // ── composite true + landmark present → routes + maps result ─────────────
  {
    const { fn, calls, compositeReturn } = makeFn();
    const tracker = () => {};
    const r = await fn({ composite: true, compositeInputs: CI }, tracker, '[Front Cover ITERATE] ');
    check('composite:true + landmark → generator called ONCE', calls.composite.length === 1);
    const args = calls.composite[0];
    check('forwarded coverKey', args.coverKey === 'frontCover');
    check('forwarded characters (mergedCharacters bundle)', args.characters === CI.characters);
    check('forwarded coverHint (enriched)', args.coverHint === CI.coverHint);
    check('forwarded sceneDescription', args.sceneDescription === 'a scene');
    check('forwarded vbGrid', args.vbGrid === CI.vbGrid);
    check('forwarded landmarkBuf', args.landmarkBuf === LANDMARK);
    check('forwarded sceneBackground', args.sceneBackground === CI.sceneBackground);
    check('forwarded artStyle', args.artStyle === 'oil');
    check('forwarded title', args.title === 'My Title');
    check('forwarded dedication', args.dedication === 'For X');
    check('forwarded styleHint', args.styleHint === 'oil storybook');
    check('forwarded visualBible', args.visualBible === CI.visualBible);
    check('forwarded orient', args.orient === 'turned-source');
    check('usageTracker forwarded to generator', args.usageTracker === tracker);

    // Return shape — imageResult-shaped, composite-marked, eval skipped.
    check('result.composite marker true', r.composite === true);
    check('result.imageData = generator imageData', r.imageData === compositeReturn.imageData);
    check('result.score null (eval skipped)', r.score === null);
    check('result.reasoning composite label', r.reasoning === 'composite-cover (no quality eval)');
    check('result.modelId = generator modelId', r.modelId === 'grok-imagine-image');
    check('result.totalAttempts = generator totalAttempts', r.totalAttempts === 1);
    check('result.prompt = generator prompt', r.prompt === 'PASS2-PROMPT');
    check('result.usage cost 0.04', r.usage.cost === 0.04 && r.usage.direct_cost === 0.04);
    check('result.grokRefImages null', r.grokRefImages === null);
    check('result.compositeDebug = generator debug', r.compositeDebug === compositeReturn.debug);
  }

  // ── composite true + generator throws → null (fallback to direct) ────────
  {
    const { fn, calls } = makeFn({ throws: true });
    const r = await fn({ composite: true, compositeInputs: CI }, null, '');
    check('generator throws → returns null (direct fallback)', r === null);
    check('generator throws → attempt was made (called once)', calls.composite.length === 1);
  }

  // ── orient defaults to 'frontal' when unset ──────────────────────────────
  {
    const { fn, calls } = makeFn();
    await fn({ composite: true, compositeInputs: { ...CI, orient: undefined } }, null, '');
    check('orient defaults to frontal', calls.composite[0].orient === 'frontal');
  }

  console.log(`✅ ALL ${passed} assertions passed (_maybeGenerateComposite dispatch)`);
})();
