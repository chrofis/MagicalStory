// Exercises the two #27 fixes without any API call or DB access.
const fs = require('fs');

// --- 1. splitInteractionNames ------------------------------------------------
const src = fs.readFileSync('server/lib/compositeCastBuilder.js', 'utf8');
const start = src.indexOf('function splitInteractionNames');
const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
const split = new Function(body + '; return splitInteractionNames;')();

const cases = [
  ['Levin + Max + Kiaan', ['levin', 'max', 'kiaan']],   // the measured page
  ['Sarah and Hans',      ['sarah', 'hans']],
  ['Emma, Noah',          ['emma', 'noah']],
  ['Fiona',               ['fiona']],
  ['Alexander',           ['alexander']],               // must NOT split on "and"
  ['Wanda und Ursula',    ['wanda', 'ursula']],
  ['Sandy',               ['sandy']],                   // must NOT split on "and"
];
let ok = true;
for (const [input, want] of cases) {
  const got = split(input);
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) ok = false;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(input).padEnd(24)} -> ${JSON.stringify(got)}`);
}

// --- 2. resolveCellPose, as the cast builder now calls it --------------------
const { resolveCellPose } = require('../../server/lib/storyAvatars');
console.log('\nperspective -> pose (flip must stay false throughout):');
for (const persp of ['facing right', 'facing left', 'back view', 'profile', 'side view',
                     'front', 'three-quarter', undefined]) {
  const r = resolveCellPose({ perspective: persp, depth: 'foreground' });
  const bad = r.flip !== false;
  if (bad) ok = false;
  console.log(`  ${String(persp).padEnd(15)} -> pose=${String(r.pose).padEnd(13)} flip=${r.flip}${bad ? '  <-- FLIP LEAKED' : ''}`);
}

// --- 3. the plate cast line no longer states a direction --------------------
const sc = fs.readFileSync('server/lib/sceneComposite.js', 'utf8');
const leaks = (sc.match(/facing right' : 'facing left/g) || []).length;
const stillSided = /offset toward the silhouette's \$\{oppSide\}/.test(sc);
console.log(`\ndirection expressions left in plate prompts: ${leaks}`);
console.log(`eye markers still keyed to a side          : ${stillSided}`);
if (leaks !== 0 || stillSided) ok = false;

console.log(ok ? '\nALL CHECKS PASS' : '\nFAILURES ABOVE');
process.exit(ok ? 0 : 1);
