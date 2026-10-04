/**
 * Judge a just-completed story against the verification registry and store the
 * verdicts (owner, 2026-09-27: "after every staging story, the code-checkable
 * verify checks run automatically").
 *
 * One engine: scripts/admin/verify-core.js, the same module verify-run.js
 * uses — no copy of any check. The server has no .git, so every entry commit is
 * taken as present here (ASSUME_CONTAINED); `verify-run.js --pull` re-checks
 * containment with git before anything reaches tasks/verify.json.
 *
 * Staging only: runtime('verifyAutoCheck'). Called fire-and-forget after the
 * completion write (storyJobPipeline.js) — it never throws, never blocks the
 * story, and logs a failure of its own loudly.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { runtime, environmentName } = require('../config/runtime');

const REGISTRY = path.join(__dirname, '..', '..', 'tasks', 'verify.json');

/**
 * @param {string} storyId
 * @param {{ pool: { query: Function }, registryPath?: string }} opts
 * @returns {Promise<object|null>} the stored report, or null when off / failed
 */
async function runVerifyAutoCheck(storyId, { pool, registryPath = REGISTRY } = {}) {
  if (!runtime('verifyAutoCheck')) return null;
  try {
    const core = require('../../scripts/admin/verify-core');
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const env = environmentName();
    const ctx = await core.loadRun(pool, storyId, env);
    // Superseded entries describe code that no longer runs; every other status is judged,
    // so a confirmed entry that breaks on a later run shows up as FAILED in the report.
    const targets = (reg.entries || []).filter(e => e.status !== 'superseded');
    const verdicts = core.judgeAll(targets, ctx, core.ASSUME_CONTAINED).map(({ e, j }) => core.verdictOf(e, j));
    const counts = { CONFIRMED: 0, FAILED: 0, HUMAN: 0, 'NOT COVERED': 0 };
    for (const v of verdicts) counts[v.result] += 1;
    const runAt = ctx.job?.createdAt || ctx.createdAt;
    const report = { storyId, env, build: ctx.build, runAt: runAt ? runAt.toISOString() : null, judgedAt: new Date().toISOString(), verdicts };
    await pool.query(
      `INSERT INTO story_verify_reports (story_id, env, build, registry_entries, counts, report)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (story_id) DO UPDATE SET env = EXCLUDED.env, build = EXCLUDED.build,
         registry_entries = EXCLUDED.registry_entries, counts = EXCLUDED.counts, report = EXCLUDED.report,
         created_at = CURRENT_TIMESTAMP`,
      [storyId, env, ctx.build, targets.length, JSON.stringify(counts), JSON.stringify(report)]);
    log.info(`[VERIFY] ${storyId}: ${targets.length} registry entries judged — ${counts.CONFIRMED} CONFIRMED, ${counts.FAILED} FAILED, ${counts.HUMAN} HUMAN, ${counts['NOT COVERED']} NOT COVERED (build ${String(ctx.build || 'unrecorded').slice(0, 9)}; containment re-checked by verify-run.js --pull)`);
    const failed = verdicts.filter(v => v.result === 'FAILED');
    if (failed.length) {
      log.error(`[VERIFY] ${storyId}: FAILED ${failed.map(v => `${v.id} (${String(v.detail || '').slice(0, 120)})`).join('; ')}`);
    }
    return report;
  } catch (err) {
    log.error(`[VERIFY] auto-check failed for ${storyId}: ${err && err.stack ? err.stack : err}`);
    return null;
  }
}

module.exports = { runVerifyAutoCheck };
