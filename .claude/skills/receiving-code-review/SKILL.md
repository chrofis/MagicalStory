---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - verify against the codebase, don't implement blindly
---

# Receiving Code Review

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social agreement.

## The pattern

1. Read the complete feedback before reacting.
2. If any item is unclear, stop and ask about ALL unclear items before implementing ANY — items may be related, and partial understanding produces wrong implementations.
3. Verify each suggestion against the codebase: is it technically correct here? Does it break existing functionality? Is there a reason the current code is the way it is?
4. Implement one item at a time, test each, in order: blocking issues → simple fixes → complex fixes.
5. Respond with substance, not agreement theater: state what you changed, or push back with technical reasoning. Skip the "great point!" framing — the fix itself shows you heard the feedback.

## When to push back

- The suggestion breaks existing functionality or ignores context the reviewer lacks.
- It adds an unused feature — grep for actual usage first; if nothing calls it, propose removal (YAGNI) instead of "implementing properly".
- It's technically wrong for this stack, or conflicts with a decision in `docs/decisions.md`.

Push back with evidence (working tests, verified behavior, the decision log), not defensiveness. If you pushed back and were wrong, state the correction factually and move on — no extended apology.

If you can't verify a claim, say so: "I can't verify this without X — investigate, ask, or proceed?"

## GitHub thread replies

Reply to inline review comments in the comment thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`), not as a top-level PR comment.
