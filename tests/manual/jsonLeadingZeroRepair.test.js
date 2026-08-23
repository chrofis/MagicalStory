/**
 * A single invalid number literal used to cost an entire model response.
 *
 * Gemini emitted `"face_bbox": [0.35, 00.34, 0.45, 0.43]` on one page of Lab
 * experiment #820. JSON forbids a leading zero, so the whole inventory — four
 * correctly described figures — parsed to null, and downstream that page read
 * exactly like a picture with nobody in it.
 *
 * Run: node tests/manual/jsonLeadingZeroRepair.test.js
 */
const { extractJsonFromText } = require('../../server/lib/sceneMetadata');

let passed = 0;
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { console.error(`  ✗ ${msg}\n     got ${A}\n     want ${B}`); process.exit(1); }
  console.log(`  ✓ ${msg}`); passed++;
};

console.log('\nleading-zero number literals are repaired');
{
  eq(extractJsonFromText('{"box":[0.35,00.34,0.45]}'), { box: [0.35, 0.34, 0.45] },
     'the exact shape that failed in production');
  eq(extractJsonFromText('{"a":007}'), { a: 7 }, 'an integer with leading zeros');
  eq(extractJsonFromText('{"a":-00.5}'), { a: -0.5 }, 'a negative keeps its sign');
  eq(extractJsonFromText('{"a":0000.25}'), { a: 0.25 }, 'several leading zeros');
}

console.log('\nvalid JSON is never rewritten');
{
  eq(extractJsonFromText('{"a":1,"b":[0.5,0.25]}'), { a: 1, b: [0.5, 0.25] }, 'clean numbers');
  eq(extractJsonFromText('{"z":0,"y":0.0}'), { z: 0, y: 0 }, 'a bare zero, and 0.0');
  eq(extractJsonFromText('{"a":10,"b":100,"c":1.05}'), { a: 10, b: 100, c: 1.05 },
     'zeros INSIDE a number are left alone');
}

console.log('\nstrings are never touched — the reason this is not a bare regex');
{
  eq(extractJsonFromText('{"room":"room 007","n":00.5}'), { room: 'room 007', n: 0.5 },
     'a digit run inside a string survives while the broken number is fixed');
  eq(extractJsonFromText('{"s":"he said \\"007\\" loud","n":00.2}'), { s: 'he said "007" loud', n: 0.2 },
     'an escaped quote does not end the string early');
  eq(extractJsonFromText('{"s":"ends with backslash \\\\","n":00.3}'),
     { s: 'ends with backslash \\', n: 0.3 },
     'a trailing escaped backslash does not swallow the closing quote');
}

console.log('\nthe repair runs only as a last resort');
{
  // Valid JSON that CONTAINS a string looking like a broken number must come
  // back byte-identical — proof the rewriter never ran.
  eq(extractJsonFromText('{"label":"00.34"}'), { label: '00.34' },
     'a valid document is returned untouched, even when a string looks broken');
}

console.log(`\n✅ ALL ${passed} assertions passed (leading-zero JSON repair)\n`);
