/**
 * The gate the pipeline passes right before it writes the story row.
 *
 * It writes the saving marker (progress = JOB_SAVING_PROGRESS, guarded on
 * status = 'processing'). From that write on, a user cancel is refused
 * (server/routes/jobs.js guards on progress < JOB_SAVING_PROGRESS), so a story is
 * never both saved and refunded.
 *
 * When the guarded write matches no row, the job is no longer live and the story
 * must NOT be saved, whatever the status is:
 *   - 'cancelled': the user cancelled (the cancel endpoint refunded).
 *   - 'failed':    the status-poll watchdog or the stale-job sweep settled the job
 *                  with a refund (server/routes/jobs.js, settleJobWithRefund) while
 *                  this worker was still running. Saving now would hand out the
 *                  story AND the refund (pipeline review 2026-11-13, finding 1).
 *   - row missing: the job row was deleted.
 *
 * checkCancellation() deliberately reacts to 'cancelled' only (a 'failed' there used
 * to trip every in-flight page slot and shadow the real error). This gate is the one
 * place where any non-processing status stops the pipeline, because here the only
 * thing left to do is the save.
 */
const { JOB_SAVING_PROGRESS } = require('./jobCredits');

class JobNoLongerLiveError extends Error {
  constructor(jobId, status) {
    super(`Job ${jobId} is no longer live (status: ${status === null ? 'row missing' : status}) - story not saved`);
    this.name = 'JobNoLongerLiveError';
    this.jobId = jobId;
    this.status = status;
  }
}

/**
 * @param {{query: Function}} pool
 * @param {string} jobId
 * @returns {Promise<void>} resolves when the job is marked saving; throws JobNoLongerLiveError otherwise
 */
async function markJobSavingOrThrow(pool, jobId) {
  const mark = await pool.query(
    `UPDATE story_jobs SET progress = $2, progress_message = 'Saving story...', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'processing' RETURNING id`,
    [jobId, JOB_SAVING_PROGRESS]
  );
  if (mark.rowCount > 0) return;
  const row = await pool.query('SELECT status FROM story_jobs WHERE id = $1', [jobId]);
  const status = row.rows.length > 0 ? row.rows[0].status : null;
  throw new JobNoLongerLiveError(jobId, status);
}

module.exports = { markJobSavingOrThrow, JobNoLongerLiveError };
