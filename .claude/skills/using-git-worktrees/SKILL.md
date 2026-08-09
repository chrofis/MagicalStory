---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with safety verification
---

# Using Git Worktrees

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches without switching.

## Directory selection

1. Use `.worktrees/` at the repo root (create it if missing).
2. **Before creating a worktree, verify the directory is git-ignored:** `git check-ignore -q .worktrees` — if not, add it to `.gitignore` and commit that first. This prevents worktree contents polluting the repo.

## Creation

```bash
git worktree add .worktrees/<branch-name> -b <branch-name>
cd .worktrees/<branch-name>
npm install && (cd client && npm install)
```

Python photo-analyzer deps (`pip install -r requirements.txt`) only if the work touches `photo_analyzer.py`.

## Baseline check

Do NOT run `npm test` as a baseline gate — in this repo that's a Playwright browser suite, several minutes long. Instead:

```bash
node --check server.js                 # server parses
cd client && npx tsc --noEmit          # client type-checks
```

If the work touches an area with unit tests (`tests/unit/`), run those. Run the full Playwright suite only when the task itself calls for it.

Report: worktree path, baseline status, ready to implement.

## Watch out: hooks

`core.hooksPath` is set to an ABSOLUTE path by `npm install` (pre-push idle gate). A worktree on an old branch without `.githooks/pre-push` would silently skip the hook if the path were relative — that's why it's absolute. Don't change it.

## Integration

- Work in the worktree via the executing-plans skill.
- When done, finishing-a-development-branch handles merge/PR and worktree cleanup (`git worktree remove <path>`).
