// Regression test for the repair-pipeline pick-best tie-break.
// Observed on job_1781289599516 (safety-fought Tell story): all versions of
// page 2 scored 0 and the LAST repair round (most content-mangled image) won
// the tie over the original. Pipeline tie-break must prefer the EARLIEST
// version; null-scored versions are skipped.
const { selectBestVersion } = require('../../server/lib/images.js');

// Case 1 (the bug): all-zero tie → original must win
const tie = [
  { source: 'original', score: 0, finalScore: 0 },
  { source: 'inpaint-round-1', score: 0, finalScore: 0 },
  { source: 'inpaint-round-3', score: 0, finalScore: 0 },
];
console.assert(selectBestVersion(tie).source === 'original', 'FAIL: tie should pick original, got ' + selectBestVersion(tie).source);
console.log('✓ all-zero tie picks original');

// Case 2: genuine winner still wins regardless of position
const winner = [
  { source: 'original', score: 0, finalScore: 0 },
  { source: 'inpaint-round-1', score: 50, finalScore: 50 },
  { source: 'inpaint-round-2', score: 30, finalScore: 30 },
];
console.assert(selectBestVersion(winner).source === 'inpaint-round-1', 'FAIL: 50 should win');
console.log('✓ higher score still wins');

// Case 3: scale-repair shape — v0 null (no eval by design), v1 carries the score
const scaleRepair = [
  { source: 'original', score: null, finalScore: null },
  { source: 'scale-repair', score: 50, finalScore: 50 },
  { source: 'iterate-round-1', score: 0, finalScore: 0 },
];
console.assert(selectBestVersion(scaleRepair).source === 'scale-repair', 'FAIL: null-scored v0 must be skipped, scale-repair (50) wins');
console.log('✓ null-scored original skipped; scored sibling wins');

// Case 4: all null → falls back to versions[0]
const allNull = [
  { source: 'original', score: null },
  { source: 'iterate-round-1', score: null },
];
console.assert(selectBestVersion(allNull).source === 'original', 'FAIL: all-null falls back to original');
console.log('✓ all-null falls back to original');

// Case 5 (the #2 fix): all clamped to 0, but deduction totals differ →
// the candidate with the FEWEST issues wins, even when it's NOT the earliest.
const zerosByDeduction = [
  { source: 'original',        finalScore: 0, fixableIssues: [{ severity: 'MAJOR' }, { severity: 'MAJOR' }, { severity: 'MAJOR' }, { severity: 'MAJOR' }, { severity: 'MAJOR' }] }, // 5 MAJOR
  { source: 'inpaint-round-1', finalScore: 0, fixableIssues: [{ severity: 'MAJOR' }, { severity: 'MODERATE' }] },                                                                  // fewest → should win
  { source: 'iterate-round-2', finalScore: 0, fixableIssues: [{ severity: 'MAJOR' }, { severity: 'MAJOR' }, { severity: 'MAJOR' }] },                                              // 3 MAJOR
];
console.assert(selectBestVersion(zerosByDeduction).source === 'inpaint-round-1',
  'FAIL: among all-zero, fewest-deduction version should win, got ' + selectBestVersion(zerosByDeduction).source);
console.log('✓ all-zero tie broken by fewest deductions (not index)');

console.log('\n✓ all assertions passed');
