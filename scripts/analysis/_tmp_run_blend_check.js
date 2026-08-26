// Task #26 — verify the blend fix (3ad9e1a12) keeps the background figure small.
// Runs ONE scene_composite experiment in the Test Lab on the Kapellbrücke page,
// where the pre-fix blend enlarged an occluded background figure and perched him
// on the railing. ~3 Grok calls, ~$0.06.
//
// Records the deployed commit BEFORE and AFTER so a "server restarted mid-run"
// result is distinguishable from a composite failure — the thing that killed
// exp 824 and exp 832.
const { execSync } = require('child_process');
const { ch } = require('../lib/chTime');

const BASE = 'https://staging.magicalstory.ch';
const STORY = 'job_1786780194082_s980g4s9a';
const PAGE = 6;

const health = async () => (await (await fetch(`${BASE}/api/health`)).json()).commit;

(async () => {
  const token = execSync('node scripts/admin/get-admin-token.js').toString().trim();
  const commitBefore = await health();
  console.log(`${ch(new Date())}  launching on commit ${commitBefore}`);

  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  // The Lab is single-flight via an IN-PROCESS latch, which a cancelled-but-
  // still-winding-down run keeps held after its DB row already reads
  // 'cancelled' (and after /health/busy already reads idle — that probe counts
  // status='running' rows only). A 409 is free, so retry rather than give up.
  const launch = () => fetch(`${BASE}/api/admin/testlab/experiments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      stage: 'scene_composite',
      label: 'blend-depth-check: occluded bg figure must stay small (3ad9e1a12)',
      targets: [{ storyId: STORY, pageNumber: PAGE }],
      params: { strategy: 'uniform' },
    }),
  });

  let res, body;
  for (let attempt = 1; attempt <= 30; attempt++) {
    res = await launch();
    body = await res.json();
    if (res.status !== 409) break;
    if (attempt === 1 || attempt % 5 === 0) console.log(`${ch(new Date())}  latch still held (attempt ${attempt}) — waiting`);
    await sleepMs(60_000);
  }
  if (!res.ok) { console.log('LAUNCH FAILED', res.status, JSON.stringify(body)); process.exitCode = 1; return; }
  const id = body.experimentId || body.id;
  console.log(`${ch(new Date())}  experiment ${id} started`);

  // Poll until it leaves 'running'.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    await sleep(20_000);
    const r = await fetch(`${BASE}/api/admin/testlab/experiments/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const e = await r.json();
    const st = e.status || e.experiment?.status;
    if (st && st !== 'running') {
      const commitAfter = await health();
      console.log(`${ch(new Date())}  status=${st}  commit before=${commitBefore} after=${commitAfter}`);
      if (commitAfter !== commitBefore) console.log('  NOTE: the container was redeployed during the run — treat a failure as environmental, not a composite result.');
      console.log(JSON.stringify(e).slice(0, 1500));
      return;
    }
    if (i % 3 === 0) console.log(`${ch(new Date())}  still running (${(i + 1) * 20}s)`);
  }
  console.log('timed out waiting');
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
