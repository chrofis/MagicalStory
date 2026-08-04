/**
 * Idle shutdown for non-production environments.
 *
 * WHY: Railway bills resident memory per MINUTE, around the clock. The staging
 * app idles at ~1.23 GB p50, which is roughly $12-15/month spent on a container
 * that is doing nothing between test runs.
 *
 * Railway's built-in "app sleeping" is the obvious lever, but it decides purely
 * on inbound HTTP traffic and would happily sleep the container in the middle of
 * a story generation — those run for many minutes in the background, and if the
 * browser tab that was polling gets closed the traffic stops while the work is
 * still going. That loses a real (and paid-for) run.
 *
 * So this shuts the service down only when it can prove nothing is happening:
 * no recent HTTP, no story job in flight, and no module has raised its hand via
 * a busy probe. The app is the only thing that actually knows this, which is why
 * the check lives in-process rather than in an external cron.
 *
 * Waking back up is explicit: `npm run staging:up` (scripts/admin/staging-power.js),
 * or any push to the staging branch, which redeploys and starts it anyway.
 *
 * SAFETY: three independent gates must all pass before this can ever fire, and
 * production fails the environment-name gate even if the flag is set by mistake.
 */

const { log } = require('../utils/logger');

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

let lastActivityMs = Date.now();
let startedAtMs = Date.now();
const busyProbes = new Map();
let timer = null;

/** Stamp "something happened" — called by the Express middleware below. */
function markActivity() {
  lastActivityMs = Date.now();
}

/**
 * Register a named predicate that returns true (or a Promise of true) while some
 * work must not be interrupted. Any probe returning true blocks shutdown, and
 * the name is logged so it's obvious what held the container open.
 */
function registerBusyProbe(name, fn) {
  busyProbes.set(name, fn);
}

/** Express middleware — any request counts as activity. */
function activityMiddleware(req, res, next) {
  markActivity();
  next();
}

/**
 * A probe that throws is treated as BUSY, never as idle. A failing database
 * check must not be the reason we shut down on top of an in-flight story.
 */
async function firstBusyProbe() {
  for (const [name, fn] of busyProbes) {
    try {
      if (await fn()) return name;
    } catch (err) {
      log.warn(`[IDLE-SHUTDOWN] probe "${name}" failed (${err.message}) — treating as busy`);
      return `${name} (probe error)`;
    }
  }
  return null;
}

async function stopOwnDeployment(deploymentId, token) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: 'mutation Stop($id: String!) { deploymentStop(id: $id) }',
      variables: { id: deploymentId },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body;
}

function startIdleShutdown() {
  // ── Gate 1: explicit opt-in. Absent everywhere unless deliberately set. ──
  if (process.env.STAGING_IDLE_SHUTDOWN !== 'true') return;

  // ── Gate 2: never production, whatever the flag says. ──
  const envName = process.env.RAILWAY_ENVIRONMENT_NAME || '';
  if (envName !== 'staging') {
    log.warn(`[IDLE-SHUTDOWN] refusing to arm: RAILWAY_ENVIRONMENT_NAME="${envName}" is not "staging"`);
    return;
  }

  // ── Gate 3: we need the credentials to stop ourselves. ──
  const token = process.env.RAILWAY_API_TOKEN;
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  if (!token || !deploymentId) {
    log.warn('[IDLE-SHUTDOWN] refusing to arm: RAILWAY_API_TOKEN or RAILWAY_DEPLOYMENT_ID missing');
    return;
  }

  const idleMin = parseInt(process.env.IDLE_SHUTDOWN_MINUTES || '30', 10);
  // Grace period after boot. Without it a deploy that nobody visits would shut
  // itself down before anyone could use it, and a push would look like a crash.
  const graceMin = parseInt(process.env.IDLE_SHUTDOWN_GRACE_MINUTES || '20', 10);

  startedAtMs = Date.now();
  lastActivityMs = Date.now();

  // Story generation is the long-running background work this exists to protect.
  registerBusyProbe('story-jobs', async () => {
    const { dbQuery } = require('../services/database');
    const r = await dbQuery(
      "SELECT COUNT(*)::int AS n FROM story_jobs WHERE status IN ('pending', 'processing')"
    );
    return (r.rows[0]?.n || 0) > 0;
  });

  log.info(
    `[IDLE-SHUTDOWN] armed on staging — will stop after ${idleMin} min idle ` +
    `(${graceMin} min boot grace). Wake with: npm run staging:up`
  );

  timer = setInterval(async () => {
    try {
      const uptimeMin = (Date.now() - startedAtMs) / 60000;
      if (uptimeMin < graceMin) return;

      const idleFor = (Date.now() - lastActivityMs) / 60000;
      if (idleFor < idleMin) return;

      const busy = await firstBusyProbe();
      if (busy) {
        // Work in flight is itself activity — don't let the idle clock run out
        // mid-generation and shut down the instant the job finishes.
        markActivity();
        log.info(`[IDLE-SHUTDOWN] idle ${idleFor.toFixed(0)} min but "${busy}" is busy — staying up`);
        return;
      }

      log.info(
        `[IDLE-SHUTDOWN] no HTTP for ${idleFor.toFixed(0)} min and no work in flight — ` +
        `stopping deployment ${deploymentId} to stop paying for idle RAM`
      );
      clearInterval(timer);
      await stopOwnDeployment(deploymentId, token);
    } catch (err) {
      log.warn(`[IDLE-SHUTDOWN] check failed: ${err.message}`);
    }
  }, 60 * 1000);

  if (timer.unref) timer.unref();
}

module.exports = { startIdleShutdown, activityMiddleware, markActivity, registerBusyProbe };
