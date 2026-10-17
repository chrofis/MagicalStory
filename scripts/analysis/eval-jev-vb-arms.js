#!/usr/bin/env node
/** Jev flags (same question as eval-jev-object-placement.js) on the old/new replay arms; prints the flagged rows for hand reading. */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const { callJev } = require('../../server/lib/jevAudit');
const RUN = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-10-17_vb-object-not-placed');
const Q = JSON.parse(fs.readFileSync(path.join(RUN, 'jev-scores.json'), 'utf8')).question;
(async () => {
  const out = [];
  const ids = [...new Set(fs.readdirSync(RUN).filter(f => /__old\.json$/.test(f)).map(f => f.replace('__old.json', '')))];
  for (const id of ids) {
    const o = JSON.parse(fs.readFileSync(path.join(RUN, id + '__old.json'), 'utf8'));
    const nf = path.join(RUN, id + '__new.json');
    if (!fs.existsSync(nf)) continue;
    const n = JSON.parse(fs.readFileSync(nf, 'utf8'));
    if (!o.rows || !o.rows.length || !n.rows || !n.rows.length) continue;
    for (const [arm, j] of [['old', o], ['new', n]]) for (const r of j.rows) {
      const a = await callJev({ state: `Description of one object in a children's picture book: ${r.description}`, questions: { PLACED: { type: 'noul', instructions: Q } } });
      out.push({ story: id, arm, id: r.id, name: r.name, jev: a.answers.PLACED.noul, description: r.description });
    }
  }
  fs.writeFileSync(path.join(RUN, 'arms-jev.json'), JSON.stringify(out, null, 1));
  for (const arm of ['old', 'new']) { const a = out.filter(x => x.arm === arm); console.log(arm, 'rows', a.length, 'jev>=0.5', a.filter(x => x.jev >= 0.5).length); }
})().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
