#!/usr/bin/env node
/**
 * Fire ONE Test Lab experiment of the Haiku 5.5 bake-off (docs/decisions.md
 * 2026-10-08, round 2) on staging and wait for it. Prints the experiment id and
 * the status; the numbers come from haiku55-summarize-lab.js.
 *
 *   node scripts/analysis/haiku55-lab-run.js <stage> <label> '<paramsJson>' <storyId>[,<storyId>...]
 * e.g.  ... audit_replay "Haiku 5.5 blind xhigh r1" '{"level":"text-blind","effort":"xhigh","models":"claude-haiku-5-5","fromWriterText":true}' job_1790100385959_1nitlympp
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const BASE = process.env.LAB_BASE || 'https://staging.magicalstory.ch';
(async () => {
  const [stage, label, paramsJson, stories] = process.argv.slice(2);
  const token = execFileSync('node', [path.resolve(__dirname, '../admin/get-admin-token.js')]).toString().trim();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const res = await fetch(`${BASE}/api/admin/testlab/experiments`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ stage, label, params: JSON.parse(paramsJson), targets: stories.split(',').map(storyId => ({ storyId })) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(res.status, JSON.stringify(out)); process.exit(1); }
  const id = out.id || out.experimentId || out.experiment?.id;
  console.log('experiment', id);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const g = await fetch(`${BASE}/api/admin/testlab/experiments/${id}`, { headers: H });
    const e = await g.json().catch(() => ({}));
    const st = e.status || e.experiment?.status;
    if (st && st !== 'running' && st !== 'pending') { console.log('done', id, st); process.exit(0); }
  }
  console.log('timeout waiting for', id); process.exit(2);
})().catch(e => { console.error(e); process.exit(1); });
