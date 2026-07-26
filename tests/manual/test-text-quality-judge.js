/**
 * Unit test for the Test Lab text-only harness pure logic.
 *
 * Covers the deterministic pieces that need NO live API:
 *   - parseJudgeResponse: JSON-parse-and-validate of the judge output
 *   - formatStoryText: page-block formatting
 *   - the input_data clone + inputOverrides shallow-merge semantics used by
 *     POST /api/admin/jobs/:jobId/rerun-text
 *
 * Run:  node tests/manual/test-text-quality-judge.js
 */

const assert = require('assert');
const { parseJudgeResponse, formatStoryText, CRITERIA } = require('../../server/lib/textQualityJudge');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('parseJudgeResponse');

test('accepts a clean, valid judge JSON and returns the validated shape', () => {
  const raw = JSON.stringify({
    scores: { coherence: 4, ageAppropriateness: 5, characterConsistency: 3, emotionalArc: 4, languageQuality: 5 },
    justifications: {
      coherence: 'Clear arc.', ageAppropriateness: 'Right level.', characterConsistency: 'Consistent.',
      emotionalArc: 'Earned.', languageQuality: 'Delightful.',
    },
    overall: 4.2,
    summary: 'A strong story.',
  });
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, true, r.error);
  for (const k of CRITERIA) assert.strictEqual(typeof r.data.scores[k], 'number');
  // overall recomputed = (4+5+3+4+5)/5 = 4.2
  assert.strictEqual(r.data.overall, 4.2);
  assert.strictEqual(r.data.summary, 'A strong story.');
  assert.strictEqual(r.data.justifications.coherence, 'Clear arc.');
});

test('extracts JSON even when wrapped in prose / markdown code fences', () => {
  const raw = 'Here is my evaluation:\n```json\n' + JSON.stringify({
    scores: { coherence: 3, ageAppropriateness: 3, characterConsistency: 3, emotionalArc: 3, languageQuality: 3 },
  }) + '\n```\nHope that helps!';
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.overall, 3.0);
});

test('recomputes overall from scores, ignoring a wrong model-supplied overall', () => {
  const raw = JSON.stringify({
    scores: { coherence: 1, ageAppropriateness: 1, characterConsistency: 1, emotionalArc: 1, languageQuality: 1 },
    overall: 5.0, // deliberately wrong
  });
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.overall, 1.0);
});

test('rounds non-integer scores to nearest integer', () => {
  const raw = JSON.stringify({
    scores: { coherence: 4.4, ageAppropriateness: 3.6, characterConsistency: 3, emotionalArc: 3, languageQuality: 3 },
  });
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.scores.coherence, 4);
  assert.strictEqual(r.data.scores.ageAppropriateness, 4);
});

test('rejects a missing criterion (fails loudly, no silent zeros)', () => {
  const raw = JSON.stringify({ scores: { coherence: 4, ageAppropriateness: 4, characterConsistency: 4, emotionalArc: 4 } });
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /languageQuality/);
});

test('rejects an out-of-range score', () => {
  const raw = JSON.stringify({
    scores: { coherence: 9, ageAppropriateness: 4, characterConsistency: 4, emotionalArc: 4, languageQuality: 4 },
  });
  const r = parseJudgeResponse(raw);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /coherence/);
});

test('rejects a response with no JSON at all', () => {
  const r = parseJudgeResponse('I cannot evaluate this.');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /No JSON/);
});

test('rejects empty / non-string input', () => {
  assert.strictEqual(parseJudgeResponse('').ok, false);
  assert.strictEqual(parseJudgeResponse(null).ok, false);
});

console.log('formatStoryText');

test('labels pages in order and drops empty/whitespace pages', () => {
  const out = formatStoryText([
    { pageNumber: 1, text: 'Once upon a time.' },
    { pageNumber: 2, text: '   ' },       // whitespace-only → dropped
    { pageNumber: 3, text: 'The end.' },
    { pageNumber: 4 },                     // no text → dropped
  ]);
  assert.match(out, /--- Page 1 ---\nOnce upon a time\./);
  assert.match(out, /--- Page 3 ---\nThe end\./);
  assert.ok(!out.includes('Page 2'), 'whitespace page should be dropped');
  assert.ok(!out.includes('Page 4'), 'text-less page should be dropped');
});

console.log('rerun-text input clone + inputOverrides shallow-merge');

// Mirrors the exact merge the route performs before insert (see
// server/routes/admin/jobs.js POST /:jobId/rerun-text). Kept in-test so the
// documented seam behavior is asserted deterministically.
function buildRerunInput(sourceInput, inputOverrides) {
  const baseInput = { ...(sourceInput || {}) };
  const overrides = (inputOverrides && typeof inputOverrides === 'object') ? inputOverrides : {};
  const inputData = { ...baseInput, ...overrides };
  inputData.skipImages = true;
  delete inputData.idempotencyKey;
  return inputData;
}

test('always forces skipImages=true and strips idempotencyKey', () => {
  const src = { language: 'de', skipImages: false, idempotencyKey: 'abc123', pages: 8 };
  const out = buildRerunInput(src, {});
  assert.strictEqual(out.skipImages, true);
  assert.strictEqual('idempotencyKey' in out, false);
  assert.strictEqual(out.language, 'de');
  assert.strictEqual(out.pages, 8);
  // Source object not mutated.
  assert.strictEqual(src.skipImages, false);
  assert.strictEqual(src.idempotencyKey, 'abc123');
});

test('inputOverrides shallow-merge over the clone (the outline A/B seam)', () => {
  const src = { language: 'de', outlineMode: 'single', pages: 8 };
  const out = buildRerunInput(src, { outlineMode: 'split' });
  assert.strictEqual(out.outlineMode, 'split'); // overridden
  assert.strictEqual(out.language, 'de');       // preserved
  assert.strictEqual(src.outlineMode, 'single'); // source untouched
});

console.log(`\nAll ${passed} assertions/tests passed ✅`);
