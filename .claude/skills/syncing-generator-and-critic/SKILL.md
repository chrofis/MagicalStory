---
name: syncing-generator-and-critic
description: Use when adding, tightening or reclassifying a rule in any evaluator, judge, reviewer, checker or audit prompt — image-evaluation, image-semantic, image-prompt-compliance, scene-review, plan-check, story-text-audit/proofread, avatar-evaluation — before declaring the change done
---

# Syncing Generator and Critic

## Overview

A judge and the thing it judges are siblings. The repo's second-commonest partial
fix, after the plain sibling miss, is **a rule added to the critic and never told to
the generator**. The page is then penalised for something it was never asked to do:
the finding is real, the score is real, and no rewrite can satisfy it, because the
instruction does not exist on the side that writes the page.

**Core principle: a rule a judge can deduct for is a rule the generator was given.**

The inverse is also a defect, and fires more often than people expect: teach the
generator a new behaviour and its judge will score the novelty as a fault.

## Procedure

1. Find the pair in `scripts/admin/sibling-registry.json` — the sets with
   `axis: "generator-vs-critic"` declare `generators` and `critics` explicitly:

       node scripts/admin/check-sibling-paths.js --list

2. State which side you are editing and what the other side must now know.
3. **Prefer ONE JS constant injected into BOTH templates** over two hand-kept copies.
   Two copies of a rule is the same disease one level down; it will drift within
   weeks. Converge on the shared-source pattern the repo already uses.
4. A new placeholder must be DECLARED where the builder fills it. `fillTemplate`
   drops an undeclared key silently, so an undeclared placeholder ships as literal
   `{TEXT}` or as nothing at all. Pin it in `tests/unit/built-prompt-values.test.ts`
   against the REAL builder — never against template text.
5. Pre-push gate 9 blocks a commit that moves one side only. If the other side
   genuinely needs no change, say why: `Siblings-Checked: <reason>`.

## The line you may not cross alone

**Classification belongs to the prompt, and severity is the owner's call.** If the
change would alter what TYPE a finding gets, which bucket it bills to, or how much
it costs, do not code it — propose it and ask. Read `docs/SETTLED.md` first; several
of these verdicts have flip-flopped and reversing one has a protocol. Adding the
generator-side counterpart of an EXISTING judge rule is not a classification change
and needs no ask.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The judge is just being more careful" | Careful about a rule nobody was given is a guaranteed deduction, not a quality gain. |
| "The generator already sort of implies it" | "Sort of implies" is what the audit found on rule after rule. If you cannot quote the generator-side sentence, it is not there. |
| "I'll mirror the wording into both templates" | That is two sources of truth. Use one constant unless the two sides genuinely need different phrasings. |
| "It's an eval-only change, no generator impact" | Then it is a scoring change, which is the owner's call, not a quiet edit. |

## Red flags — STOP

- You are adding a D-code, a check, or a deduction and have not opened the generator.
- You are writing the same sentence into a judge prompt and a generator prompt.
- You are about to add a placeholder without declaring it in the builder.
