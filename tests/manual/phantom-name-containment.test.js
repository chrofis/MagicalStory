/**
 * findPhantomNames must not invent a second Visual Bible entry for a character
 * the bible already holds under a longer name.
 *
 * job_1786913768533: the bible had "Zauberer Silvio" (CHR001), the scene
 * metadata called him "Silvio", exact matching declared him undeclared, and the
 * patcher wrote CHR002 with a face description that dropped his beard. Every
 * page referenced CHR001, so the render survived — but two contradictory
 * descriptions of one character is the drift this guard exists to prevent.
 *
 *   node tests/manual/phantom-name-containment.test.js
 */
const { _internal } = require('../../server/lib/phantomCharacters');
const findPhantomNames = _internal?.findPhantomNames
  || require('../../server/lib/phantomCharacters').findPhantomNames;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const pages = (names) => [{ characterClothing: Object.fromEntries(names.map(n => [n, 'standard'])) }];
const vb = (secondary) => ({ secondaryCharacters: secondary.map((name, i) => ({ id: `CHR00${i + 1}`, name })) });

// The real case: bible carries the title, prose drops it.
check('bare name matches a titled bible entry',
  findPhantomNames(pages(['Silvio']), vb(['Zauberer Silvio']), []).length === 0);

// And the reverse — prose adds a title the bible does not carry.
check('titled prose name matches a bare bible entry',
  findPhantomNames(pages(['Zauberer Silvio']), vb(['Silvio']), []).length === 0);

// Main/primary characters come from inputCharacters, same treatment.
check('bare name matches a titled input character',
  findPhantomNames(pages(['Felix']), { secondaryCharacters: [] }, [{ name: 'Grossvater Felix' }]).length === 0);

// Genuinely absent names must STILL be flagged — the guard's actual job.
check('an undeclared name is still a phantom',
  findPhantomNames(pages(['Baker Anna']), vb(['Zauberer Silvio']), []).length === 1);

// Whole-word only: a name must not match by being a substring of another.
check('substring is not a match (ida vs freida)',
  findPhantomNames(pages(['Ida']), vb(['Freida']), []).length === 1);

// Partial overlap of multi-word names must not merge them.
check('shared surname does not merge distinct people',
  findPhantomNames(pages(['Herr Müller']), vb(['Frau Müller']), []).length === 1);

// Case and whitespace are normalised.
check('case and spacing are ignored',
  findPhantomNames(pages(['  SILVIO ']), vb(['Zauberer Silvio']), []).length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
