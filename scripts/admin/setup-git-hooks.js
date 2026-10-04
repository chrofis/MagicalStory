#!/usr/bin/env node
/**
 * Point git at this repo's versioned hooks — run automatically by `npm install`
 * (package.json "prepare"), so a fresh clone is protected without anyone being
 * told to configure anything.
 *
 * WHY ABSOLUTE: `core.hooksPath = .githooks` is relative, and git resolves it
 * per WORKING TREE. Agent worktrees checked out on a branch older than the hook
 * commit therefore have no .githooks/pre-push — and git skips a missing hook
 * SILENTLY, with a zero exit. That is how a push killed a running Test Lab
 * experiment on 2026-08-05 even though the main clone had the hook enabled.
 * An absolute path pins every worktree to the main clone's hooks regardless of
 * which branch it has checked out.
 *
 * WHY THE MAIN WORKING TREE, NOT __dirname (2026-10-04): `core.hooksPath` lives
 * in the SHARED .git/config, so an `npm install` inside an agent worktree used
 * to repoint every worktree — the main clone included — at THAT worktree's
 * .githooks (found pointing at .claude/worktrees/agent-a5140749b699320ad).
 * Remove the worktree and git skips the hook silently. The hooks dir is now
 * resolved from `git rev-parse --git-common-dir`, whose parent is the main
 * working tree, whichever worktree runs this.
 *
 * Safe to run repeatedly. Never fails the install: a missing git binary or a
 * non-repo checkout (tarball, CI cache) is not a reason to break `npm install`.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * The main working tree's .githooks, from the shared git dir. Pure given
 * `git` (an (args) => stdout function run in `cwd`).
 */
function resolveHooksDir({ cwd, git }) {
  const common = String(git(['rev-parse', '--git-common-dir'])).trim();
  if (!common) throw new Error('git rev-parse --git-common-dir returned nothing');
  const commonDir = path.resolve(cwd, common);
  return path.join(path.dirname(commonDir), '.githooks');
}

function main() {
  const cwd = path.resolve(__dirname, '..', '..');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    // Fails when this isn't a git checkout; that's fine, nothing to configure.
    const hooksDir = resolveHooksDir({ cwd, git });
    if (!fs.existsSync(path.join(hooksDir, 'pre-push'))) {
      console.log(`[hooks] ${hooksDir}${path.sep}pre-push not found — skipping hook setup`);
      return;
    }
    const current = (() => {
      try { return git(['config', '--get', 'core.hooksPath']).trim(); } catch { return ''; }
    })();
    // Compare the RAW stored value, never a resolved one: a relative ".githooks"
    // resolves to the right place from the main clone and so would look correct,
    // while still being the broken setting that leaves worktrees unprotected.
    if (path.isAbsolute(current) && path.resolve(current) === hooksDir) {
      console.log('[hooks] already configured');
      return;
    }
    git(['config', 'core.hooksPath', hooksDir]);
    console.log(`[hooks] core.hooksPath -> ${hooksDir}${current ? ` (was ${current})` : ''}`);
    console.log('[hooks] pushes to staging/master now abort while that environment is busy');
  } catch (err) {
    console.log(`[hooks] setup skipped (${String(err.message).split('\n')[0]})`);
  }
}

if (require.main === module) main();

module.exports = { resolveHooksDir };
