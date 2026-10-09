/**
 * Build the card pool for the Jev idea-rubric measurement: every FINAL trial
 * card of the 2026-10-09 coherence run (before / after / rule-only arms, with
 * the existing forced/follows hand labels) plus today's owner trial cards.
 * Output: evals/runs/2026-10-09_jev-idea-rubric/pool.json (real id -> card) and
 * blind.txt (shuffled, arm and scores hidden) for labelling.
 */
const fs = require('fs');
const path = require('path');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_trial-idea-coherence');
const OUT = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-rubric');
const pool = [];
for (const arm of ['before', 'after', 'ruleonly']) {
  const out = JSON.parse(fs.readFileSync(path.join(RUN, `trial-${arm}`, 'out.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(RUN, `labels-trial-${arm}.json`), 'utf8'));
  for (const r of out.rows) for (const world of ['local', 'fantasy']) {
    const c = r.cards[world]; if (!c || !c.final) continue;
    const key = `${r.cell.id}.${world}`;
    pool.push({ id: `${arm}.${key}`, arm, cellId: r.cell.id, world, cell: r.cell, text: c.final.trim(), lab: labels[key] || null });
  }
}
// today's owner trial (staging idea_events, user 880b53c1...): topic cleaning-up, superhero, age 8, Zurich
const owner = JSON.parse(fs.readFileSync(path.join(OUT, 'owner-cards.json'), 'utf8'));
owner.forEach((t, i) => pool.push({ id: `owner.${i}`, arm: 'owner', cellId: 'owner', world: i ? 'fantasy' : 'local',
  cell: { name: 'Lukas', age: 8, gender: 'male', language: 'de-ch', category: 'life-challenge', topic: 'cleaning-up', theme: 'superhero', town: 'Zürich' }, text: t, lab: null }));
let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const order = pool.map((_, i) => i).sort(() => rnd() - 0.5);
pool.forEach((p, i) => { p.blind = 'b' + String(order.indexOf(i) + 1).padStart(3, '0'); });
fs.writeFileSync(path.join(OUT, 'pool.json'), JSON.stringify(pool, null, 1));
const blind = [...pool].sort((a, b) => a.blind.localeCompare(b.blind))
  .map(p => `${p.blind} | age ${p.cell.age} ${p.cell.gender} ${p.cell.language} | ${p.cell.category === 'life-challenge' ? 'topic=' + p.cell.topic : 'adventure'} | theme=${p.cell.theme || '-'} | ${p.cell.town || 'no town'}\n${p.text}\n`).join('\n');
fs.writeFileSync(path.join(OUT, 'blind.txt'), blind);
console.log('pool', pool.length);
