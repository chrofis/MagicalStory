---
name: respecting-provider-invariants
description: Use when adding or modifying any call to Grok, Gemini, or Runware — prompt construction, image inputs, aspect ratios, model IDs, safety errors, PROHIBITED_CONTENT, prompt too long, or wrong-aspect outputs
---

# Respecting Provider Invariants

## Overview

Every invariant below was discovered in production and then re-learned at other call sites: the Grok 8k prompt limit was hit **4 separate times**, the Gemini safety sanitizer was re-implemented **6 times**, a Grok model ID was sent to the Gemini API **3 times**. **Core principle: provider quirks are enforced in the wrapper (`server/lib/grok.js`, `server/lib/images.js`, `server/lib/runware.js`), never handled ad hoc at a call site.** Read `docs/image-generation-methods.html` before touching any image-gen path — it is the authoritative inventory and a standing CLAUDE.md rule.

## Known invariants (verified the hard way — do not re-derive empirically)

| Provider | Invariant |
|---|---|
| Grok edit | Output aspect is coerced to **input** aspect. Never feed raw-aspect inputs; use the existing preset-aligned/pad pathways (`computePresetAlignedExtract`, magenta-pad). Pad-vs-crop was flip-flopped 4× — the current strategy is deliberate, check `docs/decisions.md` before changing it. |
| Grok | **8,000-char hard prompt limit** (`maxPromptLength` in config). Any feature concatenating prose into a Grok prompt must budget against it — do not discover it via a 400. |
| Grok | Character names / VB ids in prompts get **painted onto the image as text**. Every prompt path must run `sanitizeVbIdsInPrompt`; covers once bypassed it ("VEH001" on a truck). |
| Gemini | Safety-blocks (`PROHIBITED_CONTENT`, `IMAGE_OTHER`) on age/gender/adult-face terms. Use `sanitizeForGemini(text, level)` — never write a new inline sanitizer (the 6 re-implementations were consolidated once already). |
| Gemini | `gemini-2.5-flash` required for quality eval / bounding boxes; `gemini-2.0-flash` cannot return bboxes. |
| Runware | 3,000-char prompt limit (vs 30,000 Gemini). ACE++ takes `referenceImages` at root level, not inside `acePlusPlus`. |
| Cross-provider | Model IDs must never cross providers. Routing decides the ID; a call site never hardcodes one for "the other" path (Grok→Gemini fallback sent Grok IDs 3×). |
| Evals | Temperature 0. Non-zero temperature made eval tuning non-reproducible for months. |

## Procedure for any provider-call change

1. Read the relevant section of `docs/image-generation-methods.html` first.
2. Route the call through the existing wrapper/chokepoint; if the wrapper lacks the invariant you need, add it **to the wrapper** so every caller inherits it.
3. Check the sibling branch (single-pass vs two-pass, generate vs retry, Grok vs Gemini fallback) — fixing-sibling-paths skill.
4. New prompt content → sanitize (`sanitizeVbIdsInPrompt` / `sanitizeForGemini`) and length-budget before shipping.
5. Update `docs/image-generation-methods.html` in the same change.

## Rationalizations

| Excuse | Reality |
|---|---|
| "I'll confirm the prompt cap from xAI docs / empirically" | It's 8,000, it's in the config, and it broke prod 4 times. Check the repo first. |
| "I'll just handle the quirk at this call site" | That's how 6 sanitizers and 4 length caps accumulated. Wrapper or nothing. |
| "Padding/cropping choice is a detail" | It flip-flopped 4× because each change ignored why the last one was made. Decisions log first. |
