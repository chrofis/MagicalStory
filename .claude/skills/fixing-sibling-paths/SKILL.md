---
name: fixing-sibling-paths
description: Use when fixing any bug or patching existing behavior, before declaring the fix done — especially in image versioning, clothing, covers, prompts, repair, or anything with dev/prod routes, single-pass/fallback branches, or Grok/Gemini variants
---

# Fixing Sibling Paths

## Overview

A bug found at one call site is almost never alone in this codebase. The #1 historical failure (60+ repeat-fix commits): logic is duplicated across sibling paths, a fix lands on one, and the bug "returns" because it was never gone elsewhere. The active-version lookup was fixed **15 times** across different endpoints; the data-URI strip was hand-rolled in **56 places**; one week's clothing/cover fixes missed **5 sibling paths** (commit `fix(clothing+covers): finish last week's fixes on their sibling paths`).

**Core principle: a fix is done when every sibling of the buggy code is fixed or consolidated — not when the reported symptom disappears.**

## Procedure

1. Root-cause the reported site first (systematic-debugging skill).
2. **Before writing the fix**, grep repo-wide for the buggy pattern — the literal expression (`version_index = 0`, a field access, an instruction string) AND its paraphrases. List every hit.
3. Walk the sibling axes below and name each counterpart explicitly ("prod route = X, dev route = Y — checked both").
4. If ≥3 copies exist, consolidate into one helper/chokepoint instead of patching copies. Consolidation always won historically; it just arrived ~5 months and ~40 fixes late.
5. Commit message lists the siblings checked, so the next session can see coverage.

## Sibling axes (every one has shipped a one-sided fix before)

| Axis | Real example that stayed broken |
|---|---|
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
| "The user reported this one endpoint" | The other endpoints have the same bug; they're just not reported *yet*. 15 active-version fixes prove it. |
| "It's a 3-line fix, grep is overkill" | Each of the 15 version fixes was a 3-line fix. The grep takes 60 seconds. |
| "I'll consolidate later" | "Later" was 56 data-URI copies deep. Consolidate at copy #3. |
| "I verified the reported symptom is gone" | That proves one path. Done = all paths enumerated. |

## Red flags — STOP and sweep

- You're about to say "fixed" having edited exactly one file.
- The bug involves a value that exists in more than one store (versions, clothing, language, credits).
- You found the same expression pasted in a second place and kept going.
