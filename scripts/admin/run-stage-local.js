#!/usr/bin/env node
/**
 * Run a Test Lab stage in THIS process, then persist the result as a normal
 * experiment row so it shows up in the Lab UI like any other run.
 *
 * WHY: the Lab executes one experiment at a time (a single-flight guard in
 * routes/admin/testlab.js) and its runs live in the server process, so every
 * deploy kills whatever is in flight. On 2026-08-20 that cost three measurement
 * runs in one session (774, 777 twice) and blocked other agents from the Lab
 * while long eval sweeps held the slot. Measurement that only reads stored data
 * and calls model APIs does not need to occupy the server at all.
 *
 * What this does NOT do is hide the evidence. The owner's standing rule is that
 * experiments are visible in the Lab, never local-only scratchpads — so the
 * result is written to `testlab_experiments` with the same shape the server
 * writes, and the row records its own provenance (local HEAD, whether the tree
 * was dirty, the host) so nobody has to guess later how it was produced.
 *
 * FIDELITY GUARD. A local run reads prompts and code from the WORKING TREE while
 * the data comes from a deployed environment. If those disagree the run measures
 * something that does not exist anywhere. So it refuses unless local HEAD
 * matches the target environment's deployed commit (--allow-drift to override,
 * which stamps the row so the mismatch travels with the evidence).
 *
 * STAGES THAT CANNOT RUN HERE: anything needing a service this machine does not
 * have. `entity` calls the Python analyzer for cascade face detection and
 * SWALLOWS the failure (detectIllustrationFaces returns [] on any error), so it
 * would silently produce a degraded result that looks valid. Same class of
 * problem for SAM-dependent repair/composite stages. Those are refused by name.
 *
 * Usage:
 *   node scripts/admin/run-stage-local.js --stage=eval_variance \
 *        --targets='[{"storyId":"job_x","pageNumber":9,"versionIndex":0}]' \
 *        --params='{"repeats":3}' --label='eval variance — local'
 *   node scripts/admin/run-stage-local.js --stage=eval_variance --set=14 --params='{"repeats":3}'
 */
require('dotenv').config();
const os = require('os');
const { execFileSync } = require('child_process');

const arg = (name, dflt = null) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

// Stages whose result would be silently WRONG without a service this box lacks.
const REFUSED = {
  entity: 'calls the Python analyzer (PHOTO_ANALYZER_URL) for cascade face detection and returns [] on failure — a local run degrades silently',
  char_repair: 'needs MobileSAM for figure-clipped masks; local falls back to a rectangular hatch',
  scene_composite: 'needs MobileSAM; local masks are not the real ones',
  inpaint: 'needs MobileSAM for the blend mask',
  qwen_insert: 'needs MobileSAM for the blend mask',
  garment_colour_fix: 'needs SAM garment masks',
};

const ENVS = {
  staging: { base: 'https://staging.magicalstory.ch', db: 'STAGING_DATABASE_URL' },
  production: { base: 'https://magicalstory.ch', db: 'DATABASE_URL' },
};

(async () => {
  const stage = arg('stage');
  if (!stage) throw new Error('--stage is required');
  if (REFUSED[stage]) throw new Error(`Stage "${stage}" cannot run locally: ${REFUSED[stage]}. Run it in the Lab.`);

  const envName = arg('env', 'staging');
  const env = ENVS[envName];
  if (!env) throw new Error(`--env must be one of: ${Object.keys(ENVS).join(', ')}`);
  if (!process.env[env.db]) throw new Error(`${env.db} is not set`);

  // Point the app's pool at the target environment BEFORE anything requires it.
  process.env.DATABASE_URL = process.env[env.db]
    + (process.env[env.db].includes('?') ? '&' : '?') + 'sslmode=no-verify';
  const db = require('../../server/services/database');
  db.initializePool();

  // ── fidelity guard ────────────────────────────────────────────────────────
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const deployed = await fetch(`${env.base}/api/health`).then(r => r.json()).then(j => j.commit).catch(() => null);
  const matches = deployed && head.startsWith(deployed);
  if (!matches && !flag('allow-drift')) {
    throw new Error(
      `Working tree (${head.slice(0, 8)}) does not match ${envName} (${deployed || 'unknown'}).\n` +
      `  A local run reads prompts and code from the tree while the data comes from ${envName};\n` +
      `  if they disagree the run measures something that exists nowhere.\n` +
      `  Fix the tree, or pass --allow-drift (the mismatch is stamped on the row).`
    );
  }

  // ── resolve targets ───────────────────────────────────────────────────────
  let targets;
  const setId = arg('set');
  if (setId) {
    const setRows = await db.dbQuery('SELECT name, stage, params FROM testlab_sets WHERE id = $1', [parseInt(setId, 10)]);
    if (!setRows.length) throw new Error(`Set ${setId} not found`);
    if (setRows[0].stage !== stage) throw new Error(`Set ${setId} is a "${setRows[0].stage}" set, not "${stage}"`);
    const members = await db.dbQuery('SELECT target, params FROM testlab_set_members WHERE set_id = $1 ORDER BY added_at', [parseInt(setId, 10)]);
    targets = members.map(m => ({ ...(m.target || {}), _params: { ...(setRows[0].params || {}), ...(m.params || {}) } }));
    console.log(`Set ${setId} "${setRows[0].name}" — ${targets.length} member(s)`);
  } else {
    targets = JSON.parse(arg('targets') || '[]');
  }
  if (!targets.length) throw new Error('no targets (--targets=JSON or --set=ID)');

  const params = JSON.parse(arg('params') || '{}');
  const provenance = { ranLocally: true, host: os.hostname(), head, treeDirty: dirty, deployedCommit: deployed, matchedDeploy: !!matches, env: envName };
  const label = `[local] ${arg('label', `${stage} — ${targets.length} target(s)`)}`;

  const rows = await db.dbQuery(
    `INSERT INTO testlab_experiments (stage, label, prompt_override, params, status, targets, created_by, heartbeat_at)
     VALUES ($1,$2,NULL,$3,'running',$4,$5,NOW()) RETURNING id`,
    [stage, label, JSON.stringify({ ...params, _provenance: provenance }), JSON.stringify(targets), `local:${os.userInfo().username}`]
  );
  const experimentId = rows[0].id;
  console.log(`Experiment #${experimentId} (local) — ${env.base}/admin/test-lab?exp=${experimentId}`);
  if (!matches) console.warn(`  ⚠ tree/deploy mismatch stamped on the row (${head.slice(0, 8)} vs ${deployed})`);
  if (dirty) console.warn('  ⚠ working tree is dirty — stamped on the row');

  const { runStageOnTarget } = require('../../server/lib/testlab');
  let ok = 0;
  for (const rawTarget of targets) {
    const { _params: memberParams, ...target } = rawTarget;
    const startedAt = new Date().toISOString();
    let entry;
    try {
      const result = await runStageOnTarget(stage, target, { experimentId, params: { ...params, ...(memberParams || {}) } });
      entry = { ...target, ok: true, startedAt, ...result };
      ok++;
      console.log(`  ✓ ${target.storyId} p${target.pageNumber ?? '-'}`);
    } catch (err) {
      entry = { ...target, ok: false, startedAt, error: err.message, ...(err.partialResult || {}) };
      console.log(`  ✗ ${target.storyId} p${target.pageNumber ?? '-'} — ${err.message}`);
    }
    // Append per target, exactly like the server, so a partial run is still readable.
    await db.dbQuery(
      `UPDATE testlab_experiments
          SET results = results || $2::jsonb,
              results_count = results_count + 1,
              heartbeat_at = NOW()
        WHERE id = $1`,
      [experimentId, JSON.stringify([entry])]
    );
  }

  await db.dbQuery(`UPDATE testlab_experiments SET status='completed', completed_at=NOW() WHERE id=$1`, [experimentId]);
  console.log(`\nDone — ${ok}/${targets.length} ok. Visible in the Lab as #${experimentId}.`);
  await closePool();
  process.exit(0);
})().catch(async (e) => { console.error('FAILED:', e.message); await closePool(); process.exit(1); });

// Close the pg pool before exiting. Without it, process.exit with sockets still
// open trips a libuv assertion on Windows (UV_HANDLE_CLOSING) that prints after
// the error and can bury the real message.
async function closePool() {
  try { await require('../../server/services/database').getPool()?.end(); } catch { /* nothing to close */ }
}
