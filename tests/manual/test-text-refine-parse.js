/**
 * parseRefinedText — page splitting for the text_refine stage.
 *
 * Exists because of a real defect: the slice end used the NEXT heading's END
 * offset instead of its START, so every page's stored text ended with the
 * literal "## Page N+1" line. That shipped inside the book and was only caught
 * by eyeballing a stored page.
 *
 * Run: node tests/manual/test-text-refine-parse.js
 */

const { parseRefinedText } = require('../../server/lib/storyHelpers');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`); }
};

console.log('\nheading must not bleed into the previous page');
{
  const raw = '---STORY TEXT---\n## Page 1\nText one.\n\n## Page 2\nText two.\n\n## Page 3\nText three.';
  const r = parseRefinedText(raw, [1, 2, 3]);
  check('page 1 text is clean', r.pages[0].text, 'Text one.');
  check('page 2 text is clean', r.pages[1].text, 'Text two.');
  check('last page is clean', r.pages[2].text, 'Text three.');
  check('no page contains a heading', r.pages.some(p => /##\s*Page/i.test(p.text)), false);
}

console.log('\nmulti-paragraph pages keep their internal blank lines');
{
  const raw = '---STORY TEXT---\n## Page 1\nPara one.\n\nPara two.\n\n## Page 2\nOther.';
  const r = parseRefinedText(raw, [1, 2]);
  check('blank line preserved inside a page', r.pages[0].text, 'Para one.\n\nPara two.');
}

console.log('\nselective output (only rewritten pages returned)');
{
  const raw = '---STORY TEXT---\n## Page 4\nOnly this one changed.';
  const r = parseRefinedText(raw, [1, 2, 3, 4, 5]);
  check('returns just the one page', r.pages.map(p => p.pageNumber), [4]);
  check('untouched pages reported missing', r.missing, [1, 2, 3, 5]);
}

console.log('\nNONE / empty answers');
{
  check('NONE yields no pages', parseRefinedText('---STORY TEXT---\nNONE', [1, 2]).pages, []);
  check('empty string yields no pages', parseRefinedText('', [1]).pages, []);
}

console.log('\ntolerance');
{
  check('missing marker still parses',
    parseRefinedText('## Page 1\nHello.', [1]).pages[0].text, 'Hello.');
  check('preamble before the marker is dropped',
    parseRefinedText('Sure, here you go:\n---STORY TEXT---\n## Page 1\nHello.', [1]).pages[0].text, 'Hello.');
  check('bold heading parses',
    parseRefinedText('---STORY TEXT---\n## **Page 2**\nHi.', [2]).pages[0].pageNumber, 2);
  check('German heading parses',
    parseRefinedText('---STORY TEXT---\n## Seite 3\nHallo.', [3]).pages[0].pageNumber, 3);
}

console.log('\ncustom marker name (scene review uses ---SCENES---)');
{
  // Regression: the marker regex was hardcoded to STORY TEXT and ignored
  // markerName, so every ---SCENES--- response parsed with a null marker and
  // returned an empty analysis regardless of which model produced it.
  const raw = '---ANALYSIS---\n1. Repetition - pages 2 and 3 look alike.\n\n---SCENES---\n## Page 2\nA wider shot.';
  const r = parseRefinedText(raw, [1, 2, 3], 'SCENES');
  check('analysis is captured', r.analysis, '1. Repetition - pages 2 and 3 look alike.');
  check('only the rewritten page returns', r.pages.map(p => p.pageNumber), [2]);
  check('analysis does not leak into page text', r.pages[0].text, 'A wider shot.');
  check('unrewritten pages reported missing', r.missing, [1, 3]);
  check('NONE with custom marker yields no pages',
    parseRefinedText('---ANALYSIS---\nAll good.\n---SCENES---\nNONE', [1], 'SCENES').pages, []);
  check('analysis still captured when nothing was rewritten',
    parseRefinedText('---ANALYSIS---\nAll good.\n---SCENES---\nNONE', [1], 'SCENES').analysis, 'All good.');
  check('default marker still works', parseRefinedText(
    '---ANALYSIS---\nFine.\n---STORY TEXT---\n## Page 1\nHi.', [1]).analysis, 'Fine.');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
