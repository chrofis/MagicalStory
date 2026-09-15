---
name: fixing-sibling-paths
description: Use when fixing any bug or patching existing behavior, before declaring the fix done — especially in image versioning, clothing, covers, prompts, repair, or anything with dev/prod routes, single-pass/fallback branches, or Grok/Gemini variants
---

# Fixing Sibling Paths

## Overview

A bug found at one call site is almost never alone in this codebase. The #1 historical failure class: logic is duplicated across sibling paths, a fix lands on one, and the bug "returns" because it was never gone elsewhere. The active-version lookup was fixed over a dozen times across different endpoints; the data-URI strip was hand-rolled in dozens of places before consolidation; whole weeks of clothing/cover fixes have had to be re-done on their missed siblings.

**Core principle: a fix is done when every sibling of the buggy code is fixed or consolidated — not when the reported symptom disappears.**

## The registry is the first stop, not this file

`scripts/admin/sibling-registry.json` declares the sibling sets mechanically, and
two consumers enforce them: the pre-push gate `scripts/admin/check-sibling-paths.js`
(gate 9 in `.githooks/pre-push`) and `tests/unit/sibling-parity.test.ts`. Run

    node scripts/admin/check-sibling-paths.js --list

before declaring any fix done, and **add a set the moment you discover a sibling
pair the registry does not know about** — that is the only way this stops
repeating. Full explainer: `docs/sibling-paths.md`.

This skill existed for five weeks and did not prevent a single one of the 27
partial fixes found in the 2026-09-15 sweep of a 60-hour window. A skill is
advisory; the registry is a control. Use both, and trust the registry.

## Procedure

1. Root-cause the reported site first (systematic-debugging skill).
2. **Before writing the fix**, grep repo-wide for the buggy pattern — the literal expression (`version_index = 0`, a field access, an instruction string) AND its paraphrases. List every hit.
3. Walk the sibling axes below and name each counterpart explicitly ("prod route = X, dev route = Y — checked both").
4. If ≥3 copies exist, consolidate into one helper/chokepoint instead of patching copies. Consolidation always won historically; it just always arrived many fixes too late.
5. Commit message lists the siblings checked, so the next session can see coverage.
   If a declared sibling genuinely needs no change, say why with the gate's escape
   marker: `Siblings-Checked: <reason>`. An empty marker is not accepted.
6. If the gate blocks an EARLIER commit whose sibling was fixed in an already-pushed
   commit, do not rebase to reword it — add one `git commit --allow-empty` that
   vouches for it by sha: `Siblings-Checked: <sha-prefix ≥ 7> — <reason>`. One such
   commit can carry a line per blocked commit, and the gate prints `vouched by <sha>`.
   A vouch adds history instead of rewriting hashes other notes cite. It fails closed
   on an unresolvable, out-of-range, ambiguous or self-referential sha, or a missing
   reason — and a vouch for another commit never excuses its own siblings.

## Sibling axes (every one has shipped a one-sided fix before)

Every axis below with a registry entry is enforced; the rest are still yours to
walk by hand — and to add.

| Axis | Real example that stayed broken |
|---|---|
| Per-page vs all-pages Art Director template | `crowdExpected` declared only in `scene-expansion.txt`; the live beats path runs `scene-expansion-all.txt`, read it as false on all 16 pages, and 9 took an `extra_character` CRITICAL for correct crowds |
| Lector prompt vs diff-pass prompt | "quote the whole sentence" landed on the lector; the diff pass kept "the shortest span" against the same applier |
| Streaming vs non-streaming provider entry point | `callOpenRouterAPI` shipped with no `guardPromptString`; all seven siblings had it |
| Gemini primary vs Grok fallback branch | fallback reassigned `modelId` on one branch only, so `servedByModel` named Gemini while Grok answered — an A/B comparing a model with itself |
| Prod route vs dev route | cover imageUrl fallback fixed in dev iterate, missed in `/regenerate/cover` |
| Single-pass vs fallback branch | cover solid-ground rule fixed in single-pass, missed in two-pass |
| Grok path vs Gemini path | repair fix on Grok path, Gemini inpaint fallback kept sending Grok model id |
| Helper vs inline copy | `scoring.js` helper fixed, inline finalScore math in `images.js` not |
| Main pipeline vs trial pipeline | trial skips/duplicates several stages — check both |
| Generation prompt vs retry/repair prompt | retry empty-scene instruction still said "lighter tones, white box" |
| Write path vs read path | hardened sanitizer on write broke all readers |
| Backend vs frontend duplicate of same rule | version resolution re-implemented per UI panel |

## Rationalizations

| Excuse | Reality |
|---|---|
| "The user reported this one endpoint" | The other endpoints have the same bug; they're just not reported *yet*. The version-lookup history proves it. |
| "It's a 3-line fix, grep is overkill" | Every one of the repeat version fixes was a 3-line fix. The grep takes 60 seconds. |
| "I'll consolidate later" | "Later" historically meant dozens of copies deep. Consolidate at copy #3. |
| "I verified the reported symptom is gone" | That proves one path. Done = all paths enumerated. |

## Red flags — STOP and sweep

- You're about to say "fixed" having edited exactly one file.
- The bug involves a value that exists in more than one store (versions, clothing, language, credits).
- You found the same expression pasted in a second place and kept going.
- You are about to write `Siblings-Checked:` without a concrete reason.
