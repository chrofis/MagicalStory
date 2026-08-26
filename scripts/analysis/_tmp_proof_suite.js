// Composite proof suite — three sequential scene_composite runs (~$0.18 total).
// A: regression, watercolor, 5 chars (good under the old blend prompt)
// B: regression, pixar, 3 back-view background chars (pose resolver live test)
// C: the dragon flat-lineup page (pose + compound-action + creature fixes)
// A refusal is a recorded outcome, not a suite failure. Two ERROR results stop
// the suite (burn-loop rule).
const { execSync } = require('child_process');
const { ch } = require('../lib/chTime');

const BASE = 'https://staging.magicalstory.ch';
const TARGETS = [
  { key: 'A', storyId: 'job_1786567053374_8ktpkfhec', page: 4,  label: 'proof A — regression watercolor 5-char (good under old prompt)' },
  { key: 'B', storyId: 'job_1786571353564_0sgrd0f4g', page: 10, label: 'proof B — regression pixar, 3 back-view bg chars (pose resolver live)' },
  { key: 'C', storyId: 'job_1787262655143_s9zb960muni', page: 17, label: 'proof C — dragon page: pose + compound action + creature in one plate' },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const health = async () => { try { return (await (await fetch(`${BASE}/api/health`)).json()).commit; } catch { return null; } };

(async () => {
  const token = execSync('node scripts/admin/get-admin-token.js').toString().trim();
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  let errors = 0;
  const ids = [];

  for (const t of TARGETS) {
    // launch, retrying through the single-flight latch
    let res, body;
    for (let attempt = 1; attempt <= 40; attempt++) {
      res = await fetch(`${BASE}/api/admin/testlab/experiments`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          stage: 'scene_composite', label: t.label,
          targets: [{ storyId: t.storyId, pageNumber: t.page }],
          params: { strategy: 'uniform' },
        }),
      });
      body = await res.json();
      if (res.status !== 409) break;
      if (attempt % 5 === 1) console.log(`${ch(new Date())}  [${t.key}] latch held (attempt ${attempt})`);
      await sleep(45_000);
    }
    if (!res.ok) {
      console.log(`${ch(new Date())}  [${t.key}] LAUNCH FAILED ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      errors++;
      if (errors >= 2) { console.log('BURN-LOOP STOP — two failures'); break; }
      continue;
    }
    const id = body.experimentId || body.id;
    const commitBefore = await health();
    console.log(`${ch(new Date())}  [${t.key}] experiment ${id} started (commit ${commitBefore})`);

    // poll to terminal state
    let st = 'running';
    for (let i = 0; i < 45 && st === 'running'; i++) {
      await sleep(20_000);
      try {
        const r = await fetch(`${BASE}/api/admin/testlab/experiments/${id}`, { headers: H });
        const e = await r.json();
        st = e.status || e.experiment?.status || 'running';
      } catch { /* transient */ }
    }
    const commitAfter = await health();
    const envNote = commitAfter !== commitBefore ? '  [REDEPLOYED MID-RUN — environmental]' : '';
    console.log(`${ch(new Date())}  [${t.key}] exp ${id} -> ${st}${envNote}`);
    ids.push(`${t.key}=${id}:${st}`);
    if (st === 'failed' && !envNote) {
      errors++;
      if (errors >= 2) { console.log('BURN-LOOP STOP — two failures'); break; }
    }
  }
  console.log('SUITE_DONE ' + ids.join(' '));
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
