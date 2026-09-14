#!/usr/bin/env node
/**
 * Pre-push gate: refuse to push when the target environment has work in flight.
 *
 * WHY: every push redeploys, and a redeploy restarts the container. Anything
 * running in-process dies with it — a story generation (real, paid-for, a user
 * waiting) or a Test Lab experiment (killed mid-await, row stuck at 'running'
 * with zero results). We lost two outline-review experiments in one afternoon to
 * exactly this, from sessions that had no idea a run was going.
 *
 * Truth comes from the deployed app, not from this script: GET /api/health/busy
 * evaluates the same busy probes the idle-shutdown watcher uses, so there is one
 * definition of "busy" instead of two that drift.
 *
 * Invoked by .githooks/pre-push with git's ref lines on stdin. Bypass a block
 * with `git push --no-verify` when you know the run is expendable.
 *
 * Run BY HAND (no argv from git) it is the status check CLAUDE.md points at: it
 * probes every environment it knows and reports each one. It used to print
 * nothing and exit 0, which reads as "all clear" — the opposite of what an
 * unreachable or busy environment means.
 *
 * BOTH MODES REACH THE SAME VERDICT (2026-09-14). Whatever blocks a push also
 * fails the status check: same probe, same renderVerdict, same `blocked` fold in
 * evaluateTargets(), same exit code. A by-hand run over a busy environment exits
 * 1 and says so on stdout. It previously exited 0 and warned on stderr, so
 * `check-push-idle.js; echo EXIT=$?` reported a clean all-clear seconds before
 * the hook refused the same push.
 */

const ENVIRONMENTS = {
  'refs/heads/staging': { name: 'staging', base: 'https://staging.magicalstory.ch' },
  'refs/heads/master': { name: 'production', base: 'https://magicalstory.ch' },
};

const ZERO_SHA = /^0+$/;

/**
 * git feeds "<localRef> <localSha> <remoteRef> <remoteSha>" per ref pushed.
 * Read as a stream, not readFileSync(0): a sync read of fd 0 followed by async
 * I/O aborts the process on Windows (libuv UV_HANDLE_CLOSING assertion).
 */
function readRefs() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve([]); // manual run — no refs to gate
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(parseRefs(raw)));
    process.stdin.on('error', () => resolve(parseRefs('')));
  });
}

function parseRefs(raw) {
  return raw
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/**
 * Ask the environment whether it is busy.
 * Returns { verdict: 'idle' | 'busy' | 'unknown', reasons, detail }.
 *
 * A stopped container is genuinely idle — nothing can be running inside it — so
 * it must not block. Railway serves 502/503 from its edge for a stopped
 * deployment, and a host that refuses the connection has nothing listening;
 * both are positive evidence that the deployment is down.
 * A timeout or any other 5xx is NOT proof of idleness, so those block.
 *
 * A DNS FAILURE IS NOT EVIDENCE (2026-09-14). ENOTFOUND / EAI_AGAIN mean the
 * name never resolved — a flaky laptop resolver produces both, and the answer
 * then says nothing whatsoever about what is running inside the container. They
 * used to be classed with ECONNREFUSED as "down", so a local network hiccup
 * printed a green "is idle" over a production generation in flight. Unknown is
 * not idle: they block.
 */
async function probe(base) {
  let res;
  try {
    res = await fetch(`${base}/api/health/busy`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    // undici reports the real reason on `cause`, and for a multi-address host
    // (IPv4 + IPv6) aggregates the per-attempt errors into `cause.errors`.
    const DEPLOYMENT_DOWN = ['ECONNREFUSED'];
    const codes = [err?.cause?.code, ...(err?.cause?.errors || []).map(e => e?.code)].filter(Boolean);
    const down = codes.find(c => DEPLOYMENT_DOWN.includes(c));
    if (down) {
      return { verdict: 'idle', reasons: [], detail: `container is down (${down}) — nothing can be running` };
    }
    const why = codes[0] || err?.cause?.message || err.message;
    return { verdict: 'unknown', reasons: [], detail: `could not reach ${base} (${why})` };
  }

  if (res.status === 502 || res.status === 503) {
    return { verdict: 'idle', reasons: [], detail: `container is stopped (HTTP ${res.status}) — nothing can be running` };
  }

  // The environment predates this gate (or the route was lost). Blocking would
  // deadlock: the fix can only ship by pushing. Allow, but say it loudly —
  // silence here would read as "verified idle".
  if (res.status === 404) {
    return { verdict: 'ungated', reasons: [], detail: '/api/health/busy is not deployed there yet — nothing was verified' };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { verdict: 'unknown', reasons: [], detail: `HTTP ${res.status} with an unreadable body` };
  }

  if (!res.ok || typeof body.busy !== 'boolean') {
    return { verdict: 'unknown', reasons: body.reasons || [], detail: `HTTP ${res.status} from /api/health/busy` };
  }
  return {
    verdict: body.busy ? 'busy' : 'idle',
    reasons: body.reasons || [],
    detail: `commit ${body.commit || '?'}`,
  };
}

/**
 * One environment's probe result as output lines + whether it blocks.
 *
 * `manual: true` is the by-hand status report: it says what each environment is
 * doing without the push-gate framing (there is no push to block, and "PUSH
 * BLOCKED" on a status check is a lie). Hook mode (`manual: false`) is the
 * original wording, byte for byte — this gate decides every push in the repo.
 *
 * Each line is [stream, text] with stream one of 'log' | 'warn' | 'error'.
 */
function renderVerdict(target, { verdict, reasons = [], detail }, { manual = false } = {}) {
  if (verdict === 'idle') {
    return { blocked: false, lines: [['log', `✓ ${target.name} is idle — ${detail}`]] };
  }
  if (verdict === 'ungated') {
    return { blocked: false, lines: [['warn', `⚠ ${target.name} NOT CHECKED — ${detail}`]] };
  }

  if (manual) {
    // STDOUT, not stderr (2026-09-14). The ✓ lines go to stdout, so routing the
    // bad news to stderr meant a stdout-only capture — an agent, a pipe, a log —
    // saw nothing but green ticks for the environments that happened to be idle.
    // One report, one stream.
    const lines = [];
    if (verdict === 'busy') {
      lines.push(['log', `✗ ${target.name} is BUSY — a push would kill:`]);
      for (const r of reasons) lines.push(['log', `  • ${r}`]);
    } else {
      lines.push(['log', `? ${target.name} — could not prove it is idle: ${detail}`]);
    }
    return { blocked: true, lines };
  }

  const lines = [];
  if (verdict === 'busy') {
    lines.push(['error', `\n✗ PUSH BLOCKED — ${target.name} is busy`]);
    for (const r of reasons) lines.push(['error', `  • ${r}`]);
    lines.push(['error', '\nThis push would restart the container and kill that work.']);
  } else {
    lines.push(['error', `\n✗ PUSH BLOCKED — could not prove ${target.name} is idle`]);
    lines.push(['error', `  • ${detail}`]);
    lines.push(['error', '\nUnknown is not idle: something may be running that a deploy would kill.']);
  }
  lines.push(['error', 'Wait for it to finish, or override with: git push --no-verify\n']);
  return { blocked: true, lines };
}

/**
 * Which environments this invocation reports on.
 * Hook: only the ones the pushed refs actually deploy to (a feature branch or a
 * tag deploys nothing, so it stays silent and ungated).
 * Manual: all of them — the user asked for status, so give them status.
 */
function resolveTargets(refs, { manual = false } = {}) {
  if (manual) return Object.values(ENVIRONMENTS);
  return [...new Set(refs.filter(r => !ZERO_SHA.test(r.localSha)).map(r => r.remoteRef))]
    .map(ref => ENVIRONMENTS[ref])
    .filter(Boolean);
}

/**
 * HOOK or MANUAL is decided by ARGV, not by stdin.
 *
 * git calls a pre-push hook with two arguments — the remote name and its URL —
 * and `.githooks/pre-push` forwards them verbatim (`exec node … "$@"`). A
 * by-hand run passes none. That is the only signal available BEFORE reading
 * stdin, and reading stdin is exactly what must be avoided on a manual run:
 * with no refs coming, the stream's `end` never fires and the process hangs.
 *
 * Two weaker signals were tried and rejected (2026-09-13):
 *   `process.stdin.isTTY` — false for an agent shell, a CI step, a wrapper
 *     script and `node check-push-idle.js < /dev/null`. All four then took the
 *     hook path, resolved zero targets and exited 0 printing nothing, which is
 *     the silence being reported on. Most by-hand runs in this project are not
 *     interactive.
 *   "no refs arrived on stdin" — correct in principle, but it cannot be known
 *     without waiting for stdin to close, and racing a timer against git's refs
 *     risks treating a REAL push as manual and letting it through ungated. The
 *     gate exists to protect a running generation; it may never fail open.
 *
 * `readRefs()` keeps its own isTTY shortcut as a second belt for an interactive
 * invocation that somehow reaches it.
 */
function isHookInvocation(argv = process.argv) {
  return Array.isArray(argv) && argv.length > 2;
}

/**
 * THE VERDICT — one resolver, both readers.
 *
 * The hook and the by-hand status check are the same file, but they used to fold
 * their per-environment results into an ANSWER differently: the hook returned
 * exit 1 when anything blocked, the manual run returned exit 0 unconditionally.
 * Same endpoint, same probe, same rendering — opposite verdicts on the channel
 * that scripts and agents actually read. `node scripts/admin/check-push-idle.js;
 * echo EXIT=$?` printed EXIT=0 with a Test Lab experiment running, and the hook
 * refused the very next push (2026-09-13, twice).
 *
 * So the fold lives HERE and returns `blocked` to both callers, and main() turns
 * that one flag into the exit code with no mode in the expression. Whatever
 * blocks a push also fails the status check.
 *
 * @param probeFn injectable for tests — the only seam; the decision is not.
 */
async function evaluateTargets(targets, { manual = false } = {}, probeFn = probe) {
  let blocked = false;
  const lines = [];
  for (const target of targets) {
    const result = await probeFn(target.base);
    const rendered = renderVerdict(target, result, { manual });
    if (rendered.blocked) blocked = true;
    lines.push(...rendered.lines);
  }
  return { blocked, lines };
}

async function main() {
  const hook = isHookInvocation();
  // A manual run never reads stdin: nothing will close it, and there is
  // nothing to gate.
  const refs = hook ? await readRefs() : [];
  const targets = resolveTargets(refs, { manual: !hook });
  const manual = !hook;

  if (targets.length === 0) return; // hook on a feature branch / tag — no deploy, no gate

  if (manual) console.log('Checking whether each environment is idle (a deploy restarts the container)…');

  const { blocked, lines } = await evaluateTargets(targets, { manual });
  for (const [stream, text] of lines) console[stream](text);

  // exitCode, not process.exit(): let stdio flush before the process ends.
  // NO `manual` TERM HERE — that is the divergence this file was fixed for.
  // A status check that exits 0 over a busy environment is a false all-clear.
  process.exitCode = blocked ? 1 : 0;
}

if (require.main === module) {
  main().catch(err => {
    // The gate itself failing must not become a way to push blind.
    console.error(`\n✗ PUSH BLOCKED — idle check crashed: ${err.message}`);
    console.error('Override with: git push --no-verify\n');
    process.exitCode = 1;
  });
}

// Exported for tests/manual/test-push-idle-gate.js — the verdict logic decides
// whether every push in this repo is allowed, so it gets exercised directly.
module.exports = {
  probe, parseRefs, ENVIRONMENTS, renderVerdict, resolveTargets, isHookInvocation, evaluateTargets,
};
