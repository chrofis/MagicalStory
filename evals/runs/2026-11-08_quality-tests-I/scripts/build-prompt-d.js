'use strict';
/**
 * Quality tests I, arm D. Makes no model call and uses no DB or network.
 *
 * D is C with the ENJOY/BUY verdicts removed (owner, 2026-11-09: "we do not use the rating for anything. ...
 * what would you want different if you were a 5 year old kid. What would you want different if you were a parent.
 * Or is there any show-stopper"). In their place are three listener questions whose answers become ordinary
 * fault lines. The grader of C adds one more change: an IMG fix gets one line per picture that must change.
 *
 * Each packet's filled verdict block is replaced. Its per-book question list ({BUY_CRITERION}) is kept as the
 * lens for the child question. The script stops if a segment is not found once per call.
 *
 * Usage: node evals/runs/2026-11-08_quality-tests-I/scripts/build-prompt-d.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const BLOCK = /Last, judge the whole book twice more\. Before either verdict[^\n]*\nENJOY:[^\n]*\nBUY: would a parent buy it\? Answer these:\n([\s\S]*?)\nWhere the answer is WEAK or NO[^\n]*\nWEAK is the expected answer[^\n]*\n/g;
const listeners = criteria => `Last, read the whole book three more times, each time as a different listener:
8. CHILD: you are a five-year-old hearing this book at bedtime. What would you want different? Look for the places where you would get bored, lose track of who is who or of what is happening, ask "why?" and get no answer, or feel let down by how it ends. These questions help you look:
${criteria}
9. PARENT: you are a parent reading this book aloud before you buy it. What would you want different? Look for the places where the main character does not solve the problem with their own act, where the price of failing is never said, where a sentence is hard to read aloud, or where the lesson is preached instead of shown.
10. SHOW-STOPPER: is there anything that would stop you giving this book to a five-year-old at all? For example, something frightening that is never comforted, unsafe behaviour shown as fine, a cruel or humiliating moment left unresolved, or a story that cannot be followed.
Each thing you would want different becomes an ordinary fault line on the page that holds it, with the change to that page's words or picture that fixes it. Where no change to one page would fix it, leave it out. A show-stopper weighs CRITICAL. Answers to questions 8 and 9 are weighed exactly by the weight scale below and are never raised.
`;
const CHANGES = [
  { from: 'This raised weight belongs to question 1 only: a fault found by any other question, or given with a verdict, is weighed exactly by the weight scale below and is never raised.',
    to: 'This raised weight belongs to question 1 only: a fault found by any other question is weighed exactly by the weight scale below and is never raised.' },
  { from: 'never one line per page it touches; where the same fix must also reach a later page, the sentence names that page.',
    to: 'never one line per page it touches; where the same words must also change on a later page, the sentence names that page. A FAULT[IMG] is the exception: write one line for each picture that must change, because each picture is redrawn on its own.' },
  { from: ' Then write the two verdicts, one line each: "VERDICT[ENJOY][<YES|WEAK|NO>]: <one sentence: the act that solves the story\'s problem and who performs it, whether the price of failing is said on a page (which one), and the page(s) that hold it back>" and "VERDICT[BUY][<YES|WEAK|NO>]: <one sentence: for YES the page(s) that earn each of the questions; for WEAK or NO the page(s) that hold it back>".',
    to: '' },
];
const count = (h, n) => h.split(n).length - 1;
function apply(text, perCall, where) {
  const blocks = text.match(BLOCK) || [];
  if (blocks.length !== perCall) throw new Error(`${where}: expected ${perCall} verdict block(s), found ${blocks.length}`);
  let out = text.replace(BLOCK, (_, criteria) => listeners(criteria));
  for (const c of CHANGES) {
    const n = count(out, c.from);
    if (n !== perCall) throw new Error(`${where}: expected ${perCall} of "${c.from.slice(0, 50)}…", found ${n}`);
    out = out.split(c.from).join(c.to);
  }
  if (/VERDICT|ENJOY|BUY/.test(out.replace(/{BUY_CRITERION}/g, ''))) throw new Error(`${where}: verdict text left`);
  return out;
}
const tplC = fs.readFileSync(path.join(ROOT, 'templates/c-book-audit.txt'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'templates/d-book-audit.txt'), apply(tplC.replace(/\{BUY_CRITERION\}/, '{BUY_CRITERION}'), 1, 'template'));
const packets = path.join(ROOT, 'packets');
for (const b of fs.readdirSync(packets).filter(d => /^book\d+$/.test(d)).sort()) {
  const c = fs.readFileSync(path.join(packets, b, 'prompt-C.txt'), 'utf8');
  const calls = Number((c.match(/===== CALL \d+ of (\d+)/) || [null, '1'])[1]);
  const d = apply(c, calls, b);
  if (/\{[A-Z_]+\}/.test(d)) throw new Error(`${b}: unfilled placeholder`);
  fs.writeFileSync(path.join(packets, b, 'prompt-D.txt'), d);
  console.log(b, 'calls', calls, 'C', c.length, 'D', d.length);
}
