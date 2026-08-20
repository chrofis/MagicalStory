/**
 * Set-of-Mark figure naming: prompt assembly and badge placement.
 *
 * The naming step composites black letter badges onto the scene and asks
 * gemini-2.5-flash which letter is which character. Two things are pinned here:
 * the candidate list is exactly the scene-plan characters (a widened story-cast
 * list was tried on 2026-08-11 and reverted — characters do not appear on a page
 * uninvited; the real defect was the Art Director dropping described characters
 * out of the metadata `characters` array), and the badge sits just below the
 * chin rather than mid-torso.
 *
 * figureDetection.js cannot be require()d — it initialises services and hangs.
 * The prompt assembly and the badge placement are therefore extracted from the
 * real source and executed here; the wiring around them is asserted at source
 * level. CRLF-normalised.
 *
 * Run: node tests/manual/somFigureNaming.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const figureDetectionSrc = read('server/lib/figureDetection.js');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));

/** Slice `src` from the first line starting with `from` through `to` (inclusive). */
function slice(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a === -1 || b === -1) throw new Error(`could not slice source: ${from.slice(0, 40)}`);
  return src.slice(a, b + to.length);
}

// ── The real prompt assembly, executed ─────────────────────────────────────
const promptSrc = slice(
  figureDetectionSrc,
  '  const charLines = expectedCharacters.map(c => {',
  'Answer JSON only, e.g. {"A": "name"}. Each name at most once.`;'
);
// sanitizeForGemini must be injected: the sliced block gained a call to it
// (it lives in evalPipeline.js, re-exported by images.js — requiring either
// here would pull in native deps for a string-assembly test). A pass-through
// keeps the assertions below about the PROMPT, which is what this file tests.
const buildSomPrompt = new Function(
  'badges', 'expectedCharacters', '_shortGarmentPhrase', 'sanitizeForGemini',
  `${promptSrc}\nreturn prompt;`
);
const somPrompt = (planned, nBadges) => buildSomPrompt(
  Array.from({ length: nBadges }, (_, i) => ({ letter: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] })),
  planned,
  (c) => (c ? String(c).slice(0, 40) : ''),
  (s) => s
);

const PLANNED = [
  { name: 'A1', gdinoPrompt: 'young girl with brown hair', clothing: 'red winter coat', position: 'left foreground' },
  { name: 'A2', gdinoPrompt: 'young boy with blond hair', clothing: 'blue jacket', position: 'right foreground' },
  { name: 'A3', gdinoPrompt: 'older man with white hair and a moustache', clothing: 'brown coat', position: 'centre' },
];

console.log('\n── Prompt: the scene-plan characters are the candidate list ──');
{
  const p = somPrompt(PLANNED, 5);
  check('scene-plan characters are listed', /- A1:/.test(p) && /- A2:/.test(p) && /- A3:/.test(p));
  check('identity cues survive', /- A3: older man with white hair and a moustache/.test(p));
  check('clothing is appended when the identity phrase lacks it', /Wearing: red winter coat/.test(p));
  check('the position hint is marked as a hint only',
    /Expected position\/action \(hint from the scene plan; the image may differ\): centre\./.test(p));
  check('no story cast beyond the scene plan is offered',
    !/Other characters in this story/.test(p));
  check('the answer shape is unchanged', /Answer JSON only, e\.g\. \{"A": "name"\}\. Each name at most once\./.test(p));
}

console.log('\n── Elimination fires only when badges == expected characters ──');
{
  const p = somPrompt(PLANNED, 5);
  check('5 badges / 3 expected → no forced complete assignment',
    !/assign each character to one badge/.test(p));
  check('and "unknown" is invited for extra/background figures',
    /Use "unknown" only for a badge that is an extra\/background figure matching none of the expected characters\./.test(p));
}
{
  const p = somPrompt(PLANNED, 3);
  check('3 badges / 3 expected → elimination fires', /assign each character to one badge/.test(p));
  check('it names the counts', /exactly 3 badges and 3 expected characters/.test(p));
}

console.log('\n── Badge placement sits just below the face ──');
{
  const bySrc = slice(figureDetectionSrc, '    const by = d.face ?', '0.25;');
  const by = new Function('d', 'y1', 'y2', `${bySrc}\nreturn by;`);
  check('multiplier is 0.2 of the face height', /d\.face\.box\[1\]\) \* 0\.2\)/.test(bySrc));
  check('the y2 - 20 clamp is intact', /Math\.min\(y2 - 20,/.test(bySrc));
  check('the no-face branch is unchanged', /: y1 \+ \(y2 - y1\) \* 0\.25;$/.test(bySrc));
  // face box [x1,y1,x2,y2] = [100,100,200,200] → 100px tall, bottom at 200.
  const d = { face: { box: [100, 100, 200, 200] } };
  check('a 100px face on a tall body → badge 20px under the chin', by(d, 50, 900) === 220, String(by(d, 50, 900)));
  check('the clamp still wins on a short body', by(d, 50, 210) === 190, String(by(d, 50, 210)));
  check('no face → quarter of the body height', by({}, 100, 500) === 200, String(by({}, 100, 500)));
  check('the measurement and the reason are recorded',
    /mid-torso \(measured at 56% down the body box/.test(figureDetectionSrc));
}

console.log('\n── figureDetection wiring: the candidate list stays the scene plan ──');
{
  // The CAST argument must stay `expectedCharacters` — that is what this guards
  // (the reverted otherCharacters widening, 2026-08-11). Trailing RENDERING
  // knobs such as badgeAnchor are not a widening and must not trip it.
  check('the namer takes the scene-plan characters and nothing wider',
    /async function _somIdentifyFigures\(imageDataUri, dets, expectedCharacters, W, H, pageLabel = ''/.test(figureDetectionSrc));
  check('only expected names are valid answers',
    /const validNames = new Set\(expectedCharacters\.map\(c => c\.name\)\);/.test(figureDetectionSrc));
  // The guard's WORDING changed (it now names the figure and says the whole
  // answer is discarded); the invariant is that a name claimed twice throws the
  // entire SoM answer away rather than keeping the first.
  check('the duplicate-name guard is untouched',
    /if \(claimed\.has\(name\)\)/.test(figureDetectionSrc)
    && /whole answer discarded, falling back to layout/.test(figureDetectionSrc));
  check('the detector opts carry no widened cast',
    !/otherCharacters/.test(figureDetectionSrc));
  // Counts PEOPLE against PEOPLE since d09b29927: DINO detects `person`, so a
  // tracked animal in expectedCharacters used to guarantee an undercount and
  // hand every such page to the Gemini second opinion. Non-humans are filtered
  // out first — asserting the old expectedCharacters.length form would restore
  // that bug.
  check('the undercount check counts people against people',
    /const humanExpected = expectedCharacters\.filter\(/.test(figureDetectionSrc)
    && /if \(dets\.length < humanExpected\.length\) \{/.test(figureDetectionSrc));
  check('the layout fallback assigns expected characters',
    /const chars = expectedCharacters\.map\(c => \{/.test(figureDetectionSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
