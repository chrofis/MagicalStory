---
name: smoke-testing-before-push
description: Use before pushing any server or client code change to staging or master, especially edits adding new branches, error handlers, or rarely-executed paths
---

# Smoke-Testing Before Push

## Overview

~50 commits in this repo's history are fixes for `X is not defined` / TDZ / crashloop errors that reached deployment — every one preventable by executing the changed lines once. Server JS has no TypeScript and no lint gate; the deploy pipeline is the only executor. **Core principle: never push a line of code that has never been executed.**

## Gate (run all, in order)

```bash
# 1. Parse check — catches stray brackets that crashloop the whole server
node --check server/lib/<changed>.js

# 2. Module load — catches top-level ReferenceError, bad require
node -e "require('./server/lib/<changed>.js'); console.log('ok')"

# 3. EXECUTE the changed lines (see below)

# 4. Client changes: type-check
cd client && npx tsc --noEmit

# 5. Stage only your files — the working tree is full of junk
git add <files individually>; git diff --cached
```

## Step 3 — the one everyone skips

The historical crash class is a ReferenceError **inside a branch that only runs on a rare trigger** (`entityReport not defined in Grok repair scope`, `blackoutBuffer is not defined`, `finally was throwing ReferenceError`). `node --check` cannot see these; only execution can.

**You do not need the real trigger.** Scope crashes don't require realistic inputs — they require the lines to run once. Options, cheapest first:

- Call the function directly with stub data: `node -e` or a scratch script in the scratchpad that `require`s the module and invokes the function with minimal fake args forcing your branch (e.g. a fake Grok response with mismatched dimensions).
- Temporarily flip the branch condition locally, run, flip back.
- Use the existing harnesses: `scripts/test-scene.js`, `scripts/analysis/review-page.js`, `npm run showcase:local`.

If you truly cannot execute the branch, say so explicitly to the user *before* pushing — don't silently downgrade to "eyeball review".

## Rationalizations

| Excuse | Reality |
|---|---|
| "The path only runs when Grok misbehaves — can't reproduce" | You don't need Grok. Stub the input; you're testing scope, not behavior. 2 minutes. |
| "It's 15 lines, it reads correct" | `entityReport`, `blackoutBuffer`, `storedEntityReport`, `generatedStory` all "read correct". All crashed prod. |
| "node --check passed" | Parse ≠ execute. Every ReferenceError in history passed `node --check`. |
| "It's 23:30, user wants it tonight" | The crashloop at 23:45 takes longer than the stub call at 23:31. |

## Red flags — STOP

- About to push a branch you have never seen execute.
- The words "rarely-executed path" and "static check is enough" in the same thought.
- `git add -A` or `git add .` in this working tree.
