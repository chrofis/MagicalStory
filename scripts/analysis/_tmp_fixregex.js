const fs = require('fs');
const p = 'server/lib/compositeCastBuilder.js';
let s = fs.readFileSync(p, 'utf8');
const BS = String.fromCharCode(8);

// The whole split line, rebuilt. No \b at all: requiring whitespace around the
// conjunctions is equivalent here and avoids the word-boundary escape entirely.
// Word boundaries matter — without them "Alexander" splits into "Alex" + "er" —
// so the spaces are doing that job.
const lines = s.split('\n');
const idx = lines.findIndex(l => l.includes('.split(') && l.includes(BS));
if (idx === -1) { console.log('no damaged line found'); process.exit(1); }
console.log('damaged line', idx + 1, ':', JSON.stringify(lines[idx]));
lines[idx] = '    .split(/\\s*(?:\\+|&|,)\\s*|\\s+(?:and|und|et)\\s+/i)';
s = lines.join('\n');
if (s.includes(BS)) { console.log('backspace still present elsewhere'); process.exit(1); }
fs.writeFileSync(p, s);
console.log('rewritten  :', JSON.stringify(lines[idx]));
