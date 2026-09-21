/**
 * One HTML page holding the ideas of one or more rounds, newest first.
 *
 *   node tests/manual/story-idea-rounds/build-ideas-html.js --rounds=19,18
 *   node .../build-ideas-html.js --rounds=19,18 --out=ideas-r19.html
 *
 * Reads round-<N>.json (the harness output) and, where a blind read exists,
 * blind-key-r<N>.json + blind-scores-r<N>.md to stamp the buy score and the
 * reader's one-line reason onto the matching cell/arm.
 *
 * Written as a script on 2026-09-21: ideas-r17-r18.html was produced by a
 * one-off `node -e`, so nobody could regenerate it. The meta line carries the
 * sentence and word count per idea, because the length now follows the scope
 * band (owner, 2026-09-21) and the count is the thing being read.
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const rounds = String(arg('rounds', '19,18')).split(',').map(s => s.trim()).filter(Boolean);
const out = arg('out', `ideas-r${rounds[0]}.html`);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A sentence ends at . ! ? followed by whitespace; paragraphs are blank-line separated.
const sentences = t => t.split(/\n\s*\n/).flatMap(p => p.split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(Boolean).length;
const words = t => t.split(/\s+/).filter(Boolean).length;
const paras = t => t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

function blindFor(round) {
  const keyF = path.join(DIR, `blind-key-r${round}.json`);
  const scoreF = path.join(DIR, `blind-scores-r${round}.md`);
  if (!fs.existsSync(keyF) || !fs.existsSync(scoreF)) return new Map();
  const rows = new Map(); // "cell/arm" -> {score, reason}
  const byId = new Map();
  for (const line of fs.readFileSync(scoreF, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(B\d+)\s*\|\s*(\d)\s*\|\s*(.*?)\s*\|\s*$/);
    if (m) byId.set(m[1], { score: Number(m[2]), reason: m[3] });
  }
  for (const e of JSON.parse(fs.readFileSync(keyF, 'utf8'))) {
    if (e.round !== `R${round}`) continue;
    const s = byId.get(e.id);
    if (s) rows.set(`${e.cell}/${e.arm}`, s);
  }
  return rows;
}

const parts = [];
for (const round of rounds) {
  const f = path.join(DIR, `round-${round}.json`);
  if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const blind = blindFor(round);
  parts.push(`<h2>Round ${esc(round)} — ${r.cells.length} cells, ${esc(r.model)}, USD ${r.totalCost.toFixed(4)}</h2>`);
  for (const c of r.cells) {
    const cell = c.cell;
    const cast = cell.characters.map(x => `${x.name} ${x.age}`).join(', ');
    const label = [cell.storyCategory, cell.storyTheme, cell.storyTopic].filter(Boolean).join(' / ');
    parts.push(`<div class=cell><div class=meta>Cell ${cell.id} · ${esc(label)} · ${cell.pages} pages · ${esc(cell.language)} · cast: ${esc(cast)}</div>`);
    for (const idea of c.ideas) {
      const b = blind.get(`${cell.id}/${idea.index}`);
      const badge = b ? ` <span class="score s${b.score}">buy ${b.score}</span>` : '';
      parts.push(`<h3>Idea ${idea.index} — ${esc(idea.world)} <span class=counts>${sentences(idea.final)} sentences · ${words(idea.final)} words</span>${badge}</h3>`);
      for (const p of paras(idea.final)) parts.push(`<div class=idea>${esc(p)}</div>`);
      if (b) parts.push(`<div class=reason>${esc(b.reason)}</div>`);
    }
    parts.push('</div>');
  }
}

const style = 'body{font-family:system-ui;max-width:1100px;margin:24px auto;padding:0 16px;color:#222}h1{font-size:22px}h2{margin-top:36px;border-bottom:2px solid #ccc}h3{margin:18px 0 4px;font-size:15px;color:#444}.cell{margin:14px 0;padding:12px 16px;border:1px solid #ddd;border-radius:8px;background:#fafafa}.meta{font-size:12px;color:#666;margin-bottom:6px}.idea{margin:8px 0 12px;line-height:1.5}.counts{font-size:12px;color:#888;font-weight:400}.score{display:inline-block;padding:1px 8px;border-radius:10px;background:#eee;font-size:12px;margin-left:8px}.s5{background:#c8f7c5}.s4{background:#e3f5c8}.s2,.s1{background:#f7c5c5}.reason{font-size:12px;color:#666;font-style:italic}';
const html = `<!doctype html><meta charset=utf-8><title>Story ideas rounds ${rounds.join(' and ')}</title><style>${style}</style>`
  + `<h1>Story ideas — round ${rounds.join(', then round ')}</h1>`
  + `<p>Length now follows the scope band (owner, 2026-09-21): four sentences under 11 pages, six to 20, nine in two paragraphs at 21+. The sentence and word count of every idea stands in its heading.</p>`
  + parts.join('');
fs.writeFileSync(path.join(DIR, out), html);
console.log(`written ${path.join(DIR, out)}`);
