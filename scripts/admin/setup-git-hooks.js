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
 * Safe to run repeatedly. Never fails the install: a missing git binary or a
 * non-repo checkout (tarball, CI cache) is not a reason to break `npm install`.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const hooksDir = path.resolve(__dirname, '..', '..', '.githooks');

try {
  if (!fs.existsSync(path.join(hooksDir, 'pre-push'))) {
    console.log('[hooks] .githooks/pre-push not found — skipping hook setup');
    process.exit(0);
  }
  // Fails when this isn't a git checkout; that's fine, nothing to configure.
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });

  const current = (() => {
    try {
      return execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();

  // Compare the RAW stored value, never a resolved one: a relative ".githooks"
  // resolves to the right place from the main clone and so would look correct,
  // while still being the broken setting that leaves worktrees unprotected.
  if (path.isAbsolute(current) && path.resolve(current) === hooksDir) {
    console.log('[hooks] already configured');
    process.exit(0);
  }

  execFileSync('git', ['config', 'core.hooksPath', hooksDir], { stdio: 'ignore' });
  console.log(`[hooks] core.hooksPath -> ${hooksDir}`);
  console.log('[hooks] pushes to staging/master now abort while that environment is busy');
} catch (err) {
  console.log(`[hooks] setup skipped (${err.message.split('\n')[0]})`);
}
