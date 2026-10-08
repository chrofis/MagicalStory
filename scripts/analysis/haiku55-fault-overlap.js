#!/usr/bin/env node
/**
 * Overlap of FAULT lines between two audit_replay experiment results
 * (evals/runs/2026-10-08_haiku55/lab/<id>.json, written by haiku55-summarize-lab.js).
 * A fault matches when it names the same page and shares its category or >=3
 * words of 6+ letters. Not ground truth: it measures how much of one auditor's
 * list the other reproduces.
 *   node scripts/analysis/haiku55-fault-overlap.js <refId> <candId>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dir = path.resolve(__dirname, '..', '..', 'evals', 'runs', '2026-10-08_haiku55', 'lab');
const load = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).results;
const parse = (l) => {
  const m = String(l).match(/^FAULT\[([A-Z_]+)\]:\s*(?:p(\d+)|page (\d+))?\s*[—-]?\s*(.*)$/s);
  if (!m) return null;
  const words = new Set((m[4].toLowerCase().match(/[a-zäöüéèà]{6,}/g) || []));
  return { cat: m[1], page: Number(m[2] || m[3]) || null, text: m[4], words };
};
const match = (a, b) => {
  if (a.page !== b.page) return false;
  // STYLE lines are many per page: the category alone proves nothing, the quoted sentence must be shared.
  if (a.cat === b.cat && a.cat !== 'STYLE') return true;
  let n = 0; for (const w of a.words) if (b.words.has(w)) n++;
  return n >= (a.cat === 'STYLE' && b.cat === 'STYLE' ? 2 : 3);
};
const [refId, candId] = process.argv.slice(2);
const ref = load(refId), cand = load(candId);
let totRef = 0, totCand = 0, refHit = 0, candHit = 0;
for (const r of ref) {
  const c = cand.find(x => x.storyId === r.storyId);
  if (!c) continue;
  const rf = r.runs.flatMap(x => x.faultLines || []).map(parse).filter(Boolean);
  const cf = c.runs.flatMap(x => x.faultLines || []).map(parse).filter(Boolean);
  const rh = rf.filter(a => cf.some(b => match(a, b))).length;
  const ch = cf.filter(b => rf.some(a => match(a, b))).length;
  console.log(`${r.storyId}: ref ${rf.length} (reproduced ${rh}) cand ${cf.length} (also in ref ${ch})`);
  totRef += rf.length; totCand += cf.length; refHit += rh; candHit += ch;
}
console.log(`TOTAL ref ${totRef} reproduced ${refHit} (${(100 * refHit / totRef).toFixed(0)}%); cand ${totCand} also in ref ${candHit} (${(100 * candHit / totCand).toFixed(0)}%)`);
