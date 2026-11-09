#!/usr/bin/env node
/**
 * Replay of the Jev citation question (jevDecisions.vbQuestion) over stored stories whose Visual Bible gave an
 * unnamed figure an invented name or split a group (docs/decisions.md 2026-11-09 "Visual Bible: name or role").
 *
 *   OLD  the question built from the stored bible name (what ran in production).
 *   NEW  the question built by the shipped vbQuestion from the bible the new rule asks for: the role noun and
 *        `count`. A stand-in writes that bible (CASES below); the real writer is the paid half
 *        (scripts/analysis/vb-name-or-role-writer-rerun.js, not run).
 *
 * Truth label per (page, figure): the page's stored plan line (who column and instant) names the role noun as a
 * whole word, singular or plural. This labels the eval only; no product code reads it.
 * Free to read (SELECT only), ~USD 0.01 of Jev calls. Needs OPENROUTER_API_KEY, STAGING_DATABASE_URL, DATABASE_URL.
 *
 *   node scripts/analysis/vb-name-or-role-replay.js [--out evals/runs/2026-11-09_vb-name-or-role]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const JD = require('../../server/lib/jevDecisions');
const J = require('../../server/lib/jevAudit');
const { canonicalName } = require('../../server/lib/castResolver');

// stored story → the figures the new rule would merge or rename. `old` = ids whose stored names are replaced by `next`.
const CASES = [
  { db: 'DATABASE_URL', id: 'job_1794231161354_l3n2o3afm', pool: 'animals', old: ['ANI001', 'ANI002', 'ANI003'], next: { id: 'ANI001', name: 'bog monster', count: 3 }, truthWord: 'monster' },
  { db: 'STAGING_DATABASE_URL', id: 'job_1791145238223_50osg2osm', pool: 'secondaryCharacters', old: ['CHR003', 'CHR004'], next: { id: 'CHR003', name: 'soldier', count: 2 }, truthWord: 'soldier' },
  { db: 'STAGING_DATABASE_URL', id: 'job_1788471969309_9cg9dqyirre', pool: 'secondaryCharacters', old: ['CHR002'], next: { id: 'CHR002', name: 'net mender', count: 2 }, truthWord: 'net mender' },
];

const T = { animals: 0.7, secondaryCharacters: 0.5 }; // JEV_DECISIONS.vb.creature / .secondary — the citation bars
const typeOf = pool => (pool === 'animals' ? 'creature' : 'secondary');

// The question exactly as it read before 2026-11-09 (git show 2c426a026:server/lib/jevDecisions.js, vbQuestion).
function oldQuestion(e) {
  return `${e.name}${e.species ? `, the ${e.species}` : ''} (${e.desc.slice(0, 140)}) is in the picture of the page to judge, wholly or in part: the page's text or its picture plan puts it in the scene at that moment.`;
}

const planParts = pl => String(pl || '').replace(/^\s*PLAN:\s*/i, '').split(' — ');
const hasWord = (text, word) => new RegExp(`(?<![\\p{L}])${word}s?(?![\\p{L}])`, 'iu').test(text);

async function main() {
  const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'evals/runs/2026-11-09_vb-name-or-role');
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  let cost = 0; let calls = 0;
  for (const c of CASES) {
    const pool = new Pool({ connectionString: process.env[c.db], ssl: { rejectUnauthorized: false } });
    const { rows: [row] } = await pool.query('select data from stories where id=$1', [c.id]);
    await pool.end();
    const d = row.data;
    const pages = d.sceneDescriptions.map((s, i) => ({ pageNumber: i + 1, planLine: s.outlineExtract }));
    const arc = d.arcReviewReport.finalArc;
    const oldBible = d.visualBible;
    const oldEls = JD.vbElements({ [c.pool]: oldBible[c.pool].filter(e => c.old.includes(e.id)) })
      .filter(e => e.type === typeOf(c.pool));
    const first = oldBible[c.pool].find(e => e.id === c.next.id);
    const newEntry = { ...first, name: c.next.name, count: c.next.count, label: '' };
    const newEls = JD.vbElements({ [c.pool]: [newEntry] }).filter(e => e.type === typeOf(c.pool));
    for (const p of pages) {
      const parts = planParts(p.planLine);
      const truth = hasWord(`${parts[1] || ''} ${parts[2] || ''}`, c.truthWord);
      const state = JD.pageState(arc, pages, p);
      const questions = {};
      oldEls.forEach((e, i) => { questions[`O${i}`] = { type: 'noul', instructions: oldQuestion(e) }; });
      newEls.forEach((e, i) => { questions[`N${i}`] = { type: 'noul', instructions: JD.vbQuestion(e) }; });
      const r = await J.callJev({ state, questions });
      cost += r.cost; calls++;
      const oldP = oldEls.map((_, i) => J.yesProb(r.answers[`O${i}`]));
      const newP = newEls.map((_, i) => J.yesProb(r.answers[`N${i}`]));
      rows.push({ story: c.id, page: p.pageNumber, truth, oldNames: oldEls.map(e => e.name), oldP, oldMaxP: Math.max(...oldP), newName: newEls[0].name, newQuestion: JD.vbQuestion(newEls[0]), newP: newP[0], bar: T[c.pool], oldCited: Math.max(...oldP) >= T[c.pool], newCited: newP[0] >= T[c.pool] });
    }
  }
  fs.writeFileSync(path.join(outDir, 'replay-raw.json'), JSON.stringify({ cost, calls, rows }, null, 2));
  const pos = rows.filter(r => r.truth); const neg = rows.filter(r => !r.truth);
  const rate = (a, k) => (a.length ? +(a.filter(r => r[k]).length / a.length).toFixed(3) : null);
  const mean = (a, k) => (a.length ? +(a.reduce((s, r) => s + r[k], 0) / a.length).toFixed(3) : null);
  const summary = {
    pages: rows.length, positives: pos.length, negatives: neg.length, calls, cost_usd: +cost.toFixed(4),
    oldPositiveCitedRate: rate(pos, 'oldCited'), newPositiveCitedRate: rate(pos, 'newCited'),
    oldNegativeCitedRate: rate(neg, 'oldCited'), newNegativeCitedRate: rate(neg, 'newCited'),
    oldPositiveMeanMaxP: mean(pos, 'oldMaxP'), newPositiveMeanP: mean(pos, 'newP'),
    oldNegativeMeanMaxP: mean(neg, 'oldMaxP'), newNegativeMeanP: mean(neg, 'newP'),
    perStory: Object.fromEntries(CASES.map(c => {
      const a = rows.filter(r => r.story === c.id); const ap = a.filter(r => r.truth); const an = a.filter(r => !r.truth);
      return [c.id, { pages: a.length, pos: ap.length, oldPosRate: rate(ap, 'oldCited'), newPosRate: rate(ap, 'newCited'), oldNegRate: rate(an, 'oldCited'), newNegRate: rate(an, 'newCited') }];
    })),
  };
  fs.writeFileSync(path.join(outDir, 'replay-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
