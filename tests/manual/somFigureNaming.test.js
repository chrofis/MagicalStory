/**
 * Set-of-Mark figure naming: the namer must know the WHOLE story cast, and it
 * must never be forced to place a character the scene plan did not put on the
 * page.
 *
 * WHY THIS EXISTS
 * On staging story job_1786397108357_q1fjbdzbx page 14 the stored bboxDetection
 * has expectedCharacters ["Emma","Noah","Hans"] against 5 detected figures: the
 * cast is Emma, Noah, Hans, Sarah and Daniel, and the renderer drew all five.
 * With two older moustached men in frame and only Hans named, the namer had no
 * correct answer available — it put "Hans" on the far-left man (Daniel, green
 * coat) and left the real, white-haired Hans in the centre UNKNOWN. A garment
 * recolour then went to the wrong man.
 *
 * The fix passes the rest of the cast too, flagged expectedOnPage:false, and
 * offers them in the prompt under their own heading. It is an OFFER, never a
 * demand: the elimination clause ("N badges and N characters, assign each")
 * counts scene-plan characters only, so a widened list can never force an
 * absent character onto a background extra.
 *
 * images.js / figureDetection.js / repairPipeline.js cannot be require()d —
 * they initialise services and hang. The prompt assembly and the badge
 * placement are therefore extracted from the real source and executed here;
 * the wiring around them is asserted at source level. CRLF-normalised.
 *
 * Run: node tests/manual/somFigureNaming.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const figureDetectionSrc = read('server/lib/figureDetection.js');
const imagesSrc = read('server/lib/images.js');
const repairPipelineSrc = read('server/lib/repairPipeline.js');

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
  '  const describeChar = (c) => {',
  'Answer JSON only, e.g. {"A": "name"}. Each name at most once.`;'
);
const buildSomPrompt = new Function(
  'badges', 'expectedCharacters', 'otherCharacters', '_shortGarmentPhrase',
  `${promptSrc}\nreturn prompt;`
);
const somPrompt = (planned, others, nBadges) => buildSomPrompt(
  Array.from({ length: nBadges }, (_, i) => ({ letter: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] })),
  planned,
  others,
  (c) => (c ? String(c).slice(0, 40) : '')
);

// Page-14 cast: three planned, two more in the story.
const PLANNED = [
  { name: 'Emma', gdinoPrompt: 'young girl with brown hair', clothing: 'red winter coat', position: 'left foreground' },
  { name: 'Noah', gdinoPrompt: 'young boy with blond hair', clothing: 'blue jacket', position: 'right foreground' },
  { name: 'Hans', gdinoPrompt: 'older man with white hair and a moustache', clothing: 'brown coat', position: 'centre' },
];
const OTHERS = [
  { name: 'Sarah', gdinoPrompt: 'adult woman with dark hair', clothing: 'grey coat', position: '' },
  { name: 'Daniel', gdinoPrompt: 'adult man with dark hair and a moustache', clothing: 'green coat', position: '' },
];

console.log('\n── Prompt: the whole cast is offered ──');
{
  const p = somPrompt(PLANNED, OTHERS, 5);
  check('planned characters are listed', /- Emma:/.test(p) && /- Noah:/.test(p) && /- Hans:/.test(p));
  check('the unplanned cast is listed too', /- Sarah:/.test(p) && /- Daniel:/.test(p));
  check('they sit under their own heading, marked as may-or-may-not-be-present',
    /Other characters in this story — they may appear even though the scene plan did not list them:/.test(p));
  check('planned characters come first', p.indexOf('- Hans:') < p.indexOf('- Sarah:'));
  check('the identity cues survive for the unplanned ones too',
    /- Daniel: adult man with dark hair and a moustache/.test(p));
  check('the answer shape is unchanged', /Answer JSON only, e\.g\. \{"A": "name"\}\. Each name at most once\./.test(p));
}
{
  const p = somPrompt(PLANNED, [], 5);
  check('no heading when the plan already covers the cast',
    !/Other characters in this story/.test(p));
}

console.log('\n── Elimination counts scene-plan characters only ──');
{
  // 5 badges vs 3 planned: elimination must NOT fire (it fires on equality).
  const p = somPrompt(PLANNED, OTHERS, 5);
  check('5 badges / 3 planned / 2 other → no forced complete assignment',
    !/assign each scene-plan character to one badge/.test(p));
  check('and the open wording invites "unknown" for non-matching badges',
    /Use "unknown" only for a badge that matches none of the characters listed above\./.test(p));
}
{
  // 3 badges vs 3 planned + 2 other: elimination fires on the PLANNED count.
  const p = somPrompt(PLANNED, OTHERS, 3);
  check('3 badges / 3 planned → elimination fires', /assign each scene-plan character to one badge/.test(p));
  check('it counts the planned characters, not the widened list',
    /exactly 3 badges and 3 scene-plan characters/.test(p) && !/and 5 scene-plan characters/.test(p));
  check('an unplanned character is never demanded',
    !/assign each character to one badge/.test(p) && !/Sarah[^\n]*must/.test(p));
}
{
  // The trap the flag exists for: badge count equals the WIDENED cast size.
  const p = somPrompt(PLANNED, OTHERS, 5);
  check('badges == widened cast size still does not trigger elimination',
    !/exactly 5 badges and 5/.test(p));
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

console.log('\n── figureDetection wiring ──');
{
  check('the namer takes the other cast as its last argument',
    /async function _somIdentifyFigures\(imageDataUri, dets, expectedCharacters, W, H, pageLabel = '', otherCharacters = \[\]\)/.test(figureDetectionSrc));
  check('both groups are valid answers',
    /const validNames = new Set\(\[\.\.\.expectedCharacters, \.\.\.otherCharacters\]\.map\(c => c\.name\)\);/.test(figureDetectionSrc));
  check('the duplicate-name guard is untouched',
    /SoM duplicate name .* — answer invalid/.test(figureDetectionSrc));
  check('the detector accepts otherCharacters and defaults it to empty',
    /objectGroundingHints = null, otherCharacters = \[\] \} = opts;/.test(figureDetectionSrc));
  check('it is forwarded to the namer',
    /_somIdentifyFigures\(imageDataUri, dets, expectedCharacters, W, H, pageLabel, otherCharacters\)/.test(figureDetectionSrc));
  check('the undercount check still counts expected characters only',
    /if \(dets\.length < expectedCharacters\.length\) \{/.test(figureDetectionSrc));
  check('the layout fallback still assigns expected characters only',
    /const chars = expectedCharacters\.map\(c => \{/.test(figureDetectionSrc));
  check('a named unplanned figure still gets its label',
    /\[\.\.\.expectedCharacters, \.\.\.otherCharacters\]\.find\(c => c\.name === name\)/.test(figureDetectionSrc));
}

console.log('\n── images.js: the cast reaches the namer ──');
{
  check('scene-plan characters are flagged expectedOnPage:true',
    /characterDescriptions\[char\.name\] = \{ \.\.\.describeCharacter\(char\), expectedOnPage: true \};/.test(imagesSrc));
  check('the rest of the story cast is added from the full-cast photos',
    /for \(const entry of \(img\.allCharacterPhotos \|\| \[\]\)\) \{/.test(imagesSrc));
  check('flagged expectedOnPage:false',
    /characterDescriptions\[char\.name\] = \{ \.\.\.describeCharacter\(char\), expectedOnPage: false \};/.test(imagesSrc));
  check('a character already in the scene plan is not added twice',
    /if \(!char\?\.name \|\| characterDescriptions\[char\.name\]\) continue;/.test(imagesSrc));
  check('both groups are described through the SAME resolver (no second-class entries)',
    /const describeCharacter = \(char\) => \{/.test(imagesSrc)
    && (imagesSrc.match(/describeCharacter\(char\)/g) || []).length === 2);
  check('the resolver still goes through clothingRequirements',
    /const describeCharacter[\s\S]{0,900}buildClothingDescription\(char, cat, artStyle, clothingRequirements\)/.test(imagesSrc));
  check('the page-14 evidence is cited where the cast is widened',
    /job_1786397108357_q1fjbdzbx p14/.test(imagesSrc));

  check('buildExpectedCharactersForBbox carries the flag through',
    /expectedOnPage: desc\.expectedOnPage !== false,/.test(imagesSrc));
  check('legacy callers (no flag) stay planned — undefined means planned',
    /Absent\/undefined = planned/.test(imagesSrc));
  check('characters found only in the scene positions are planned',
    /description: clothing \|\| 'character',[\s\S]{0,120}expectedOnPage: true,/.test(imagesSrc));

  check('the enrich step splits planned from the rest',
    /const expectedCharacters = allCharactersForBbox\.filter\(c => c\.expectedOnPage !== false\);/.test(imagesSrc)
    && /const otherCharacters = allCharactersForBbox\.filter\(c => c\.expectedOnPage === false\);/.test(imagesSrc));
  check('only the planned list is passed as expectedCharacters',
    /allDetections = await detectAllBoundingBoxes\(imageData, \{\n\s*expectedCharacters,\n\s*otherCharacters,/.test(imagesSrc));
  check('detectAllBoundingBoxes accepts the other cast, default empty',
    /const \{ expectedCharacters = \[\], otherCharacters = \[\], expectedObjects = \[\]/.test(imagesSrc));
  check('it reaches GroundingDINO only as naming input',
    /detectFiguresWithGroundingDino\(imageData, expectedCharacters, \{ pageLabel, expectedObjects, objectGroundingHints, otherCharacters \}\)/.test(imagesSrc));
  check('the bbox cache key covers both lists',
    /_hashBboxKey\(imageData, \[\.\.\.expectedCharacters, \.\.\.otherCharacters\], expectedObjects\)/.test(imagesSrc));
}

console.log('\n── repairPipeline supplies the full cast objects ──');
{
  check('the full-cast reference photos carry their character object',
    /photoUrl: c\.avatars\?\.styled \|\| c\.photoUrl,\n\s*character: c\n/.test(repairPipelineSrc));
  check('photo consumers are unaffected — name/photoUrl still first',
    /\.map\(c => \(\{\n\s*name: c\.name,\n\s*photoUrl:/.test(repairPipelineSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
