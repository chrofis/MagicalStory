#!/usr/bin/env node
/**
 * Wire the photo analyzer into the PRODUCTION Railway environment.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The analyzer left the web container on 2026-09-04 (see docs/decisions.md and
 * start.sh): staging's `start.sh` is Node-ONLY and reaches Python over private
 * networking via PHOTO_ANALYZER_URL. That took the web container from ~2,000 MB
 * to 74 MB idle. Production was never wired for it — it has no analyzer service
 * instance and no PHOTO_ANALYZER_URL — so fast-forwarding master to staging
 * WITHOUT running this first silently breaks /remove-bg, /extract-face,
 * face embeddings, the 2x4 avatar sheet and GroundingDINO figure detection.
 * They break by TIMEOUT, not by error (photoAnalyzerUrl() falls back to
 * http://127.0.0.1:5000), degrading to a Gemini fallback with no alarm.
 *
 * ORDERING MATTERS
 * ----------------
 * master does not yet contain Dockerfile.analyzer or start-analyzer.sh — they
 * exist only on staging. So phase 1 deploys the analyzer from an explicit
 * commit SHA (staging's HEAD) even though the service's branch is `master`.
 * After master is fast-forwarded to that same SHA, the master trigger simply
 * redeploys identical code.
 *
 *   node scripts/admin/railway-prod-analyzer.js --phase=1 [--sha=<commit>]
 *     -> add the analyzer to the production environment config, set
 *        RAILWAY_DOCKERFILE_PATH, and deploy it from <sha>. Waits for green.
 *
 *   node scripts/admin/railway-prod-analyzer.js --phase=2
 *     -> set PHOTO_ANALYZER_URL on the production web service. Run this ONLY
 *        after phase 1 reports the analyzer healthy. Triggers a web redeploy,
 *        so check /api/health/busy first.
 *
 *   node scripts/admin/railway-prod-analyzer.js --status
 *     -> read-only: print what production currently looks like.
 *
 * Four traps this script is written around (each failed SILENTLY before):
 *   1. host='0.0.0.0' is IPv4-only; Railway private networking is IPv6-only.
 *      (Handled in photo_analyzer.py, not here — listed so it is not re-broken.)
 *   2. Railway healthchecks the port it injects as PORT; PORT=5000 must be
 *      pinned or the container runs fine and the deploy is marked FAILED.
 *   3. Without RAILWAY_DOCKERFILE_PATH, railway.json pins dockerfilePath
 *      "Dockerfile" and Railway builds the WEB image instead, which boots the
 *      web app and dies on JWT_SECRET.
 *   4. "Stories still generate" proves nothing. The pass signal is dino_calls /
 *      sam_calls in story_metrics.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.railway', 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`No Railway token at ${CONFIG_PATH}. Run \`railway login\` first.`);
  process.exit(1);
}
const TOKEN = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).user.token;

const PROJECT_ID = '5da5a1d8-bac8-4881-9469-84330d81a880'; // zealous-reflection
const ENV_PROD = '7249dc67-090c-4f1b-937d-3fb7744073be';
const ENV_STAGING = '5855ba5e-97e6-4738-9b23-620fed110929';
const SVC_ANALYZER = '3ac947b5-def9-4027-bbe6-34da77d4babf';
const SVC_WEB = '8a281ffe-bb3a-47a2-8318-710afd5acbb7';

const ANALYZER_URL = 'http://analyzer.railway.internal:5000';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const err = new Error(json.errors.map((e) => e.message).join('; '));
    err.graphQLErrors = json.errors;
    throw err;
  }
  return json.data;
}

/**
 * Some Railway mutations return a scalar, others an object needing a selection
 * set, and this has changed across API revisions. Try with the selection set,
 * fall back to scalar on a validation error rather than guessing.
 */
async function gqlEither(withSelection, scalar, variables) {
  try {
    return await gql(withSelection, variables);
  } catch (e) {
    const validation = (e.graphQLErrors || []).some(
      (x) => x.extensions && x.extensions.code === 'GRAPHQL_VALIDATION_FAILED'
    );
    if (!validation) throw e;
    return gql(scalar, variables);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readState() {
  const envCfg = await gql(
    `query($id:String!){ environment(id:$id){ name configEtag config } }`,
    { id: ENV_PROD }
  );
  const services = (envCfg.environment.config && envCfg.environment.config.services) || {};

  const vars = await gql(
    `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) }`,
    { p: PROJECT_ID, e: ENV_PROD, s: SVC_WEB }
  );

  const analyzerVars = await gql(
    `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) }`,
    { p: PROJECT_ID, e: ENV_PROD, s: SVC_ANALYZER }
  );

  return {
    analyzerInConfig: Boolean(services[SVC_ANALYZER]),
    analyzerConfig: services[SVC_ANALYZER] || null,
    webPhotoAnalyzerUrl: vars.variables.PHOTO_ANALYZER_URL || null,
    analyzerDockerfilePath: analyzerVars.variables.RAILWAY_DOCKERFILE_PATH || null,
    analyzerPort: analyzerVars.variables.PORT || null,
    analyzerPrivateDomain: analyzerVars.variables.RAILWAY_PRIVATE_DOMAIN || null,
  };
}

async function printStatus() {
  const s = await readState();
  console.log('\n=== PRODUCTION state ===');
  console.log(`analyzer in env config : ${s.analyzerInConfig ? 'YES' : 'NO  <- must be YES'}`);
  console.log(`analyzer PORT          : ${s.analyzerPort || 'unset  <- trap 2'}`);
  console.log(`analyzer DOCKERFILE    : ${s.analyzerDockerfilePath || 'unset  <- trap 3'}`);
  console.log(`analyzer private domain: ${s.analyzerPrivateDomain || 'none (service not deployed)'}`);
  console.log(`web PHOTO_ANALYZER_URL : ${s.webPhotoAnalyzerUrl || 'unset  <- Node falls back to 127.0.0.1:5000'}`);
  if (s.analyzerConfig) console.log('analyzer config:', JSON.stringify(s.analyzerConfig, null, 2));
  console.log('');
  return s;
}

async function latestDeployment(environmentId, serviceId) {
  const d = await gql(
    `query($p:String!,$e:String!,$s:String!){
       deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){
         edges{ node{ id status createdAt staticUrl meta } } } }`,
    { p: PROJECT_ID, e: environmentId, s: serviceId }
  );
  const edge = d.deployments.edges[0];
  return edge ? edge.node : null;
}

async function waitForDeployment(environmentId, serviceId, { timeoutMs = 25 * 60 * 1000 } = {}) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    const dep = await latestDeployment(environmentId, serviceId);
    if (dep && dep.status !== lastStatus) {
      lastStatus = dep.status;
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`  [${mins}m] deployment ${dep.id.slice(0, 8)} -> ${dep.status}`);
    }
    if (dep && ['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED'].includes(dep.status)) return dep;
    await sleep(10000);
  }
  throw new Error('Timed out waiting for the analyzer deployment to settle.');
}

async function phase1(sha) {
  console.log('=== PHASE 1: add the analyzer to the production environment ===');
  const before = await readState();
  if (before.analyzerInConfig) {
    console.log('Analyzer is ALREADY in the production config — not re-staging it.');
  }

  // Trap 3: without this, railway.json wins and Railway builds the web image.
  console.log('\n[1/4] Setting RAILWAY_DOCKERFILE_PATH=Dockerfile.analyzer ...');
  await gql(`mutation($i:VariableUpsertInput!){ variableUpsert(input:$i) }`, {
    i: {
      projectId: PROJECT_ID,
      environmentId: ENV_PROD,
      serviceId: SVC_ANALYZER,
      name: 'RAILWAY_DOCKERFILE_PATH',
      value: 'Dockerfile.analyzer',
      skipDeploys: true,
    },
  });
  console.log('      ok');

  // Trap 2: PORT must be pinned to the port Flask actually listens on.
  if (before.analyzerPort !== '5000') {
    console.log('[1b ] Pinning PORT=5000 ...');
    await gql(`mutation($i:VariableUpsertInput!){ variableUpsert(input:$i) }`, {
      i: {
        projectId: PROJECT_ID,
        environmentId: ENV_PROD,
        serviceId: SVC_ANALYZER,
        name: 'PORT',
        value: '5000',
        skipDeploys: true,
      },
    });
    console.log('      ok');
  } else {
    console.log('[1b ] PORT already 5000 — skipping');
  }

  if (!before.analyzerInConfig) {
    // Mirrors the staging analyzer block exactly, except branch=master.
    const config = {
      services: {
        [SVC_ANALYZER]: {
          source: { repo: 'chrofis/MagicalStory', branch: 'master', checkSuites: false },
          build: { builder: 'RAILPACK', buildEnvironment: 'V3' },
          deploy: {
            startCommand: 'bash start-analyzer.sh',
            healthcheckPath: '/health',
            useLegacyStacker: false,
            ipv6EgressEnabled: false,
            runtime: 'V2',
            multiRegionConfig: { 'us-east4-eqdc4a': { numReplicas: 1 } },
          },
        },
      },
    };

    console.log('\n[2/4] Staging the analyzer service into the production config ...');
    await gqlEither(
      `mutation($e:String!,$i:EnvironmentConfig!,$m:Boolean){ environmentStageChanges(environmentId:$e,input:$i,merge:$m){ id status } }`,
      `mutation($e:String!,$i:EnvironmentConfig!,$m:Boolean){ environmentStageChanges(environmentId:$e,input:$i,merge:$m) }`,
      { e: ENV_PROD, i: config, m: true }
    );
    console.log('      staged');

    // skipDeploys: master has no Dockerfile.analyzer yet, so an automatic
    // deploy here would build the wrong image and fail. We deploy an explicit
    // SHA below instead.
    console.log('[3/4] Committing the staged change (skipDeploys) ...');
    await gqlEither(
      `mutation($e:String!,$m:String!,$s:Boolean){ environmentPatchCommitStaged(environmentId:$e,commitMessage:$m,skipDeploys:$s){ id status } }`,
      `mutation($e:String!,$m:String!,$s:Boolean){ environmentPatchCommitStaged(environmentId:$e,commitMessage:$m,skipDeploys:$s) }`,
      { e: ENV_PROD, m: 'Add photo analyzer service to production', s: true }
    );
    console.log('      committed');
  } else {
    console.log('\n[2-3/4] Config already present — skipping stage/commit.');
  }

  console.log(`\n[4/4] Deploying the analyzer from commit ${sha} ...`);
  console.log('      (explicit SHA: master does not carry Dockerfile.analyzer yet)');
  await gqlEither(
    `mutation($c:String!,$e:String!,$s:String!){ serviceInstanceDeployV2(commitSha:$c,environmentId:$e,serviceId:$s){ id } }`,
    `mutation($c:String!,$e:String!,$s:String!){ serviceInstanceDeployV2(commitSha:$c,environmentId:$e,serviceId:$s) }`,
    { c: sha, e: ENV_PROD, s: SVC_ANALYZER }
  );
  console.log('      deploy triggered — waiting for it to settle (this builds an ML image, expect 10-20 min)\n');

  const dep = await waitForDeployment(ENV_PROD, SVC_ANALYZER);
  console.log(`\nFinal deployment status: ${dep.status}`);
  if (dep.status !== 'SUCCESS') {
    console.error('\nDEPLOY DID NOT SUCCEED. Do NOT run phase 2 and do NOT push master.');
    console.error('Check the build log in the Railway dashboard. The usual cause is trap 3:');
    console.error('the wrong Dockerfile got built, so the container booted the web app.');
    process.exit(1);
  }

  const after = await printStatus();
  if (!after.analyzerPrivateDomain) {
    console.error('Deploy succeeded but no private domain is set. Stop and investigate.');
    process.exit(1);
  }
  console.log('PHASE 1 COMPLETE. The analyzer is live in production at');
  console.log(`  ${ANALYZER_URL}`);
  console.log('Next: node scripts/admin/railway-prod-analyzer.js --phase=2');
}

async function phase2() {
  console.log('=== PHASE 2: point the production web service at the analyzer ===');
  const before = await readState();
  if (!before.analyzerInConfig || !before.analyzerPrivateDomain) {
    console.error('The analyzer is not deployed in production yet. Run --phase=1 first.');
    process.exit(1);
  }
  if (before.webPhotoAnalyzerUrl === ANALYZER_URL) {
    console.log('PHOTO_ANALYZER_URL is already set correctly — nothing to do.');
    return;
  }

  console.log(`Setting PHOTO_ANALYZER_URL=${ANALYZER_URL} on the web service ...`);
  console.log('(this triggers a web redeploy — confirm /api/health/busy is false first)');
  await gql(`mutation($i:VariableUpsertInput!){ variableUpsert(input:$i) }`, {
    i: {
      projectId: PROJECT_ID,
      environmentId: ENV_PROD,
      serviceId: SVC_WEB,
      name: 'PHOTO_ANALYZER_URL',
      value: ANALYZER_URL,
      skipDeploys: false,
    },
  });
  console.log('ok — web service redeploying.');
  console.log('\nPHASE 2 COMPLETE. Verify, then master can be fast-forwarded.');
}

async function printDeploys() {
  for (const [label, serviceId] of [['web', SVC_WEB], ['analyzer', SVC_ANALYZER]]) {
    const d = await gql(
      `query($p:String!,$e:String!,$s:String!){
         deployments(first:3, input:{projectId:$p, environmentId:$e, serviceId:$s}){
           edges{ node{ id status createdAt } } } }`,
      { p: PROJECT_ID, e: ENV_PROD, s: serviceId }
    );
    console.log(`\n=== production / ${label} — last 3 deployments ===`);
    d.deployments.edges.forEach((e) => {
      console.log(`  ${e.node.createdAt}  ${e.node.status.padEnd(12)}  ${e.node.id.slice(0, 8)}`);
    });
  }
  console.log('');
}

async function printVolumes() {
  for (const [label, envId] of [['production', ENV_PROD], ['staging', ENV_STAGING]]) {
    const d = await gql(
      `query($id:String!){ environment(id:$id){ volumeInstances{ edges{ node{ id mountPath sizeMB serviceId state } } } } }`,
      { id: envId }
    );
    console.log(`\n=== ${label} volumes ===`);
    const edges = d.environment.volumeInstances.edges;
    if (!edges.length) console.log('  (none)');
    edges.forEach((e) => {
      const svc = e.node.serviceId === SVC_ANALYZER ? 'analyzer' : e.node.serviceId === SVC_WEB ? 'web' : e.node.serviceId;
      console.log(`  ${svc.padEnd(10)} ${e.node.mountPath}  ${e.node.sizeMB}MB  ${e.node.state}`);
    });
  }
  console.log('');
}

async function printLogs(filter) {
  const dep = await latestDeployment(ENV_PROD, SVC_ANALYZER);
  if (!dep) {
    console.log('no analyzer deployment in production');
    return;
  }
  console.log(`=== analyzer deployment ${dep.id.slice(0, 8)} (${dep.status}) logs ===`);
  const d = await gql(
    `query($id:String!,$limit:Int){ deploymentLogs(deploymentId:$id, limit:$limit){ timestamp message severity } }`,
    { id: dep.id, limit: 500 }
  );
  const logs = d.deploymentLogs || [];
  const re = filter ? new RegExp(filter, 'i') : null;
  logs.filter((l) => !re || re.test(l.message)).forEach((l) => {
    console.log(`${l.timestamp}  ${l.message}`);
  });
  console.log(`(${logs.length} lines fetched)`);
}

(async () => {
  try {
    if (has('logs')) {
      await printLogs(arg('grep', null));
      return;
    }
    if (has('volumes')) {
      await printVolumes();
      return;
    }
    if (has('deploys')) {
      await printDeploys();
      return;
    }
    if (has('status')) {
      await printStatus();
      return;
    }
    const phase = arg('phase', null);
    if (phase === '1') {
      const sha = arg('sha', 'cadd4ee72b4f068bd6a8ea2454e272eed73dc61c');
      await phase1(sha);
    } else if (phase === '2') {
      await phase2();
    } else {
      console.log('Usage:');
      console.log('  node scripts/admin/railway-prod-analyzer.js --status');
      console.log('  node scripts/admin/railway-prod-analyzer.js --phase=1 [--sha=<commit>]');
      console.log('  node scripts/admin/railway-prod-analyzer.js --phase=2');
      process.exit(1);
    }
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();
