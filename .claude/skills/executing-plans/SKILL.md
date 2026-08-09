---
name: executing-plans
description: Use when you have a written implementation plan to execute - covers direct execution, delegating tasks to subagents, and parallel dispatch of independent work
---

# Executing Plans

Load the plan, review it critically, then execute — either directly in batches, or by delegating tasks to subagents. One skill, one decision: delegate or not.

## Step 1: Load and Review

1. Read the plan file; extract all tasks into a task list.
2. Review critically — raise concerns with the user before starting.

## Step 2: Choose the execution mode

- **Direct** (default): you implement the tasks yourself, in batches of ~3, reporting between batches for review.
- **Delegated**: dispatch a fresh subagent per task when tasks are self-contained and context pollution is a risk. Prompt templates in this directory: `implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`. After each implementer, run spec-compliance review first, then code-quality review; the implementer fixes findings and the reviewer re-reviews until clean.
- **Parallel dispatch**: only for genuinely independent tasks — different files/subsystems, no shared state, no ordering. Send the agents in a single message so they run concurrently.

**Independence test before parallelizing:** would fixing one task change your approach to another? Do two tasks touch the same files? Is a shared root cause plausible? Any "yes" → sequential (or a single agent).

**Subagent prompts must be:** focused (one problem domain), self-contained (all context pasted in — the agent doesn't get the conversation), constrained ("don't change production code" / "fix only X"), and explicit about the expected output. Verify a subagent's work from the diff, not its report.

## Step 3: Execute and report

Per batch/task: implement, run the verifications the plan specifies, mark complete. Between batches: report what was done, show verification output, wait for feedback.

**Stop and ask when:** blocked mid-task, an instruction is unclear, verification fails repeatedly, or the plan has a gap. Don't guess through blockers.

## Step 4: Finish

After all tasks are complete and verified, use the finishing-a-development-branch skill (verify, present merge/PR options).
