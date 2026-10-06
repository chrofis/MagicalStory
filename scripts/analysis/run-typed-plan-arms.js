#!/usr/bin/env node
/**
 * Fire ONE typed-plan experiment arm on the staging Test Lab and save its raw result.
 * Arms (docs/decisions.md "Typed page plan"): stored | today | typed, on stage beats_replan.
 *   TOKEN=$(node scripts/admin/get-admin-token.js) node scripts/analysis/run-typed-plan-arms.js <arm> <storyId>
 * Raw JSON lands in evals/runs/2026-10-06_typed-plan/<arm>_<storyId>.json.
 */
const fs = require('fs');
const path = require('path');
const [arm, storyId] = process.argv.slice(2);
const BASE = process.env.BASE || 'https://staging.magicalstory.ch';
const PARAMS = {
  stored: { measureStored: true },
  today: { planFresh: true, planModel: 'claude-sonnet-5-5' },
  typed: { typedPlan: true, planModel: 'claude-sonnet-5-5' },
};
(async () => {
  if (!PARAMS[arm] || !storyId) throw new Error('usage: <stored|today|typed> <storyId>');
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TOKEN}` };
  const res = await fetch(`${BASE}/api/admin/testlab/experiments`, { method: 'POST', headers: H, body: JSON.stringify({
    stage: 'beats_replan', label: `typed-plan ${arm} ${storyId}`, params: PARAMS[arm], targets: [{ storyId, pageNumber: 1 }] }) });
  const out = await res.json();
  if (!res.ok) throw new Error(`POST ${res.status} ${JSON.stringify(out)}`);
  const id = out.id || out.experimentId || (out.experiment && out.experiment.id);
  console.log('experiment', id);
  for (;;) {
    await new Promise(r => setTimeout(r, 15000));
    const g = await (await fetch(`${BASE}/api/admin/testlab/experiments/${id}`, { headers: H })).json();
    const e = g.experiment || g;
    if (e.status && e.status !== 'running') {
      const dir = path.join(__dirname, '../../evals/runs/2026-10-06_typed-plan');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${arm}_${storyId}.json`), JSON.stringify({ id, arm, storyId, ...e }, null, 1));
      console.log('done', e.status);
      return;
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
