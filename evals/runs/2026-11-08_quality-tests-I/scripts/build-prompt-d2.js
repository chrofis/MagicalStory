'use strict';
/**
 * Quality tests I, arm D2. Makes no model call. D2 is D with the listener rule edited (D grading, 2026-11-09).
 * In D the stand-ins dropped whole-book gaps, such as a price of failing that is never said, because of
 * "Where no change to one page would fix it, leave it out". D2 puts each gap on the page where it belongs.
 * Usage: node evals/runs/2026-11-08_quality-tests-I/scripts/build-prompt-d2.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FROM = 'Each thing you would want different becomes an ordinary fault line on the page that holds it, with the change to that page\'s words or picture that fixes it. Where no change to one page would fix it, leave it out.';
const TO = 'Each thing you would want different becomes an ordinary fault line on the page where its change belongs, with the change to that page\'s words or picture that fixes it. A gap in the whole book still belongs to one page: a price of failing or a reason that is never said goes on the page where the danger or the character first appears, with the sentence that says it. Leave a thing out only when no change of words or picture on any page would settle it.';
function apply(t, n, where) { const k = t.split(FROM).length - 1; if (k !== n) throw new Error(`${where}: expected ${n}, found ${k}`); return t.split(FROM).join(TO); }
fs.writeFileSync(path.join(ROOT, 'templates/d2-book-audit.txt'), apply(fs.readFileSync(path.join(ROOT, 'templates/d-book-audit.txt'), 'utf8'), 1, 'template'));
const P = path.join(ROOT, 'packets');
for (const b of fs.readdirSync(P).filter(d => /^book\d+$/.test(d)).sort()) {
  const d = fs.readFileSync(path.join(P, b, 'prompt-D.txt'), 'utf8');
  const calls = Number((d.match(/===== CALL \d+ of (\d+)/) || [null, '1'])[1]);
  fs.writeFileSync(path.join(P, b, 'prompt-D2.txt'), apply(d, calls, b));
}
console.log('D2 written');
