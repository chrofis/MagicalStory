// Proves the whitelist now carries compositeOutcome through BOTH rebuild sites,
// and that no image bytes were added to the JSONB blob. Static + behavioural,
// no API calls, no DB.
const fs = require('fs');
const src = fs.readFileSync('storyJobPipeline.js', 'utf8');

let ok = true;
const check = (label, cond) => { if (!cond) ok = false; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// 1. Both rebuild sites keep it.
const sites = (src.match(/compositeOutcome: img\.compositeOutcome/g) || []).length;
check(`compositeOutcome kept at both rebuild sites (found ${sites})`, sites === 2);

// 2. The repair-pipeline site has the rawImages fallback, like compositeDebug.
check('repair-pipeline site has the rawByPage fallback',
  /compositeOutcome: img\.compositeOutcome \|\| rawByPage\.get\(img\.pageNumber\)\?\.compositeOutcome/.test(src));

// 3. preScaleRepairImage was NOT added to either rebuild — it is base64, and
//    repairPipeline already surfaces it as an image version.
const rebuildRegion = src.slice(src.indexOf('allImages = '), src.length);
const badRestore = /^\s+preScaleRepairImage: img\./m.test(rebuildRegion);
check('preScaleRepairImage NOT restored into the JSONB blob', !badRestore);
check('repairPipeline still consumes it as a version',
  /const hasScaleRepair = !!img\.preScaleRepairImage/.test(fs.readFileSync('server/lib/repairPipeline.js', 'utf8')));

// 4. Shape of what actually gets stored — the producer sites, verbatim.
const shapes = [
  ["{ status: 'triggered' }", /compositeOutcome = \{ status: 'triggered' \}/],
  ["composited + detector + placed", /status: 'composited', detector:/],
  ["no-image + reason",             /status: 'no-image', reason:/],
  ["aborted + reason (capped 300)", /status: 'aborted', reason: String\(e\.message \|\| e\)\.slice\(0, 300\)/],
];
console.log('\n  stored shapes:');
for (const [label, re] of shapes) check(`  ${label}`, re.test(src));

// 5. None of those carry image bytes.
check('\n  no imageData on any compositeOutcome shape', !/compositeOutcome = \{[^}]*imageData/.test(src));

console.log(ok ? '\nALL CHECKS PASS' : '\nFAILURES ABOVE');
process.exit(ok ? 0 : 1);
