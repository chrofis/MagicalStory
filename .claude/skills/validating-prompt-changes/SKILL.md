---
name: validating-prompt-changes
description: Use when editing prompts/*.txt, JS prompt builders, evaluator scoring rules, or eval thresholds — including "make the image/text-zone/eval do X" requests that sound like one-line prompt tweaks
---

# Validating Prompt Changes

## Overview

Prompt and eval tuning caused ~200 fix commits and the repo's worst flip-flops: the text-zone rule reversed dark↔calm across weeks of churn, gaze/tilt deductions were reverted the same day they shipped, a scoring change was reverted and re-applied within 6 minutes. Root causes: instructions duplicated across sites, validation against only the story that motivated the change, and re-litigating already-settled philosophy. **Core principle: a prompt change is validated against a corpus and against its duplicate sites, not against the one page that annoyed the user.**

## Before editing

1. **Check settled decisions first.** `docs/decisions.md` and project memory record philosophy verdicts (text zone = calm not dark; pose mirrors don't deduct; positions are relational not left/right; composite pipeline is dead). If your change contradicts one, raise it with the user — don't re-litigate silently.
2. **Find every site emitting the same instruction.** The empty-scene text-zone rule existed in FOUR places; three were fixed before the fourth was found. Grep prompts/*.txt AND the JS builders (`storyHelpers.js`, `prompts.js`, inline strings in `images.js`) for the concept, not just the exact words. Prefer moving the instruction to one chokepoint builder over patching copies.
3. **Grep the parsers.** If the change alters what the model outputs (section names, markers, JSON keys), every regex parser consuming it must be checked (see sweeping-shape-changes).
4. Style rules still apply: terse, no emphasis banners, no justification prose, archetypal examples only — never names/settings from a test story.

## Validating

- **Never validate on one story.** Test against ≥3 diverse stored pages/stories: `scripts/test-scene.js` reruns a page with CURRENT templates; compare-image-evaluations reads eval results from the DB; check the calmness/score distribution, not a single reassuring image.
- Diagnose which layer actually failed before editing any layer — authoring prompt, empty-scene instruction, pixel gate, repair prompt, and evaluator are five different owners of "the text zone".
- Known trap: "soft/calm/flat" wording makes Grok flatten the zone to dead uniform color. Emphasize calm/smooth, allow saturation.

## After

- Log philosophy changes (thresholds, deduction rules, zone semantics) in `docs/decisions.md` — flip-flops happen because the previous rationale wasn't findable.
- If the change ships and looks wrong, verify it actually deployed (reproducing-locally-first) before reverting — one revert was itself reverted 6 minutes later.

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's a one-line prompt tweak" | The line exists in 4 places and 2 parsers read its output. |
| "Yesterday's page proves the fix works" | One page is noise (evals only became reproducible at temperature 0). Corpus or nothing. |
| "The old rule is obviously wrong" | It was deliberately chosen after the opposite failed. Check decisions.md. |

## Red flags — STOP

- Editing one prompt file without grepping for sibling instruction sites.
- Declaring success from the single motivating page.
- Writing a test-story name, character, or scene into a template.
