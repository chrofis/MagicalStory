#!/usr/bin/env node
/**
 * Replays the WIRED path (jevPagePresence.rejectedScanCandidates + unionPageCast) over every stored page where
 * the metadata cast is empty and the name scan found a roster name (the only pages the production code asks Jev
 * about). Reports per page: cast before (old scan), cast after, and the label (metadata / plan who column).
 *   node --max-old-space-size=1024 scripts/analysis/replay-page-presence-wired.js [--capUsd=0.05]
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { rejectedScanCandidates } = require('../../server/lib/jevPagePresence');
const { unionPageCast } = require('../../server/lib/sceneMetadata');
const RUN = path.join(ROOT, 'evals/runs/2026-11-04_garment-owner-jev');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(RUN, 'cases.json'), 'utf8')).filter(c => c.trigger);
  const pages = new Map();
  for (const c of cases) { const k = `${c.story}#${c.page}`; if (!pages.has(k)) pages.set(k, []); pages.get(k).push(c); }
  const out = [];
  for (const [k, cs] of pages) {
    const roster = cs[0].roster.map(name => ({ name }));
    // the stored brief is not in cases.json with its metadata block; the prose is what the page's scan ran over
    const desc = cs[0].prose;
    const before = unionPageCast(desc, [], roster).map(c => c.name);
    const notDrawn = await rejectedScanCandidates(desc, [], roster);
    const after = unionPageCast(desc, [], roster, { notDrawn }).map(c => c.name);
    out.push({ page: k, before, after, dropped: before.filter(n => !after.includes(n)), labelDrawn: cs.filter(c => c.drawn).map(c => c.name) });
  }
  fs.writeFileSync(path.join(RUN, 'wired-replay.json'), JSON.stringify(out, null, 1));
  for (const o of out) console.log(o.page.slice(-16), 'before', o.before.join('|'), 'after', o.after.join('|'));
  console.log('pages', out.length, 'pages whose cast changed', out.filter(o => o.dropped.length).length);
})().catch(e => { console.error(e.message); process.exit(1); });
