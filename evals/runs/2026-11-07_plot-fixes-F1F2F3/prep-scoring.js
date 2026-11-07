// Prepares blind scoring inputs for F1 and F3 (arm hidden, new random ids, two scorer files each).
// usage: node prep-scoring.js <runDir>
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
let seed = 7771107; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).manifest;

// ---------- F1: [FINAL] idea + the main character(s) named by the prompt's own CHARACTERS list
{
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'F1', 'blind-map.json'), 'utf8'));
  const items = [];
  for (const [nm, it] of Object.entries(map)) {
    const f = path.join(dir, 'F1', 'answers', nm + '.txt');
    if (!fs.existsSync(f)) continue;
    const ans = fs.readFileSync(f, 'utf8');
    // the LAST line that is only "[FINAL]" (the review text may mention the marker earlier)
    const lines = ans.split('\n'); let at = -1;
    lines.forEach((l, i) => { if (/^[\s#*]*\[FINAL\][\s*]*$/.test(l)) at = i; });
    const m = at >= 0 ? [null, lines.slice(at + 1).join('\n')] : null;
    const final = (m ? m[1] : '').replace(/\n{3,}/g, '\n\n').trim();
    const prompt = fs.readFileSync(path.join(dir, 'F1', 'blind', nm + '.txt'), 'utf8');
    const mains = [...prompt.matchAll(/^- ([^:\n]+): [^\n]*main character/gim)].map(x => x[1].trim());
    items.push({ nm, it, final, mains });
  }
  const sh = shuffle(items).map((x, i) => ({ ...x, sid: 's' + String(i + 1).padStart(2, '0') }));
  fs.writeFileSync(path.join(dir, 'F1', 'score-map.json'), JSON.stringify(sh.map(({ sid, nm, it }) => ({ sid, nm, ...it })), null, 1));
  const half = Math.ceil(sh.length / 2);
  [sh.slice(0, half), sh.slice(half)].forEach((part, i) => {
    fs.writeFileSync(path.join(dir, 'F1', `score-input-${i + 1}.txt`), part.map(x => `=== ${x.sid} ===\nMAIN CHARACTER(S): ${x.mains.join(', ') || '(not marked)'}\nIDEA:\n${x.final}\n`).join('\n'));
  });
  console.log('F1 items', sh.length, 'empty finals', sh.filter(x => !x.final).length);
}

// ---------- F3: page text + the typed MUST SAY lines of the story
{
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'F3', 'blind-map.json'), 'utf8'));
  const must = Object.fromEntries(manifest.F3.map(m => [m.k, m.mustSay]));
  const items = [];
  for (const [nm, it] of Object.entries(map)) {
    const f = path.join(dir, 'F3', 'answers', nm + '.txt');
    if (!fs.existsSync(f)) continue;
    const ans = fs.readFileSync(f, 'utf8');
    const a = ans.indexOf('---STORY TEXT---'); const b = ans.indexOf('---TITLE---');
    const pages = (a >= 0 ? ans.slice(a + 16, b > a ? b : undefined) : ans).trim();
    const lines = String(must[it.k]).split('\n').filter(l => l.startsWith('- '));
    items.push({ nm, it, pages, lines, words: pages.split(/\s+/).length });
  }
  const sh = shuffle(items).map((x, i) => ({ ...x, sid: 's' + String(i + 1).padStart(2, '0') }));
  fs.writeFileSync(path.join(dir, 'F3', 'score-map.json'), JSON.stringify(sh.map(({ sid, nm, it, lines, words }) => ({ sid, nm, ...it, lines, words })), null, 1));
  const half = Math.ceil(sh.length / 2);
  [sh.slice(0, half), sh.slice(half)].forEach((part, i) => {
    fs.writeFileSync(path.join(dir, 'F3', `score-input-${i + 1}.txt`), part.map(x => `=== ${x.sid} ===\nLINES TO CHECK:\n${x.lines.map((l, j) => `L${j + 1} ${l.slice(2)}`).join('\n')}\nBOOK TEXT:\n${x.pages}\n`).join('\n'));
  });
  console.log('F3 items', sh.length, 'lines', sh.reduce((s, x) => s + x.lines.length, 0));
}
