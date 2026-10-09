#!/usr/bin/env node
/**
 * Does naming the figure by a short descriptor (apparent age, gender, hair colour) fix the outfit question on prose that
 * describes a character WITHOUT their name? Tests variant E6 against E on both hand-labelled sets (stored prompt prose:
 * jev-clothing-labels.json; Art Director briefs: the lists in eval-jev-outfit-briefs-variants.js).
 *   node scripts/analysis/eval-jev-outfit-descriptor.js [--capUsd=0.05]
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { callJev } = require('../../server/lib/jevAudit');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);
const M = [186, 187, 194, 195, 199, 200, 201];
const S = [9, 13, 14, 15, 90, 92, 96, 101, 102, 103, 112, 114, 124, 133, 137, 138, 139, 148, 150, 151, 152, 165, 197];
const describe = ch => {
  const p = ch.physical || {};
  const g = /^f/i.test(ch.gender || '') ? 'girl' : /^m/i.test(ch.gender || '') ? 'boy' : 'person';
  const adult = /adult|senior|elder|teen/i.test(p.apparentAge || '') || Number(ch.age) >= 13;
  const noun = adult ? (g === 'girl' ? 'woman' : g === 'boy' ? 'man' : 'person') : g;
  return `${p.apparentAge || ''} ${noun}${p.hairColor ? ` with ${p.hairColor} hair` : ''}`.trim();
};
const E6 = (c, who) => ({ type: 'choice', instructions: `What the text says ${c.name} (${who}) wears. The text may describe ${c.name} without using the name.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'clothing that differs from that outfit', s2: 'nothing, the text does not say' } });
const E = c => ({ type: 'choice', instructions: `What the text says ${c.name} wears.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'clothing that differs from that outfit', s2: 'nothing, the text does not say' } });
(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const chars = {}; // sid -> name -> descriptor
  const fetchChars = async sids => {
    const rows = (await pool.query(`SELECT id, data->'characters' ch FROM stories WHERE right(id, 9) = ANY($1)`, [sids])).rows;
    for (const r of rows) { chars[r.id.slice(-9)] = {}; for (const c of r.ch || []) chars[r.id.slice(-9)][c.name] = describe(c); }
  };
  const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing/cases.json'), 'utf8'));
  const B = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-outfit-briefs/cases.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, 'jev-clothing-labels.json'), 'utf8'));
  const byKey = new Map(A.map(c => [`${c.sid}:${c.page}:${c.name}`, c]));
  const setA = labels.map(l => ({ c: byKey.get(l.key), miss: l.label === 1 })).filter(x => x.c);
  const setB = [...M.map(i => ({ c: B[i], miss: true })), ...S.map(i => ({ c: B[i], miss: false }))];
  await fetchChars([...new Set([...setA, ...setB].map(x => x.c.sid))]);
  let cost = 0; const out = { A: { E: [], E6: [] }, B: { E: [], E6: [] } };
  for (const [nm, set] of [['A', setA], ['B', setB]]) for (const x of set) {
    if (cost > cap) throw new Error('cap');
    const who = (chars[x.c.sid] || {})[x.c.name] || 'person';
    for (const [v, q] of [['E', E(x.c)], ['E6', E6(x.c, who)]]) {
      const r = await callJev({ state: x.c.prose, questions: { q } }); cost += r.cost;
      out[nm][v].push({ miss: x.miss, p: r.answers.q.probabilities.s0 });
    }
  }
  console.log('cost USD', cost.toFixed(5));
  for (const nm of ['A', 'B']) for (const v of ['E', 'E6']) {
    const rows = out[nm][v]; const pos = rows.filter(r => r.miss), neg = rows.filter(r => !r.miss);
    const t = [0.1, 0.3].map(th => `<${th}: caught ${pos.filter(r => r.p < th).length}/${pos.length}, false ${neg.filter(r => r.p < th).length}/${neg.length}`);
    console.log(`set ${nm} ${v}: ${t.join(' | ')}`);
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
