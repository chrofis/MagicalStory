#!/usr/bin/env node
/**
 * Start / stop / inspect the staging service on Railway.
 *
 * Staging shuts itself down when idle (server/lib/idleShutdown.js) so we stop
 * paying for resident RAM between test runs. This is how you wake it back up.
 *
 *   npm run staging:up       — redeploy (wake) staging
 *   npm run staging:down     — stop staging now, but ONLY if nothing is in flight
 *   npm run staging:status   — show current deployment state
 *
 * `down` repeats the in-flight check the server does, so a manual stop can't
 * kill a running story generation either. Pass --force to override.
 *
 * Auth: RAILWAY_API_TOKEN from .env, else the token from the Railway CLI login
 * at ~/.railway/config.json.
 */

require('dotenv').config();
const os = require('os');
const path = require('path');

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const PROJECT_ID = '5da5a1d8-bac8-4881-9469-84330d81a880';
const SERVICE_ID = '8a281ffe-bb3a-47a2-8318-710afd5acbb7'; // MagicalStory
const STAGING_ENV_ID = '5855ba5e-97e6-4738-9b23-620fed110929';

function getToken() {
  if (process.env.RAILWAY_API_TOKEN) return process.env.RAILWAY_API_TOKEN;
  try {
    const cfg = require(path.join(os.homedir(), '.railway', 'config.json'));
    if (cfg?.user?.token) return cfg.user.token;
  } catch { /* fall through */ }
  console.error('No RAILWAY_API_TOKEN in .env and no Railway CLI login found (`railway login`).');
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

// Statuses that mean "this deployment is (or is becoming) the live one".
// Railway keeps REMOVED/FAILED/CRASHED rows in the same list, and a redeploy can
// briefly leave two live-ish rows, so pick the NEWEST live one rather than just
// the newest row — otherwise `down` can aim at a corpse and silently do nothing.
const LIVE_STATUSES = new Set(['SUCCESS', 'DEPLOYING', 'BUILDING', 'INITIALIZING']);

async function recentDeployments(n = 6) {
  const d = await gql(
    `query D($pid: String!, $sid: String!, $eid: String!, $n: Int!) {
       deployments(first: $n, input: { projectId: $pid, serviceId: $sid, environmentId: $eid }) {
         edges { node { id status createdAt } }
       }
     }`,
    { pid: PROJECT_ID, sid: SERVICE_ID, eid: STAGING_ENV_ID, n }
  );
  return d.deployments.edges.map((e) => e.node);
}

async function liveDeployment() {
  const all = await recentDeployments();
  return all.find((d) => LIVE_STATUSES.has(d.status)) || null;
}

async function inFlightStoryJobs() {
  const url = process.env.STAGING_DATABASE_URL;
  if (!url) {
    console.warn('STAGING_DATABASE_URL not set — cannot verify in-flight jobs.');
    return null; // unknown, treated as blocking unless --force
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const r = await pool.query(
      "SELECT COUNT(*)::int AS n FROM story_jobs WHERE status IN ('pending','processing')"
    );
    return r.rows[0].n;
  } finally {
    await pool.end();
  }
}

async function main() {
  const cmd = (process.argv[2] || 'status').replace(/^--/, '');
  const force = process.argv.includes('--force');

  if (cmd === 'status') {
    const all = await recentDeployments();
    if (!all.length) return console.log('No deployments found for staging.');
    const live = all.find((d) => LIVE_STATUSES.has(d.status));
    const jobs = await inFlightStoryJobs().catch(() => null);
    console.log(`staging: ${live ? 'UP (' + live.status + ')' : 'DOWN — no live deployment'}`);
    if (live) console.log(`  live deployment: ${live.id}  (${live.createdAt})`);
    console.log(`  in-flight jobs:  ${jobs === null ? 'unknown' : jobs + ' story job(s)'}`);
    console.log('  recent:');
    all.forEach((d) => console.log(`    ${d.createdAt}  ${String(d.status).padEnd(12)} ${d.id}`));
    return;
  }

  if (cmd === 'up') {
    console.log('Waking staging (redeploying latest commit)…');
    await gql(
      `mutation Up($sid: String!, $eid: String!) {
         serviceInstanceDeployV2(serviceId: $sid, environmentId: $eid)
       }`,
      { sid: SERVICE_ID, eid: STAGING_ENV_ID }
    );
    console.log('Deploy triggered. It takes a few minutes — this image is large.');
    console.log('Watch: https://staging.magicalstory.ch/api/health');
    return;
  }

  if (cmd === 'down') {
    const jobs = await inFlightStoryJobs().catch((e) => {
      console.warn(`Could not check in-flight jobs: ${e.message}`);
      return null;
    });
    if (!force && jobs !== 0) {
      const what = jobs === null ? 'could not be verified' : `${jobs} job(s) are running`;
      console.error(`Refusing to stop staging — in-flight story generation ${what}.`);
      console.error('Re-run with --force only if you are certain you want to kill it.');
      process.exit(1);
    }
    const dep = await liveDeployment();
    if (!dep) return console.log('Staging is already down — no live deployment.');
    await gql('mutation Stop($id: String!) { deploymentStop(id: $id) }', { id: dep.id });
    console.log(`Stopped staging deployment ${dep.id}. Wake it with: npm run staging:up`);
    return;
  }

  console.error(`Unknown command "${cmd}". Use: up | down | status`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
