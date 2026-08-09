/**
 * Cell→page attribution for entity-consistency issues.
 *
 * The bug this pins, from job_1786287569165_7f75jspcz (staging, 2026-08-09):
 * the mapping was parsed out of the issue PROSE with /\bCell\s+([A-Z])\b/, and
 * the model routinely writes the plural lowercase form —
 *
 *   "Hans's hat in cells A, B, C, D, F is a soft white cap"
 *
 * — where `cells A` cannot match `Cell` followed by whitespace. Nothing matched,
 * so `cellsToPages` came out `{}` and `pageNumbers` fell back to every page in
 * the group. The stored record shows the damage: five cells named, and
 *
 *   pageNumbers: [3, 4, 5, 7, 8, 10, 12, 13, 14, -2, -3]
 *
 * eleven pages including BOTH COVERS, each of which the consolidator would then
 * be asked to repair. It failed silently because an empty map looks exactly like
 * "the issue named no cells".
 *
 * These tests exercise the two extracted helpers against the real strings.
 *
 * Run: node tests/manual/entityCellToPage.test.js
 */
'use strict';

const fs = require('fs');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));

// The helpers live inside runEntityConsistencyChecks (they close over per-grid
// state), so lift them out of the source rather than restructuring production
// code for the test. CRLF-normalised: core.autocrlf=true checks this repo out
// with \r\n, so \n needles would never match.
const src = fs.readFileSync(require.resolve('../../server/lib/entityConsistency.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const sliceFn = (startNeedle, endNeedle) => {
  const a = src.indexOf(startNeedle);
  if (a < 0) throw new Error(`could not find: ${startNeedle}`);
  const b = src.indexOf(endNeedle, a);
  if (b < 0) throw new Error(`could not find end: ${endNeedle}`);
  return src.slice(a, b);
};

// sliceFn stops before the closing `};`, so re-add the brace and wrap.
const cellLettersOf = eval(
  '(' + sliceFn('const cellLettersOf = (issue, desc) => {', '\n        };')
    .replace('const cellLettersOf = ', '') + '\n})'
);

(async () => {
  // The exact description from the stored report.
  const REAL = "Hans's hat in cells A, B, C, D, F is a soft white cap, which contradicts the expected white tricorn hat.";

  console.log('\nTEST 1 — the structured `cells` field is preferred and needs no parsing');
  check('reads issue.cells verbatim',
    JSON.stringify(cellLettersOf({ cells: ['A', 'B', 'C', 'D', 'F'] }, REAL)) === '["A","B","C","D","F"]',
    JSON.stringify(cellLettersOf({ cells: ['A', 'B', 'C', 'D', 'F'] }, REAL)));
  check('normalises and de-duplicates',
    JSON.stringify(cellLettersOf({ cells: ['b', 'B', ' c '] }, '')) === '["B","C"]',
    JSON.stringify(cellLettersOf({ cells: ['b', 'B', ' c '] }, '')));
  check('ignores non-letters in the field',
    JSON.stringify(cellLettersOf({ cells: ['A', 'AB', '', null, 3] }, '')) === '["A"]',
    JSON.stringify(cellLettersOf({ cells: ['A', 'AB', '', null, 3] }, '')));

  console.log('\nTEST 2 — prose fallback covers the form that silently failed');
  check('THE REGRESSION: plural lowercase "cells A, B, C, D, F"',
    JSON.stringify(cellLettersOf({}, REAL)) === '["A","B","C","D","F"]',
    JSON.stringify(cellLettersOf({}, REAL)));
  check('singular "Cell B" still works',
    JSON.stringify(cellLettersOf({}, 'Cell B shows the wrong hat.')) === '["B"]');
  check('"cells A and B"',
    JSON.stringify(cellLettersOf({}, 'The shirt in cells A and B is green.')) === '["A","B"]');
  check('"Cells C, D and F"',
    JSON.stringify(cellLettersOf({}, 'Cells C, D and F disagree.')) === '["C","D","F"]');
  check('reference cell R is captured like any other letter',
    JSON.stringify(cellLettersOf({}, 'Cell R shows the true face, Cell E does not.')) === '["R","E"]');

  console.log('\nTEST 3 — the "and" trap');
  // With a case-insensitive letter class, "cells and the" captures the 'a' of
  // "and" as cell A. Letters are matched uppercase-only and must end on a word
  // boundary, so they cannot.
  check('"cells and their hats" yields nothing',
    JSON.stringify(cellLettersOf({}, 'The cells and their hats vary.')) === '[]',
    JSON.stringify(cellLettersOf({}, 'The cells and their hats vary.')));
  check('a lone capital in prose is not a cell',
    JSON.stringify(cellLettersOf({}, 'Hans wears A hat.')) === '[]',
    JSON.stringify(cellLettersOf({}, 'Hans wears A hat.')));

  console.log('\nTEST 4 — an unplaceable issue reaches NO page (the NO DEFAULT rule)');
  const block = sliceFn('for (const issue of (evalResult.issues || [])) {', 'report.characters[charName].issues.push(annotated);');
  check('there is no attribute-to-the-whole-group fallback left',
    !/pageNumbers\s*=\s*groupPages/.test(block));
  check('pageNumbers starts empty', /let pageNumbers = \[\];/.test(block));
  check('it is only filled from a RESOLVED cell',
    /const firstResolved = cellsMentioned\.find\(L => cellToPage\.get\(L\) != null\)/.test(block));
  check('an unplaceable issue records why', /unlocatedReason/.test(block));
  // feedbackConsolidator filters with `!e.pageNumbers || e.pageNumbers.includes(p)`.
  // [] is truthy, so [].includes(p) === false — excluded everywhere, which is the
  // intent. undefined would have been included EVERYWHERE. This asserts the
  // contract that makes empty safe.
  check('empty array excludes rather than includes (consolidator contract)',
    ![] === false && [].includes(3) === false);
  const cons = fs.readFileSync(require.resolve('../../server/lib/feedbackConsolidator.js'), 'utf8').replace(/\r\n/g, '\n');
  check('consolidator still filters on pageNumbers',
    /entityIssues\.filter\(e => !e\.pageNumbers \|\| e\.pageNumbers\.includes\(pageNumber\)\)/.test(cons));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
