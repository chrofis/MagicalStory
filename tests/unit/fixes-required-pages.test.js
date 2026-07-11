/**
 * Pure tests for ProgressiveUnifiedParser._ensurePatchedPageNumbers —
 * FIXES REQUIRED page-list parsing incl. defensive range handling.
 * No DB, no LLM.
 *
 * Run: node tests/unit/fixes-required-pages.test.js
 */
const assert = require('assert');
const { ProgressiveUnifiedParser } = require('../../server/lib/outlineParser/progressive');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); fail++; }
}

function parse(fixesBody) {
  const p = new ProgressiveUnifiedParser({});
  p.fullText = `---ANALYSIS---\nstuff\n**FIXES REQUIRED:**\n${fixesBody}\n---STORY PAGES---\n`;
  return p._ensurePatchedPageNumbers();
}
const sorted = (set) => [...set].sort((a, b) => a - b);

console.log('_ensurePatchedPageNumbers — FIXES REQUIRED page lists');
test('explicit enumeration unchanged: "Pages 2,3,5,6:"', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 2,3,5,6: TEXT: tighten dialogue')), [2, 3, 5, 6]);
});
test('single page: "Page 5:"', () => {
  assert.deepStrictEqual(sorted(parse('- Page 5: SCENE: recompose')), [5]);
});
test('hyphen range: "Pages 2-6:" expands inclusively', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 2-6: TEXT: pacing fix')), [2, 3, 4, 5, 6]);
});
test('en-dash range: "Pages 2–4:"', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 2–4: TEXT: x')), [2, 3, 4]);
});
test('mixed list + range: "Pages 1,3-5:"', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 1,3-5: TEXT: y')), [1, 3, 4, 5]);
});
test('garbage huge range capped: "Pages 2-99999:" adds nothing', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 2-99999: TEXT: z')), []);
});
test('inverted range ignored: "Pages 6-2:"', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 6-2: TEXT: z')), []);
});
test('multiple lines accumulate', () => {
  assert.deepStrictEqual(sorted(parse('- Pages 2-3: TEXT: a\n- Page 7: SCENE: b')), [2, 3, 7]);
});
test('no FIXES REQUIRED block → null (do not lock in)', () => {
  const p = new ProgressiveUnifiedParser({});
  p.fullText = '---ANALYSIS---\nno fixes header here\n---STORY PAGES---\n';
  assert.strictEqual(p._ensurePatchedPageNumbers(), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
