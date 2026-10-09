#!/usr/bin/env node
/**
 * Build the idea-review dataset from the stored idea rounds: every idea with its [DRAFT], [REVIEW] and [FINAL],
 * the cast/topic cell, the call's ms/usage, and (where a blind set scored it) the blind buy score of the FINAL.
 * Writes evals/runs/2026-10-09_jev-idea-review/ideas.jsonl. Read-only on tests/manual/story-idea-rounds.
 */
const fs = require('fs'); const path = require('path');
const D = path.join(__dirname, '../../tests/manual/story-idea-rounds/');
const OUT = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
fs.mkdirSync(OUT, { recursive: true });
const sec = (raw, a, b) => { const i = raw.indexOf('[' + a + ']'); if (i < 0) return null; let rest = raw.slice(i + a.length + 2); if (b) { const j = rest.indexOf('[' + b + ']'); if (j >= 0) rest = rest.slice(0, j); } return rest.trim(); };
const lastFinal = raw => { const m = [...raw.matchAll(/\[FINAL\]\s*/gi)]; if (!m.length) return null; const l = m[m.length - 1]; return raw.slice(l.index + l[0].length).trim(); };
const ideas = {};
for (const f of fs.readdirSync(D).filter(f => /^round-.*\.json$/.test(f) && !/dry-run/.test(f))) {
  const rid = f.replace(/^round-|\.json$/g, '');
  const j = JSON.parse(fs.readFileSync(D + f));
  if (!j.cells) continue;
  for (const c of j.cells) for (const i of c.ideas || []) {
    const raw = i.raw || '';
    if (!/\[DRAFT\]/i.test(raw)) continue;
    const draft = sec(raw, 'DRAFT', 'REVIEW'), review = sec(raw, 'REVIEW', 'FINAL'), final = lastFinal(raw);
    if (!draft || !final) continue;
    const id = `R${rid}/c${c.cell.id}/a${i.index}`;
    ideas[id] = { id, round: rid, cell: c.cell.id, arm: i.index, world: i.world, model: i.modelId || j.model, lang: c.cell.language, pages: c.cell.pages,
      cat: c.cell.storyCategory, theme: c.cell.storyTheme, topic: c.cell.storyTopic, cast: c.cell.characters.map(x => ({ name: x.name, age: x.age, main: !!x.isMain })),
      landmarks: c.landmarkNames || [], draft, review, final, ms: i.ms, usage: i.usage, cost: i.cost, promptChars: (i.prompt || '').length };
  }
}
// blind buy scores of FINALs
const sets = [['blind-scores.md', 'blind-key.json'], ['blind-scores-two.md', 'blind-key-two.json'], ['blind-scores-opus.md', 'blind-key-opus.json']];
for (const r of [8, 9, 10, 11, 12, 13, 15, 18, 25]) sets.push([`blind-scores-r${r}.md`, `blind-key-r${r}.json`]);
const keyToId = k => { const r = String(k.round).replace(/^R/, ''); return `R${r}/c${k.cell}/a${k.arm}`; };
let scored = 0;
for (const [sf, kf] of sets) {
  if (!fs.existsSync(D + sf) || !fs.existsSync(D + kf)) continue;
  const key = JSON.parse(fs.readFileSync(D + kf)); const kmap = Object.fromEntries(key.map(k => [k.id, k]));
  for (const m of fs.readFileSync(D + sf, 'utf8').matchAll(/^\|\s*(B\d+)\s*\|\s*(\d)\s*\|\s*(.*?)\s*\|\s*$/gm)) {
    const k = kmap[m[1]]; if (!k) continue;
    let id = keyToId(k); let it = ideas[id];
    if (!it) { const alt = Object.keys(ideas).find(x => x === id.replace('/c', 'b/c')); it = ideas[alt]; }
    if (!it) { console.log('no idea for', sf, m[1], id); continue; }
    (it.blind = it.blind || []).push({ set: sf, score: Number(m[2]), why: m[3] }); scored++;
  }
}
// draft-vs-final scores (round 7)
const dk = JSON.parse(fs.readFileSync(D + 'draft-vs-final-key.json'));
const dvs = fs.readFileSync(D + 'draft-vs-final-scores.md', 'utf8');
for (const m of dvs.matchAll(/^\|\s*(C\d+A\d)\s*\|\s*(\d)\s*\|\s*(\d)\s*\|\s*(\d)\s*\|\s*(\d)\s*\|\s*(.*?)\s*\|$/gm)) {
  const k = dk.find(x => x.id === m[1]); if (!k) continue;
  const cell = k.cell, arm = k.arm; let it = ideas[`R7/c${cell}/a${arm}`] || ideas[`R7b/c${cell}/a${arm}`];
  if (!it) { console.log('dvf no idea', m[1]); continue; }
  const A = k.A, B = k.B; it.dvf = { [A]: { buy: Number(m[2]), contract: Number(m[3]) }, [B]: { buy: Number(m[4]), contract: Number(m[5]) }, note: m[6] };
}
const list = Object.values(ideas);
fs.writeFileSync(OUT + 'ideas.jsonl', list.map(x => JSON.stringify(x)).join('\n'));
const { createHash } = require('crypto');
console.log('ideas', list.length, 'with blind', list.filter(x => x.blind).length, 'blind rows', scored, 'dvf', list.filter(x => x.dvf).length);
const same = list.filter(x => x.draft.replace(/\s+/g, ' ') === x.final.replace(/\s+/g, ' ')).length;
console.log('draft==final', same);
const byModel = {}; for (const x of list) byModel[x.model] = (byModel[x.model] || 0) + 1; console.log(byModel);
