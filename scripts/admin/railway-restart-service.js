#!/usr/bin/env node
/**
 * Restart one Railway service, to return page cache to the OS.
 *
 * WHY THIS EXISTS. Railway bills the container's cgroup memory, and cgroup
 * accounting counts the OS page cache. Linux only evicts page cache under
 * memory PRESSURE — with a 22.9 GB ceiling and ~1 GB in use there is never any,
 * so every file page the database has ever read stays resident and billed. It
 * is reclaimable memory that nothing ever asks to reclaim.
 *
 * Shrinking the database (VACUUM FULL, moving image bytes to R2) lowers the
 * CEILING but returns nothing on its own: the cache still holds the old
 * high-water mark. Measured 2026-09-06: staging's database went 676 MB -> 422 MB
 * and its container stayed at 1,093 MB.
 *
 * Tearing down the container is what actually returns it. The cache then refills
 * only with what is genuinely read, bounded by the new, smaller database.
 *
 * The correct kernel mechanism would be `memory.high` — a soft limit that makes
 * the kernel reclaim without killing anything. Railway does not expose it; its
 * "Replica Limits" set `memory.max`, a hard cap that OOM-kills instead. So a
 * restart is the safe lever available to us.
 *
 *   node scripts/admin/railway-restart-service.js --service=postgres --env=staging [--apply]
 *
 * Dry run by default. REFUSES unless the environment reports idle.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.railway', 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`No Railway token at ${CONFIG_PATH}. Run \`railway login\` first.`);
  process.exit(1);
}
const TOKEN = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).user.token;

const PROJECT_ID = '5da5a1d8-bac8-4881-9469-84330d81a880';
const ENVS = {
  staging: '5855ba5e-97e6-4738-9b23-620fed110929',
  production: '7249dc67-090c-4f1b-937d-3fb7744073be',
};
const SERVICES = {
  postgres: '3611b39d-d532-47ac-b06a-aa338d3688d9',
  analyzer: '3ac947b5-def9-4027-bbe6-34da77d4babf',
  web: '8a281ffe-bb3a-47a2-8318-710afd5acbb7',
};

const args = process.argv.slice(2);
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = args.includes('--apply');
const envName = arg('env', 'staging');
const svcName = arg('service', '');

if (!ENVS[envName] || !SERVICES[svcName]) {
  console.error('Usage: --service=postgres|analyzer|web --env=staging|production [--apply]');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

(async () => {
  const base = envName === 'staging'
    ? 'https://staging.magicalstory.ch'
    : 'https://magicalstory.ch';

  // Same gate as the pre-push hook: never restart under a live generation.
  const busy = await fetch(`${base}/api/health/busy`, { signal: AbortSignal.timeout(15000) })
    .then((r) => r.json())
    .catch((e) => ({ busy: true, reasons: [`health check failed: ${e.message}`] }));
  console.log(`${envName} busy: ${busy.busy}${busy.reasons?.length ? ` (${busy.reasons.join(', ')})` : ''}`);
  if (busy.busy) {
    console.error('REFUSING: work in flight. A restart drops connections and kills it.');
    process.exit(1);
  }

  const d = await gql(
    `query($p:String!,$e:String!,$s:String!){
       deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){
         edges{ node{ id status } } } }`,
    { p: PROJECT_ID, e: ENVS[envName], s: SERVICES[svcName] }
  );
  const dep = d.deployments.edges[0]?.node;
  if (!dep) {
    console.error(`No deployment found for ${svcName} in ${envName}.`);
    process.exit(1);
  }
  console.log(`${envName}/${svcName}: deployment ${dep.id.slice(0, 8)} (${dep.status})`);

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to restart)');
    return;
  }

  console.log('Restarting…');
  await gql(`mutation($id:String!){ deploymentRestart(id:$id) }`, { id: dep.id });
  console.log('Restart requested. Page cache returns as the container is torn down;');
  console.log('it refills only with what is actually read, bounded by the database size.');
})();
