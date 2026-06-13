// Regression test for page-text noise stripping.
// job_1781310332569 p14 shipped: "...Lily liess sie dort.\n\n*(Wortanzahl: 115)*\n\n---"
// — German word-count marker + trailing page separator leaked into the
// rendered story text. The trailing `---` had pushed the *(...)* block off
// the `$`-anchored strip.
const { cleanPageText, parsePatchSections } = require('../../server/lib/outlineParser/shared.js');

function assert(cond, msg) { console.assert(cond, msg); if (!cond) process.exitCode = 1; }

// 1. The exact leaked shape
const leaked = 'Ethan hob die Hand und hielt Lilys Handfläche offen dagegen. Lily liess sie dort.\n\n*(Wortanzahl: 115)*\n\n---';
const out1 = cleanPageText(leaked);
assert(!/Wortanzahl/.test(out1), 'FAIL: Wortanzahl survived: ' + JSON.stringify(out1.slice(-40)));
assert(!/---/.test(out1), 'FAIL: --- separator survived');
assert(out1.endsWith('Lily liess sie dort.'), 'FAIL: real text damaged: ' + JSON.stringify(out1.slice(-40)));
console.log('✓ 1. German word-count + trailing --- stripped, story text intact');

// 2. English word count flush at end (the original case)
const eng = 'She opened the door and smiled.\n\n*(Word count: 111)*';
assert(cleanPageText(eng) === 'She opened the door and smiled.', 'FAIL: English word count');
console.log('✓ 2. English word-count at end stripped');

// 3. Leading section-header annotation
const lead = '*(Page 5 — close-up, 1 char)*\nThe boy looked up at the sky.';
assert(cleanPageText(lead) === 'The boy looked up at the sky.', 'FAIL: leading header: ' + JSON.stringify(cleanPageText(lead)));
console.log('✓ 3. Leading section-header annotation stripped');

// 4. Bare *** separator + VB id
const mixed = 'He grabbed the [ART001] and ran.\n\n***';
const out4 = cleanPageText(mixed);
assert(out4 === 'He grabbed the and ran.', 'FAIL: id/sep: ' + JSON.stringify(out4));
console.log('✓ 4. *** separator + VB id stripped');

// 5. Clean text untouched
const clean = 'Once upon a time there was a happy boy.\n\nHe lived by the river.';
assert(cleanPageText(clean) === clean, 'FAIL: clean text altered');
console.log('✓ 5. clean text untouched');

// 6. Full patch-block parse (end-to-end shape Sonnet emits on the last page)
const block = 'TEXT:\nDer Apfel lag still.\n\n*(Wortanzahl: 88)*\n\n---';
const parsed = parsePatchSections(block);
assert(parsed.text === 'Der Apfel lag still.', 'FAIL: patch parse: ' + JSON.stringify(parsed.text));
console.log('✓ 6. parsePatchSections strips the leak end-to-end');

if (!process.exitCode) console.log('\n✓ all assertions passed');
