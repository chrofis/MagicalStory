// Blind assignment: every prompt (story x arm) gets a random file name; every agent gets stories only once
// (never both arms of one story) and a mix of old and new. usage: node assign-blind.js <runDir> <perAgent>
const fs = require('fs'); const path = require('path');
const [dir, perAgent] = [process.argv[2], parseInt(process.argv[3], 10) || 5];
let seed = 20261107; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).manifest;
const out = {};
for (const f of ['F1', 'F2', 'F3']) {
  const items = [];
  for (const m of man[f]) for (const arm of ['old', 'new']) items.push({ k: m.k, arm });
  // two groups of stories: group 1 = old goes to half A, new to half B; alternate by shuffled story order
  const stories = shuffle(man[f].map(m => m.k));
  const half = new Set(stories.slice(0, Math.ceil(stories.length / 2)));
  const poolA = shuffle(items.filter(i => (half.has(i.k) ? i.arm === 'old' : i.arm === 'new')));
  const poolB = shuffle(items.filter(i => !(half.has(i.k) ? i.arm === 'old' : i.arm === 'new')));
  const n = Math.ceil(items.length / perAgent);
  const agents = Array.from({ length: n }, () => []);
  // fill agents alternately from the two pools so each agent mixes old and new and no agent sees a story twice
  let ai = 0; const seen = agents.map(() => new Set());
  const place = (it) => { for (let t = 0; t < n; t++) { const a = (ai + t) % n; if (!seen[a].has(it.k) && agents[a].length < perAgent) { agents[a].push(it); seen[a].add(it.k); ai = (a + 1) % n; return; } } throw new Error('cannot place ' + it.k); };
  const interleaved = []; for (let i = 0; i < Math.max(poolA.length, poolB.length); i++) { if (poolA[i]) interleaved.push(poolA[i]); if (poolB[i]) interleaved.push(poolB[i]); }
  interleaved.forEach(place);
  fs.mkdirSync(path.join(dir, f, 'blind'), { recursive: true });
  const map = {}; let c = 0; const batches = [];
  for (const ag of agents) {
    const names = [];
    for (const it of shuffle(ag)) { const nm = 'p' + String(++c).padStart(2, '0'); map[nm] = it; names.push(nm); fs.copyFileSync(path.join(dir, f, it.arm, it.k + '.txt'), path.join(dir, f, 'blind', nm + '.txt')); }
    batches.push(names);
  }
  fs.writeFileSync(path.join(dir, f, 'blind-map.json'), JSON.stringify(map, null, 1));
  fs.writeFileSync(path.join(dir, f, 'batches.json'), JSON.stringify(batches));
  out[f] = { prompts: c, agents: batches.length, oldNew: batches.map(b => [b.filter(x => map[x].arm === 'old').length, b.filter(x => map[x].arm === 'new').length]) };
}
console.log(JSON.stringify(out));
