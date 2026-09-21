// Opens the key and scores a blind set.
//   node analyze-blind.js                    → blind-key.json + blind-scores.md      (R1 vs R7)
//   node analyze-blind.js --rounds=1,8       → blind-key-r8.json + blind-scores-r8.md
//   node analyze-blind.js --rounds=1,10,15   → three rounds, 60 texts, one key
//
// Any number of rounds. Beyond the per-round mean and distribution it prints the
// breakdowns the owner asked for on 2026-09-21 — by CATEGORY, by ARM, by WORLD,
// by the main character's AGE BAND and by CAST SIZE — for every round side by
// side, because the round-10 read split on axes the round mean hides (arm 2 at
// 3.70 against arm 1's 4.10; fantasy 3.63 against location 4.08, the two
// perfectly confounded). Breakdown facts come from the KEY, which make-blind.js
// carries over from each round's own cell definition.
const fs = require('fs');
const argRounds = (process.argv.find(a => a.startsWith('--rounds=')) || '').split('=')[1];
const rounds = argRounds ? argRounds.split(',').map(s => 'R' + s.trim()) : ['R1', 'R7'];
const last = rounds[rounds.length - 1].slice(1);
const suffix = argRounds && argRounds !== '1,7' ? (/^\d+$/.test(last) ? '-r' + last : '-' + last) : '';
const key = JSON.parse(fs.readFileSync(`blind-key${suffix}.json`, 'utf8'));
const md = fs.readFileSync(`blind-scores${suffix}.md`, 'utf8');
const scores = {};
for (const m of md.matchAll(/^\| (B\d\d) \| (\d) \|/gm)) scores[m[1]] = +m[2];
const byId = Object.fromEntries(key.map(k => [k.id, k]));

const missing = key.filter(k => scores[k.id] === undefined).map(k => k.id);
if (missing.length) console.log(`WARNING: ${missing.length} unscored id(s): ${missing.join(', ')}\n`);

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const dist = a => [1, 2, 3, 4, 5].map(v => v + ':' + a.filter(x => x === v).length).join(' ');
const fmt = a => a.length ? `${mean(a).toFixed(2)} (n=${a.length})` : '   -   ';

const rows = Object.keys(scores).map(id => ({ ...byId[id], score: scores[id] }));
const ofRound = r => rows.filter(x => x.round === r);

// ---- overall ----
for (const r of rounds) {
  const a = ofRound(r).map(x => x.score);
  console.log(`${r} n=${a.length} mean=${mean(a).toFixed(2)}  fives=${a.filter(x => x === 5).length}  dist ${dist(a)}`);
}
const A = rounds[0], B = rounds[rounds.length - 1];
console.log(`diff ${B}-${A} = ${(mean(ofRound(B).map(x => x.score)) - mean(ofRound(A).map(x => x.score))).toFixed(2)}`);

// ---- breakdowns: one table per axis, rounds as columns ----
function table(title, valueOf, order) {
  const values = order || [...new Set(rows.map(valueOf))].sort();
  console.log(`\n### by ${title}`);
  console.log(['group'.padEnd(16), ...rounds.map(r => r.padEnd(12))].join(''));
  for (const v of values) {
    const cells = rounds.map(r => fmt(rows.filter(x => x.round === r && valueOf(x) === v).map(x => x.score)).padEnd(12));
    console.log([String(v).padEnd(16), ...cells].join(''));
  }
}
table('category', x => x.category, ['adventure', 'life-challenge', 'historical']);
table('arm', x => 'arm ' + x.arm, ['arm 1', 'arm 2']);
table('world', x => x.world, ['location', 'fantasy']);
table('age band', x => x.ageBand, ['0-2', '3-5', '6-9', '10-12']);
table('cast size', x => x.castSize);
table('pages', x => x.pages);

// ---- paired by cell+arm ----
const pair = {};
for (const x of rows) {
  const pk = x.cell + '-' + x.arm;
  (pair[pk] = pair[pk] || {})[x.round] = x.score;
}
console.log(`\n### paired by cell-arm (intersection of the rounds cell sets)\ncell-arm  ${rounds.join('  ')}`);
const tally = Object.fromEntries(rounds.slice(0, -1).map(r => [r, { w: 0, l: 0, t: 0 }]));
for (const pk of Object.keys(pair).sort((a, b) => {
  const [x, y] = a.split('-').map(Number), [u, v] = b.split('-').map(Number);
  return x - u || y - v;
})) {
  const p = pair[pk];
  console.log(pk.padEnd(9), rounds.map(r => (p[r] === undefined ? '-' : p[r])).join('   '));
  for (const r of rounds.slice(0, -1)) {
    if (p[B] === undefined || p[r] === undefined) continue;
    if (p[B] > p[r]) tally[r].w++; else if (p[B] < p[r]) tally[r].l++; else tally[r].t++;
  }
}
for (const r of rounds.slice(0, -1)) {
  console.log(`\n${B} vs ${r}: wins ${tally[r].w}, loses ${tally[r].l}, ties ${tally[r].t}`);
}
