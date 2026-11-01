/**
 * Stories in the making per account (owner 2026-11-01, docs/decisions.md).
 *
 * One cap, `runtime('maxActiveStoryJobsPerUser')`, enforced twice by
 * server/routes/jobs.js create-story: a pre-check that also fails+refunds
 * stale jobs, and a re-check inside the per-user advisory-lock transaction so
 * two concurrent requests cannot exceed it. Both refusals use the same 409 body.
 */
'use strict';

const { runtime } = require('../config/runtime');
const { settleJobWithRefund } = require('./jobCredits');

// Two detectors (owner ruling 2026-09-04, evidence job_1788551692337_bc479p945):
// 1. Heartbeat staleness (10 min) — the REAL stall detector. The worker arms a
//    WHOLE-JOB 60s heartbeat for the lifetime of the job (startJobHeartbeat,
//    server/lib/jobHeartbeat.js), so a dead or wedged process goes stale within
//    minutes of dying while no live phase can ever be outside the heartbeat.
// 2. Total age (180 min) — runaway BACKSTOP only. The old 60-min cap predated
//    the beats pipeline and killed a healthy 18-page run at 89%.
const TOTAL_TIMEOUT_MINUTES = 180;
const HEARTBEAT_TIMEOUT_MINUTES = 10;

const ACTIVE_STORY_LIMIT_CODE = 'ACTIVE_STORY_LIMIT';

/** The 409 body, identical for the pre-check and the in-transaction race. */
function activeStoryLimitBody(activeJobIds, maxActive) {
  const n = activeJobIds.length;
  return {
    error: 'Too many stories in progress',
    code: ACTIVE_STORY_LIMIT_CODE,
    maxActive,
    activeJobIds,
    message: `You already have ${n} ${n === 1 ? 'story' : 'stories'} being made. Please wait until one finishes before starting another.`,
  };
}

/**
 * Select every active job of the user, fail+refund the stale ones (exact logic
 * of the old single-job check) and return the live ones.
 * @returns {Promise<{ live: Array<{id:string,status:string}>, staleSettled: string[] }>}
 */
async function resolveLiveActiveJobs(pool, userId, { log, settle = settleJobWithRefund, now = Date.now() } = {}) {
  const res = await pool.query(
    `SELECT id, status, created_at, updated_at, progress FROM story_jobs
     WHERE user_id = $1 AND status IN ('pending', 'processing')
     ORDER BY created_at DESC`,
    [userId]
  );
  const live = [];
  const staleSettled = [];
  for (const job of res.rows) {
    const jobAgeMinutes = (now - new Date(job.created_at).getTime()) / (1000 * 60);
    const minutesSinceUpdate = job.updated_at
      ? (now - new Date(job.updated_at).getTime()) / (1000 * 60)
      : jobAgeMinutes;
    const isStale = jobAgeMinutes > TOTAL_TIMEOUT_MINUTES || minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES;
    if (!isStale) { live.push({ id: job.id, status: job.status }); continue; }

    const reason = minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES ? 'no progress' : 'timeout';
    log?.info(`🧹 Auto-cancelling stale job ${job.id} (${reason}, age: ${Math.round(jobAgeMinutes)}min, last update: ${Math.round(minutesSinceUpdate)}min ago)`);
    // Fail + refund in one transaction (settleJobWithRefund): the refund and the
    // status flip commit together, and a job that finished meanwhile is untouched.
    const errorMessage = minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES
      ? `Job stopped responding (no progress for ${Math.round(minutesSinceUpdate)} minutes)`
      : `Job timed out after ${Math.round(jobAgeMinutes)} minutes`;
    try {
      const settled = await settle(pool, job.id, {
        status: 'failed',
        errorMessage,
        statusIn: ['pending', 'processing'],
        describe: ({ progress }) => `Auto-refund: stale job timed out after ${Math.round(jobAgeMinutes)} min (progress: ${progress}%)`,
      });
      staleSettled.push(job.id);
      if (settled && settled.refunded > 0) log?.info(`💳 Auto-refunded ${settled.refunded} credits for stale job ${job.id}`);
    } catch (refundErr) {
      log?.error(`❌ Failed to fail/refund stale job ${job.id}:`, refundErr.message);
    }
  }
  return { live, staleSettled };
}

/** True when `liveCount` already fills the cap (default: the runtime setting). */
function isAtActiveStoryLimit(liveCount, maxActive = runtime('maxActiveStoryJobsPerUser')) {
  return liveCount >= maxActive;
}

/**
 * Inside the advisory-lock transaction: the active rows of the user, and
 * whether the cap is already reached. Admin semantics unchanged: no exemption
 * (the old check had none either).
 */
async function checkActiveCapInTransaction(txClient, userId, maxActive = runtime('maxActiveStoryJobsPerUser')) {
  await txClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`story_job_create:${userId}`]);
  const raced = await txClient.query(
    `SELECT id, status FROM story_jobs WHERE user_id = $1 AND status IN ('pending', 'processing') ORDER BY created_at DESC`,
    [userId]
  );
  return { atLimit: isAtActiveStoryLimit(raced.rows.length, maxActive), activeJobIds: raced.rows.map(r => r.id) };
}

module.exports = {
  ACTIVE_STORY_LIMIT_CODE,
  activeStoryLimitBody,
  resolveLiveActiveJobs,
  isAtActiveStoryLimit,
  checkActiveCapInTransaction,
  TOTAL_TIMEOUT_MINUTES,
  HEARTBEAT_TIMEOUT_MINUTES,
};
