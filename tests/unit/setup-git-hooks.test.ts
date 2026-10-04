/**
 * core.hooksPath always names the MAIN working tree's .githooks (2026-10-04):
 * the setting lives in the shared .git/config, so an `npm install` in an agent
 * worktree must not repoint every worktree at itself.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const req = createRequire(import.meta.url);
const { resolveHooksDir } = req('../../scripts/admin/setup-git-hooks');

const main = path.resolve('/repo');
describe('resolveHooksDir', () => {
  it('from an agent worktree: the main tree, never the worktree', () => {
    const wt = path.join(main, '.claude', 'worktrees', 'agent-x');
    const git = (args: string[]) => (args[1] === '--git-common-dir' ? `${path.join(main, '.git')}\n` : '');
    expect(resolveHooksDir({ cwd: wt, git })).toBe(path.join(main, '.githooks'));
  });
  it('from the main tree, where git answers a relative ".git"', () => {
    expect(resolveHooksDir({ cwd: main, git: () => '.git\n' })).toBe(path.join(main, '.githooks'));
  });
  it('no answer from git is an error the caller logs, not a guess', () => {
    expect(() => resolveHooksDir({ cwd: main, git: () => '' })).toThrow();
  });
});
