---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims
---

# Verification Before Completion

**Core principle:** Evidence before claims. If you haven't run the verification command in this session, you can't claim it passes.

## The gate

Before claiming any status:

1. Identify the command that proves the claim.
2. Run it — fresh and complete, not a stale earlier run.
3. Read the full output: exit code, failure count.
4. State the claim WITH the evidence — or state the actual (worse) status with the evidence.

## What each claim requires

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Build succeeds | Build command: exit 0 | Linter passing, logs look fine |
| Bug fixed | Re-test of the original symptom | Code changed, assumed fixed |
| Regression test works | Red-green verified (fails without fix, passes with) | Test passes once |
| Subagent completed | The actual diff shows the changes | Agent's own success report |
| Requirements met | Line-by-line checklist against the plan | Tests passing |
| Deployed / live | `/api/health` SHA matches pushed SHA (see verify-deploy memory) | Push succeeded, time elapsed |

## Red flags — stop and run the command

- "Should", "probably", "seems to" in a status statement.
- Expressing satisfaction ("done", "all set") before running verification.
- About to commit, push, or open a PR without a fresh check.
- Trusting a subagent's report without looking at the diff.
- Tired and wanting the work to be over — that's when false claims ship.

This repo's specifics: the smoke-testing-before-push skill defines the minimum gate for pushes (parse check, module load, execute the changed lines, tsc for client). Run it — "node --check passed" is not execution.
