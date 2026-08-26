// Waits for the rewritten blend prompt to be deployed, then runs ONE
// scene_composite experiment on the page that failed in exp 848.
const { execSync } = require('child_process');
const { ch } = require('../lib/chTime');

const BASE = 'https://staging.magicalstory.ch';
const STORY = 'job_1786780194082_s980g4s9a';
const PAGE = 6;
const WANT = '8c1baa51';            // the rewrite
const sleep = ms => new Promise(r => setTimeout(r, ms));
const health = async () => (await (await fetch(`${BASE}/api/health`)).json()).commit;

(async () => {
  // 1. Wait for the deploy, and for it to hold across two polls.
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    let c = null;
    try { c = await health(); } catch { /* restarting */ }
    if (c === WANT) {
      stable++;
      if (stable >= 2) { console.log(`${ch(new Date())}  deployed and stable on ${c}`); break; }
    } else {
      if (i % 6 === 0) console.log(`${ch(new Date())}  waiting for deploy — running ${c}`);
      stable = 0;
    }
    await sleep(30_000);
  }
  const commitBefore = await health();
  if (commitBefore !== WANT) {
    console.log(`${ch(new Date())}  ABORT — ${WANT} never deployed (still ${commitBefore}). Nothing spent.`);
    process.exitCode = 2;
    return;
  }

  // 2. Launch, retrying past the in-process single-flight latch (409 is free).
  const token = execSync('node scripts/admin/get-admin-token.js').toString().trim();
  const launch = () => fetch(`${BASE}/api/admin/testlab/experiments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      stage: 'scene_composite',
      label: 'blend v2: positive description, 1635 chars (was 5451)',
      targets: [{ storyId: STORY, pageNumber: PAGE }],
      params: { strategy: 'uniform' },
    }),
  });
  let res, body;
  for (let attempt = 1; attempt <= 30; attempt++) {
    res = await launch();
    body = await res.json();
    if (res.status !== 409) break;
    if (attempt % 5 === 1) console.log(`${ch(new Date())}  latch held (attempt ${attempt})`);
    await sleep(60_000);
  }
  if (!res.ok) { console.log('LAUNCH FAILED', res.status, JSON.stringify(body)); process.exitCode = 1; return; }
  const id = body.experimentId || body.id;
  console.log(`${ch(new Date())}  experiment ${id} started on ${commitBefore}`);

  // 3. Poll to completion.
  for (let i = 0; i < 60; i++) {
    await sleep(20_000);
    const r = await fetch(`${BASE}/api/admin/testlab/experiments/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const e = await r.json();
    const st = e.status || e.experiment?.status;
    if (st && st !== 'running') {
      const after = await health();
      console.log(`${ch(new Date())}  status=${st}  commit before=${commitBefore} after=${after}`);
      if (after !== commitBefore) console.log('  NOTE: redeployed mid-run — treat a failure as environmental.');
      console.log('EXPERIMENT_ID ' + id);
      return;
    }
  }
  console.log('timed out waiting');
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
