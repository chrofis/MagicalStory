'use strict';
/**
 * Launch gate: never start a story run into a deploy window.
 *
 * The pre-push hook asks the environment whether it is BUSY, and that check is
 * honest — but the kill happens minutes later. Railway builds for 1-3 minutes
 * after a push, and only then swaps the container, so a run launched inside
 * that window dies with "Server restarted during generation" (job
 * job_1786917705204, killed at 3%). Nothing reports a pending build: /api/health
 * shows the commit that is RUNNING, and busy shows what that container is doing.
 *
 * The gap is visible from here, though: origin's tip vs the deployed commit.
 * If they differ, a build is either running or about to, and launching is a
 * waste of money. This is the launcher-side half of the same guard the hook
 * gives the pusher.
 */

const { execSync } = require('child_process');

/** Deployed commit for an environment, or null when it cannot be read. */
async function deployedCommit(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = await res.json();
    return (body.commit || '').slice(0, 8) || null;
  } catch {
    return null;
  }
}

/** Tip of the branch this environment deploys from, fetched fresh. */
function originTip(branch) {
  try {
    execSync(`git fetch origin ${branch} --quiet`, { stdio: 'ignore' });
    return execSync(`git rev-parse --short=8 origin/${branch}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} base    e.g. https://staging.magicalstory.ch
 * @param {string} branch  the branch that environment deploys from
 * @returns {Promise<{ok: boolean, reason: string}>}
 *   ok:false when a build is in flight (deployed !== origin tip). Unknown state
 *   (no network, no git) resolves to ok:true with the reason recorded — this
 *   gate exists to catch a specific known failure, not to block on uncertainty.
 */
async function checkDeployWindow(base, branch = 'staging') {
  const [deployed, tip] = [await deployedCommit(base), originTip(branch)];
  if (!deployed || !tip) {
    return { ok: true, reason: `deploy window unverified (deployed=${deployed || '?'}, origin/${branch}=${tip || '?'})` };
  }
  if (deployed !== tip) {
    return {
      ok: false,
      reason: `a deploy is in flight — ${base} runs ${deployed}, origin/${branch} is ${tip}. `
        + 'Launching now means the container restarts mid-generation and the run dies. Wait for the deploy to land.',
    };
  }
  return { ok: true, reason: `deployed commit ${deployed} matches origin/${branch}` };
}

module.exports = { checkDeployWindow, deployedCommit, originTip };
