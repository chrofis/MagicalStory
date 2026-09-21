// Builds a blind set (anonymous ids) + key from two rounds.
//   node make-blind.js                      → rounds 1,7 (7b overrides cell 6) → blind-set.md / blind-key.json
//   node make-blind.js --rounds=1,8         → blind-set-r8.md / blind-key-r8.json
//   node make-blind.js --rounds=1,10,15     → 60 texts, ONE shuffle → blind-set-r15.md
// Any number of rounds: the set is one shuffle over all of them, so a reader
// cannot tell a round from its position.
// Rate each idea on ONE axis, without the key: would a Swiss parent buy this book.
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const argRounds = (process.argv.find(a => a.startsWith('--rounds=')) || '').split('=')[1];
const rounds = argRounds ? argRounds.split(',').map(s => s.trim()) : ['1', '7'];

// Some rounds were partially re-run into a `<n>b` file that replaces specific cells.
const OVERRIDES = { '7': { file: 'round-7b.json', cells: [6] } };

function load(f) { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }

// The cell's own facts, carried into the KEY (never into the blind set) so the
// read can be broken down by category, by age band and by cast size without a
// second join. The band is the MAIN character's age: the youngest `isMain`, or
// the youngest of the cast when none is flagged.
function ageBand(age) {
  if (!Number.isFinite(age)) return 'unknown';
  if (age <= 2) return '0-2';
  if (age <= 5) return '3-5';
  if (age <= 9) return '6-9';
  return '10-12';
}
function cellFacts(cell) {
  const chars = cell.characters || [];
  const mains = chars.filter(c => c.isMain);
  const pool = (mains.length ? mains : chars).map(c => Number(c.age)).filter(Number.isFinite);
  const mainAge = pool.length ? Math.min(...pool) : null;
  return {
    category: cell.storyCategory || 'adventure',
    theme: cell.storyTheme || null,
    topic: cell.storyTopic || null,
    mainAge,
    ageBand: ageBand(mainAge),
    castSize: chars.length,
  };
}

function armsOf(round, label) {
  const out = [];
  for (const c of round.cells) {
    const facts = cellFacts(c.cell);
    for (const idea of c.ideas) {
      out.push({ round: label, cell: c.cell.id, arm: idea.index, world: idea.world, ...facts, text: idea.final.trim() });
    }
  }
  return out;
}

function roundArms(n) {
  const label = 'R' + n;
  let arms = armsOf(load(`round-${n}.json`), label);
  const ov = OVERRIDES[n];
  if (ov) {
    const repl = armsOf(load(ov.file), label).map((a, i) => ({ ...a, cell: ov.cells[Math.floor(i / 2)] }));
    arms = arms.filter(a => !ov.cells.includes(a.cell)).concat(repl);
  }
  return arms;
}

const all = rounds.flatMap(roundArms);
if (all.length !== 20 * rounds.length) throw new Error(`expected ${20 * rounds.length} arms, got ` + all.length);

// Deterministic shuffle: mulberry32 with a fixed seed.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260921); // fixed seed, shared by every round pair
for (let i = all.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [all[i], all[j]] = [all[j], all[i]];
}

// Round labels are not always integers (--round=opus). A numeric label keeps the
// historical `-rN` suffix; a named one is used verbatim.
const last = rounds[rounds.length - 1];
const suffix = argRounds && argRounds !== '1,7' ? (/^\d+$/.test(last) ? '-r' + last : '-' + last) : '';
const key = [];
let md = `# Blind set — ${all.length} story-idea back-cover texts\n\nRate each on ONE axis: would a Swiss parent buy this book for their child (1-5).\n\n`;
all.forEach((a, i) => {
  const id = 'B' + String(i + 1).padStart(2, '0');
  key.push({ id, round: a.round, cell: a.cell, arm: a.arm, world: a.world,
    category: a.category, theme: a.theme, topic: a.topic, mainAge: a.mainAge, ageBand: a.ageBand, castSize: a.castSize });
  md += `## ${id}\n\n${a.text}\n\n`;
});

fs.writeFileSync(path.join(dir, `blind-set${suffix}.md`), md);
fs.writeFileSync(path.join(dir, `blind-key${suffix}.json`), JSON.stringify(key, null, 1));
console.log(`wrote blind-set${suffix}.md (${all.length}) and blind-key${suffix}.json`);
