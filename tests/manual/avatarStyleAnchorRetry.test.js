/**
 * Pass-2 style-transfer retry + fallback contract (server/lib/character2x4Sheet.js).
 *
 * Guards the fix for staging job_1787252581387_6sn8z0nh2, where an adult
 * character's 2×4 sheet came back with the style anchor's three figures painted
 * across all 8 cells. The anchor assets (server/assets/style-anchor-*.jpg) are
 * finished illustrations of three people on white — the same shape as the sheet
 * being restyled — so Grok sometimes blends them in. Both attempts scored 1/10
 * and the sheet shipped with success: true.
 *
 * Two behaviours are asserted here:
 *   1. the retry DROPS the anchor (re-sending the identical prompt + identical
 *      anchor just re-rolls the same dice), and switches to the no-anchor
 *      prompt so it stops referring to an Image 2 that isn't attached;
 *   2. runStyleTransferPass reports `valid`, so the caller can ship the Pass-1
 *      realistic sheet instead of a rejected styled one.
 *
 * The module can't be require()'d here (native sharp + side effects), so the
 * REAL function source is sliced out and run in an isolated vm with the backend
 * and the evaluator stubbed — same technique as test-avatar-guarantee.js.
 *
 * Run: node tests/manual/avatarStyleAnchorRetry.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ✓ ${msg}`); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); console.log(`  ✓ ${msg}`); passed++; };

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');

function extractFunction(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  assert(start !== -1, `could not find function ${name}`);
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

const FN_SRC = extractFunction(SRC, 'runStyleTransferPass');
const PASS1 = 'data:image/jpeg;base64,PASS1SHEET';
const ANCHOR = 'data:image/jpeg;base64,ANCHOR3PEOPLE';

// verdicts: one entry per attempt. null = generator throws.
function makeSandbox({ verdicts, hasAnchor = true, skipQualityEval = false }) {
  const calls = [];
  const sandbox = {
    console,
    process: { env: { GEMINI_API_KEY: 'test-key' } },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok', avatarStyleTransferModel: 'x' },
    MAX_SHEET_RETRIES: 1, // production value → 2 attempts total
    loadStyleAnchor: () => (hasAnchor ? ANCHOR : null),
    buildStyleTransferPrompt: (_style, { hasAnchor: h } = {}) => (h ? 'P_WITH_ANCHOR' : 'P_NO_ANCHOR'),
    styleTransferGenerate: async (prompt, _img, _backendOverride, styleAnchor) => {
      calls.push({ prompt, anchor: styleAnchor });
      const v = verdicts[calls.length - 1];
      if (v === 'throw') throw new Error('backend down');
      return { imageData: `STYLED_${calls.length}`, usage: null, modelId: 'grok-imagine', provider: 'grok' };
    },
    evaluateAvatarSheet: async () => {
      const v = verdicts[calls.length - 1];
      return { verdict: { valid: v.valid, finalScore: v.score, failureReasons: v.reasons || [] } };
    },
    require: (mod) => {
      if (/config\/models/.test(mod)) return { MODEL_PRICING: {} };
      throw new Error(`unexpected require in vm: ${mod}`);
    },
  };
  sandbox.__calls = calls;
  sandbox.__skipQualityEval = skipQualityEval;
  return sandbox;
}

async function run(sandbox, extra = {}) {
  const context = vm.createContext(sandbox);
  vm.runInContext(`${FN_SRC}; __run = runStyleTransferPass;`, context);
  return context.__run({
    pass1ImageData: PASS1,
    facePhoto: 'data:image/jpeg;base64,FACE',
    artStyle: 'watercolor',
    characterName: 'TestChar',
    usageTracker: null,
    skipQualityEval: sandbox.__skipQualityEval,
    ...extra,
  });
}

(async () => {
  console.log('\nretry drops the style anchor');
  {
    const sb = makeSandbox({
      verdicts: [{ valid: false, score: 1, reasons: ['Single Subject — No Other People'] },
                 { valid: true, score: 9 }],
    });
    const res = await run(sb);
    eq(sb.__calls.length, 2, 'rejected attempt 1 triggers attempt 2');
    eq(sb.__calls[0].anchor, ANCHOR, 'attempt 1 SENDS the anchor');
    eq(sb.__calls[0].prompt, 'P_WITH_ANCHOR', 'attempt 1 uses the with-anchor prompt');
    eq(sb.__calls[1].anchor, null, 'attempt 2 DROPS the anchor (the contaminant)');
    eq(sb.__calls[1].prompt, 'P_NO_ANCHOR', 'attempt 2 stops referring to Image 2');
    eq(res.imageData, 'STYLED_2', 'the anchor-free attempt wins');
    eq(res.valid, true, 'valid=true when an attempt passes');
    eq(res.prompt, 'P_NO_ANCHOR', 'returned prompt is the WINNING attempt\'s, not attempt 1\'s');
    eq(res.attempts[0].usedAnchor, true, 'attempt 1 records usedAnchor');
    eq(res.attempts[1].usedAnchor, false, 'attempt 2 records usedAnchor=false');
  }

  console.log('\na clean first attempt keeps the anchor and stops');
  {
    const sb = makeSandbox({ verdicts: [{ valid: true, score: 9 }] });
    const res = await run(sb);
    eq(sb.__calls.length, 1, 'no retry paid for when attempt 1 passes');
    eq(sb.__calls[0].anchor, ANCHOR, 'anchor still used on the happy path');
    eq(res.valid, true, 'valid=true');
  }

  console.log('\nevery attempt rejected → valid:false (caller ships Pass 1)');
  {
    const sb = makeSandbox({
      verdicts: [{ valid: false, score: 1, reasons: ['Single Subject — No Other People'] },
                 { valid: false, score: 1, reasons: ['Identity Preserved'] }],
    });
    const res = await run(sb);
    eq(sb.__calls.length, 2, 'both attempts consumed');
    eq(res.valid, false, 'valid=false — THE Sarah case: no attempt was acceptable');
    ok(res.imageData != null, 'the rejected sheet is still returned for the dev panel');
    eq(res.finalScore, 1, 'finalScore reports the rejected score');
  }

  console.log('\nhigher-scoring attempt wins when both are rejected');
  {
    const sb = makeSandbox({
      verdicts: [{ valid: false, score: 2 }, { valid: false, score: 5 }],
    });
    const res = await run(sb);
    eq(res.imageData, 'STYLED_2', 'best-of-N still picks the higher score');
    eq(res.valid, false, 'still invalid — best-of-N does not launder a rejection');
  }

  console.log('\nunjudgeable paths stay fail-open (valid:true)');
  {
    const sb = makeSandbox({ verdicts: [{ valid: true, score: 10 }], skipQualityEval: true });
    const res = await run(sb);
    eq(sb.__calls.length, 1, 'skipQualityEval takes the first attempt');
    eq(res.valid, true, 'no verdict → valid (trial must not lose its styled sheet)');
  }

  console.log('\nTest Lab promptOverride keeps the anchor on BOTH attempts');
  {
    const sb = makeSandbox({
      verdicts: [{ valid: false, score: 1 }, { valid: false, score: 1 }],
    });
    const res = await run(sb, { promptOverride: 'AB_PROMPT' });
    eq(sb.__calls.length, 2, 'both attempts run');
    eq(sb.__calls[0].anchor, ANCHOR, 'A/B attempt 1 keeps the anchor');
    eq(sb.__calls[1].anchor, ANCHOR, 'A/B attempt 2 keeps the anchor — inputs stay fixed under the experiment');
    eq(sb.__calls[1].prompt, 'AB_PROMPT', 'the override prompt is never swapped out');
    eq(res.valid, false, 'verdict still reported honestly');
  }

  console.log('\nno anchor asset for the style → retry is a plain re-roll');
  {
    const sb = makeSandbox({
      verdicts: [{ valid: false, score: 1 }, { valid: true, score: 8 }],
      hasAnchor: false,
    });
    const res = await run(sb);
    eq(sb.__calls[0].anchor, null, 'attempt 1 has no anchor to send');
    eq(sb.__calls[1].anchor, null, 'attempt 2 likewise');
    eq(res.valid, true, 'retry still works without an anchor');
  }

  console.log('\nevery attempt throws → explicit error (outer catch ships Pass 1)');
  {
    const sb = makeSandbox({ verdicts: ['throw', 'throw'] });
    let threw = null;
    try { await run(sb); } catch (e) { threw = e; }
    ok(threw !== null, 'throws rather than dereferencing a null best');
    ok(/produced no image/.test(threw.message), 'message names the real cause');
    eq(sb.__calls.length, 2, 'both attempts were tried first');
  }

  console.log(`\n✅ ALL ${passed} assertions passed (Pass-2 anchor-drop retry + valid contract)\n`);
})().catch((e) => { console.error(`\n❌ FAIL: ${e.message}\n`); process.exit(1); });
