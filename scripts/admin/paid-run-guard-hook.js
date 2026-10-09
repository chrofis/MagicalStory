#!/usr/bin/env node
/**
 * PreToolUse(Bash) — a paid story or trial run needs the owner's yes.
 *
 * WHY (owner, 2026-10-09): "Why do you always run stories instead of retesting
 * on existing ones … Every 20 successful tests in lab or feature we can redo a
 * story. Ensure all agents always follow the rules." One session spent about
 * USD 27.50, much of it on story and trial reruns that proved single cases.
 * The rule lives in CLAUDE.md (IRON RULE — retest on stored data), but a rule in
 * a document is advisory; this hook makes the decision the owner's for every
 * agent, because hooks run for subagent tool calls too.
 *
 * It ASKS (permission prompt), never silently blocks: an integration run after
 * 20 green stage tests is legitimate, and the owner decides. Dry runs pass.
 * Test Lab stages and stored-data replays are not matched: they are the
 * cheap path this rule pushes work onto.
 */
'use strict';

const ALLOW = { continue: true };

/** Returns a short label when the command starts a paid story/trial run, else null. */
function paidRunKind(cmd) {
  const c = String(cmd || '');
  if (/trial-showcase\.js/.test(c) && !/--dry-run\b/.test(c)) return 'trial run (trial-showcase.js)';
  if (/rerun-story-on-staging\.js/.test(c) && /--yes\b/.test(c)) return 'story rerun (rerun-story-on-staging.js --yes)';
  if (/test-scene-composite-smoke\.js/.test(c) && !/--dryRun\b/.test(c)) return 'smoke story (test-scene-composite-smoke.js)';
  if (/scripts[/\\]admin[/\\]showcase\.js|npm\s+run\s+showcase/.test(c)) return 'showcase';
  if (/curl\b[\s\S]*\/api\/(jobs|trial)\/create-story/.test(c)) return 'create-story API call';
  return null;
}

function decision(kind) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        `PAID ${kind}. IRON RULE (CLAUDE.md, owner 2026-10-09): test fixes on STORED stories `
        + `(replay / console / Test Lab, >=20 cases, report a rate); a new story or trial is an `
        + `integration check only, after 20 successful stage tests since the last run, and never to `
        + `prove one fix. Approve only if that holds and the price fits the task's stated cap.`,
    },
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let cmd = '';
    try { cmd = JSON.parse(raw || '{}')?.tool_input?.command || ''; } catch { /* not a Bash call */ }
    const kind = paidRunKind(cmd);
    process.stdout.write(JSON.stringify(kind ? decision(kind) : ALLOW));
    process.exit(0);
  });
}

module.exports = { paidRunKind, decision };
