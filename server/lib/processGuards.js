/**
 * PROCESS GUARDS — the last handlers before Node kills the container.
 *
 * WHY (observability review, 2026-10-07): the server registered no
 * `process.on` handlers at all. Node ≥ 20 terminates on any unhandled
 * promise rejection, which killed every in-flight paid story generation
 * with no log line, no failure_log row and no admin alert.
 *
 *   unhandledRejection → log with stack, recordFailure, admin alert (deduped
 *                        by message so a tight loop sends one mail, not 400).
 *                        The process keeps running: a rejection is a bug, but
 *                        the job state is still consistent.
 *   uncaughtException  → log, record, alert, then exit non-zero. Node's own
 *                        docs: application state is undefined after an
 *                        uncaught exception. Railway restarts the container,
 *                        and the boot zombie cleanup settles the orphaned jobs.
 *
 * No SIGTERM handler here on purpose: the pre-push deploy flow restarts the
 * container and one that touched job state could race boot zombie cleanup.
 */

const ALERT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;   // one mail per fingerprint per 10 min
const MAX_ALERTS_PER_HOUR = 20;                   // hard backstop against a loop

const _recentAlerts = new Map();
let _hourStart = 0;
let _hourCount = 0;
let _installed = false;

function _alertAllowed(fingerprint, now = Date.now()) {
  if (now - _hourStart > 3600_000) { _hourStart = now; _hourCount = 0; }
  if (_hourCount >= MAX_ALERTS_PER_HOUR) return false;
  const last = _recentAlerts.get(fingerprint);
  if (last && now - last < ALERT_DEDUPE_WINDOW_MS) return false;
  _recentAlerts.set(fingerprint, now);
  if (_recentAlerts.size > 200) {
    const oldest = [..._recentAlerts.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
    for (const [k] of oldest) _recentAlerts.delete(k);
  }
  _hourCount++;
  return true;
}

function _describe(err) {
  if (err instanceof Error) return { message: err.message, stack: err.stack || '' };
  let message;
  try { message = typeof err === 'string' ? err : JSON.stringify(err); } catch { message = String(err); }
  return { message: String(message), stack: '' };
}

/**
 * Handle one process-level failure. Exported for tests; never throws.
 * @returns {Promise<{alerted: boolean}>}
 */
async function handleProcessFailure(kind, err, { log, recordFailure, sendAdminAlert, now }) {
  const { message, stack } = _describe(err);
  try { log.error(`[PROCESS] ${kind}: ${message}${stack ? `\n${stack}` : ''}`); } catch { /* logging must not fail the guard */ }
  try {
    recordFailure({
      kind: `process_${kind}`,
      severity: 'internal',
      fingerprint: message.slice(0, 200),
      summary: `${kind}: ${message}`.slice(0, 2000),
      detail: { stack: stack.slice(0, 3000) },
    });
  } catch { /* recordFailure swallows its own errors; belt and braces */ }
  if (!_alertAllowed(`${kind}|${message.slice(0, 200)}`, now)) return { alerted: false };
  try {
    await sendAdminAlert(`process-${kind}`, 'process', 'server', 'N/A', `${kind}: ${message}\n\n${stack}`);
    return { alerted: true };
  } catch (alertErr) {
    try { log.error(`[PROCESS] admin alert failed: ${alertErr.message}`); } catch { /* ignore */ }
    return { alerted: false };
  }
}

/**
 * Install the two handlers once. Idempotent: a second call is a no-op so a
 * re-required server module cannot stack handlers.
 *
 * @param {object} deps
 * @param {object} deps.log               { error }
 * @param {Function} deps.recordFailure   server/lib/failureLog.recordFailure
 * @param {Function} deps.sendAdminAlert  email.sendAdminStoryFailureAlert signature
 * @param {object} [deps.proc=process]
 * @param {Function} [deps.exit]          defaults to proc.exit
 */
function installProcessGuards({ log, recordFailure, sendAdminAlert, proc = process, exit } = {}) {
  if (!log || !recordFailure || !sendAdminAlert) throw new Error('installProcessGuards: log, recordFailure and sendAdminAlert are required');
  if (_installed) return false;
  _installed = true;
  const doExit = exit || ((code) => proc.exit(code));
  const deps = { log, recordFailure, sendAdminAlert };

  proc.on('unhandledRejection', (reason) => {
    handleProcessFailure('unhandledRejection', reason, deps);
  });
  proc.on('uncaughtException', (err) => {
    // State is undefined after this point (Node docs). Give the alert a
    // bounded window to leave, then exit so Railway restarts the container.
    const timer = setTimeout(() => doExit(1), 3000);
    handleProcessFailure('uncaughtException', err, deps).finally(() => { clearTimeout(timer); doExit(1); });
  });
  return true;
}

/** Test hook: forget installation and dedupe state. */
function _resetForTests() {
  _installed = false;
  _recentAlerts.clear();
  _hourStart = 0;
  _hourCount = 0;
}

module.exports = { installProcessGuards, handleProcessFailure, _resetForTests };
