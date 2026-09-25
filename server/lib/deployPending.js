/**
 * DEPLOY-PENDING FLAG — closes the window between "the push gate said idle" and
 * "Railway restarted the container".
 *
 * The pre-push gate (scripts/admin/check-push-idle.js) checks ONE moment: the
 * instant before the push. Railway then builds and cuts over for 2-3 minutes,
 * and the old container keeps accepting work the whole time. Measured
 * 2026-09-25: Test Lab experiments 1472 and 1477 were started 35 s and 4 s after
 * their pushes landed, and both died at the cutover (docs/decisions.md,
 * 2026-08-04 gate entry, 2026-09-25 addendum).
 *
 * So once the gate has said idle, it SETS this flag on the target environment
 * (POST /api/admin/deploy-pending), and the Test Lab start routes refuse while it
 * is set. The flag lives in the `config` table as JSON, so every container of
 * that environment reads the same answer.
 *
 * It ends two ways:
 *   - a container BOOTS on the flagged commit (clearDeployPendingAtBoot). Keyed
 *     on the TARGET commit, not on "any commit other than the old one": after
 *     push A then push B, the flag names B, and A's boot must not reopen the
 *     window while B's deploy is still coming;
 *   - the TTL expires (a failed build, a deploy Railway skipped). Expiry is
 *     checked on every read, so an expired row blocks nothing even if nobody
 *     deletes it.
 *
 * Timestamps are stored as ISO strings with Z (true UTC) — never a naive
 * TIMESTAMP, which node-pg would mis-read (scripts/lib/chTime.js).
 */
'use strict';

const { log } = require('../utils/logger');

const KEY = 'deploy_pending';
const TTL_MS = 10 * 60 * 1000;
const FULL_SHA = /^[0-9a-f]{40}$/;

function defaultQuery(sql, params) {
  return require('../services/database').dbQuery(sql, params);
}

/** The stored row as a flag, or null. Expired counts as absent. Unreadable JSON throws. */
function parseFlag(raw, now) {
  if (raw == null || raw === '') return null;
  const flag = JSON.parse(raw);
  const expires = Date.parse(flag.expiresAt);
  if (!Number.isFinite(expires)) throw new Error(`deploy_pending row has no valid expiresAt: ${String(raw).slice(0, 200)}`);
  return expires > now ? flag : null;
}

async function readRaw(query) {
  const rows = await query('SELECT config_value FROM config WHERE config_key = $1', [KEY]);
  return rows[0]?.config_value ?? null;
}

/**
 * Mark the environment as about to be redeployed onto `targetCommit`.
 * A later push simply overwrites the flag with its own commit and a fresh TTL.
 */
async function setDeployPending({ targetCommit, setBy }, { query = defaultQuery, now = Date.now() } = {}) {
  if (!FULL_SHA.test(String(targetCommit || ''))) {
    throw new Error(`targetCommit must be a full 40-char commit sha, got "${targetCommit}"`);
  }
  const flag = {
    targetCommit,
    setBy: setBy || null,
    setOnCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    setAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
  };
  await query(
    `INSERT INTO config (config_key, config_value) VALUES ($1, $2)
     ON CONFLICT (config_key) DO UPDATE SET config_value = $2`,
    [KEY, JSON.stringify(flag)]
  );
  log.warn(`🚧 [DEPLOY-PENDING] set by ${flag.setBy || '?'}: deploy of ${targetCommit.slice(0, 8)} pending until ${flag.expiresAt} — Test Lab starts refused`);
  return flag;
}

/** The live flag, or null when absent or expired. */
async function getDeployPending({ query = defaultQuery, now = Date.now() } = {}) {
  return parseFlag(await readRaw(query), now);
}

/**
 * Boot hook: clear the flag when this container IS the deploy it announced, and
 * tidy an expired row. The DELETE matches the exact value read, so a flag that a
 * newer push wrote in between is never removed by mistake.
 *
 * Never throws — it runs during boot. A failure is logged as an error; the TTL
 * still ends the flag, so the worst case is ten minutes of refused Lab starts.
 * @returns {Promise<'none'|'cleared'|'expired'|'kept'|'error'>}
 */
async function clearDeployPendingAtBoot(currentCommit, { query = defaultQuery, now = Date.now() } = {}) {
  try {
    const raw = await readRaw(query);
    if (raw == null) return 'none';
    const flag = parseFlag(raw, now);
    let outcome;
    if (!flag) outcome = 'expired';
    else if (currentCommit && flag.targetCommit === currentCommit) outcome = 'cleared';
    else {
      log.warn(`🚧 [DEPLOY-PENDING] kept at boot: this container runs ${(currentCommit || 'unknown').slice(0, 8)}, the pending deploy is ${flag.targetCommit.slice(0, 8)}`);
      return 'kept';
    }
    await query('DELETE FROM config WHERE config_key = $1 AND config_value = $2', [KEY, raw]);
    log.info(`✅ [DEPLOY-PENDING] ${outcome === 'cleared' ? `cleared — booted on ${currentCommit.slice(0, 8)}` : 'expired row removed at boot'}`);
    return outcome;
  } catch (err) {
    log.error(`❌ [DEPLOY-PENDING] boot clear failed (${err.message}) — the flag ends at its TTL instead`);
    return 'error';
  }
}

/** The refusal a Test Lab start returns while a deploy is pending. */
function refusalMessage(flag, now = Date.now()) {
  const secs = Math.max(0, Math.round((Date.parse(flag.expiresAt) - now) / 1000));
  return `A deploy of ${flag.targetCommit.slice(0, 8)} is pending on this environment — the container restarts within minutes and would kill this run. ` +
    `Retry once the new commit is serving (the flag clears at its boot, or in ${secs}s at the latest).`;
}

/**
 * Express middleware for the Test Lab START routes. Its own error handling, so a
 * failed read never reaches a route's slot-release catch: a flag that cannot be
 * read refuses the start (500) rather than letting it through blind.
 */
async function refuseWhileDeployPending(req, res, next) {
  let flag;
  try {
    flag = await getDeployPending();
  } catch (err) {
    log.error(`[DEPLOY-PENDING] could not read the flag: ${err.message}`);
    return res.status(500).json({ error: `Could not check for a pending deploy: ${err.message}` });
  }
  if (flag) return res.status(409).json({ error: refusalMessage(flag), deployPending: flag });
  next();
}

module.exports = {
  KEY, TTL_MS,
  setDeployPending, getDeployPending, clearDeployPendingAtBoot, refusalMessage, refuseWhileDeployPending,
  parseFlag,
};
