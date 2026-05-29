# Architectural Decisions

The "why does the code do this?" log. Read this **before** diagnosing a
warning, before changing behaviour you don't fully understand, and before
asking the user to explain a deliberate mode-specific shortcut.

Per `CLAUDE.md`: every architectural decision is logged here. Format:

```
## Title (one sentence verdict)
**Context:**   what problem / constraint led here
**Decision:**  what we actually do
**Rationale:** why we picked this over the alternative
**Touched:**   files that implement the decision
**Status:**    ✅ active | 🟡 conditional | 🗄 superseded (with link)
```

Append new entries at the bottom of the matching section. Don't rewrite
history — if a decision is reversed, add a new entry marking the old one
superseded and link forward.

---

## Story generation

### Trial stories skip draft → analysis → revise
**Context:** Trial stories run on the `/try` flow for anonymous users, no
credits charged. They must feel instant — long generation kills conversion.
**Decision:** Trial generation uses `prompts/story-trial.txt` (172 lines, no
`---STORY DRAFT---` and no `---ANALYSIS---` sections — single-pass writing
straight into `---STORY PAGES---`). Full-account generation uses
`prompts/story-unified.txt` (951 lines, the full draft → self-critique →
patch loop).
**Rationale:** Cuts generation time roughly in half and saves ~5–10k output
tokens per story. Quality is lower than the full unified prompt (no
self-critique pass) but acceptable for the trial-conversion goal: the user
gets one taste, then claims their account to unlock the full pipeline.
**Touched:**
- `prompts/story-trial.txt` (trial prompt — no draft/analysis sections)
- `prompts/story-unified.txt` (full prompt — all sections)
- `server.js:2835` — picks prompt based on `inputData.trialMode`
- `server/lib/storyHelpers.js:5343` — `buildTrialStoryPrompt()` builder
- `server/routes/trial.js:2175` — sets `trialMode: true` on the job
- `server/lib/outlineParser/shared.js:343` — `extractDraftPagesFromText`
  accepts `{ isTrial }` and skips scanning + warning for trial responses
**Status:** ✅ active.

### Trial stories skip the quality-eval + repair pipeline
**Context:** Quality eval costs another Gemini call per page, plus the
auto-repair loop can re-generate pages and add several minutes to wall
time. Trial users won't wait.
**Decision:** Trial jobs set `skipQualityEval: true` (see
`server/routes/trial.js:2243`). `server.js:6060` short-circuits the entire
evaluation + repair pipeline when this flag is set.
**Rationale:** Same as draft skip — speed and cost. Trial output is "good
enough to demonstrate the product"; full users pay for the polish.
**Touched:**
- `server/routes/trial.js:2243` — sets the flag
- `server.js:5970, 6060, 6367` — short-circuits eval + repair
- `server/lib/styledAvatars.js`, `server/lib/character2x4Sheet.js` —
  per-call `skipQualityEval` override flows through the avatar pipeline too
**Status:** ✅ active.

### Phantom character recovery
**Context:** Sonnet sometimes references a character in scene prose or
`clothingRequirements` without declaring them in the Visual Bible. Without
recovery the downstream image-gen has no appearance description and
renders the character generically (or omits them).
**Decision:** After parsing, scan all page metadata for character names
not in the VB. For each phantom, call Sonnet with a small follow-up prompt
asking for the appearance description, append the result to the VB as a
new `CHRxxx` entry.
**Rationale:** ~$0.004 per phantom call (Sonnet 4.6) vs the alternative
of asking the main prompt to be perfect. Cheap insurance.
**Caveat:** The phantom is added to the Visual Bible (so prompts pick her
up), but the reference-sheet generator may skip generating a dedicated
reference image for single-page side characters — see the ✗ marker in
`[REF-SHEET]` log lines.
**Touched:**
- `server/lib/phantomCharacters.js` — detection + Sonnet patch call
- `server.js` (unified pipeline, after parsing) — invokes the recovery
**Status:** ✅ active.

---

## Email

### Cover hero in transactional emails — R2 URLs only, never base64
**Context:** Story emails (story-complete, trial-story-complete,
order-confirmation, order-shipped) want to show the front cover as a hero
or thumbnail. Covers exist either as a public R2 URL (`image_url`) or as
inline base64 in the DB (`image_data`).
**Decision:** `email.js`'s `getCoverPublicUrl(storyId)` returns the R2
`image_url` if present, otherwise `null`. Base64 covers are **never**
inlined. Templates wrap the hero in `{?coverUrl}…{/coverUrl}` so a null
cleanly strips the block.
**Rationale:** A typical cover is 200 KB+ as base64. Gmail clips emails
over 102 KB, hiding the unsubscribe link and downstream content. A missing
hero is better than a clipped email.
**Touched:**
- `email.js` — `getCoverPublicUrl()` helper, called by send functions
- `emails-src/components/Cover.tsx` — renders the image when URL present
- `emails-src/components/Cond.tsx` + `email.js` `fillTemplate` —
  `{?key}...{/key}` conditional block support
**Status:** ✅ active.

### Trial reminder emails do not attach the PDF
**Context:** The original trial-story-complete email already attached the
PDF. Reminders go to users who haven't claimed yet, days later.
**Decision:** `server/lib/trialReminders.js` deliberately skips
`pdfBuffer` when calling `sendTrialReminderEmail`.
**Rationale:** The user already has the PDF from the first email — sending
it again wastes bandwidth and storage on their end, and re-triggers Gmail
attachment scanning that occasionally bumps deliverability scores.
**Touched:**
- `server/lib/trialReminders.js:14, 65` — explicit no-PDF comments
**Status:** ✅ active.

### Reply address is `info@magicalstory.ch`, not `support@`
**Context:** Older email copy used `support@magicalstory.ch`. The actual
Resend `replyTo` configuration in `email.js` is `info@magicalstory.ch`.
**Decision:** Every user-facing email surface uses `info@magicalstory.ch`.
`support@` was retired.
**Rationale:** Only one mailbox is actually monitored. Surfacing an
unmonitored alias as the contact point burns user trust on the rare reply.
**Touched:**
- `email.js` line 14 — `EMAIL_REPLY_TO`
- `emails-src/components/Footer.tsx` — `SUPPORT_EMAIL` constant
- `emails-src/i18n.ts` — `orderFailed.questions` copy in all 4 languages
**Status:** ✅ active.

---

## Image generation

### Text-overlay font size never shrinks
**Context:** Page text gets overlaid on the rendered illustration. Longer
paragraphs are tempting to shrink so they always fit a fixed box.
**Decision:** `server/lib/textOverlayRenderer.js:116` — the renderer never
auto-shrinks the font. If the text doesn't fit, the calmness-detection
pass either expands the safe area or the upstream scene-expansion is asked
to keep the chosen corner calmer.
**Rationale:** Visual consistency across the printed book matters more
than fitting any one paragraph. A book where every page has the same text
size feels typeset; a book where page 7 has tiny text feels like a
glitch.
**Touched:**
- `server/lib/textOverlayRenderer.js:116`
- `server/lib/textRegion.js` — calmness map + safe-area expansion
- `server/lib/storyHelpers.js` `buildImagePrompt()` — COPY SPACE
  instruction the model uses to keep the chosen corner light
**Status:** ✅ active.

---

## Cross-cuts already documented elsewhere

These are referenced from `CLAUDE.md` and aren't duplicated here, but
listed for discoverability:

- **Unified mode is primary** — all new features target unified, not legacy
  `pictureBook` / `outlineAndText`. See CLAUDE.md → "Important Rules".
- **Action button styling identical across rows** — copy sibling
  className verbatim. See CLAUDE.md → "Important Rules".
- **Repair workflow scoring formula** — `qualityScore − semanticPenalties
  − entityPenalties`, threshold 60, max 3 passes. See CLAUDE.md → "Repair
  Workflow".
- **Centralized aspect ratios** — `MODEL_DEFAULTS` in
  `server/config/models.js`. See CLAUDE.md → "Centralized Aspect Ratio".
- **Prompts must stay generic** — no story-specific names/plotlines in
  `prompts/*.txt`. See CLAUDE.md → "Important Rules".
- **Memory check before recommending vendors** — see CLAUDE.md and the
  `memory/project_image_model_tests.md` log.

---

## Backlog (decisions noticed but not yet expanded)

These deserve an entry once someone has bandwidth — they're real design
choices buried in code or settings, not yet written up here:

- Trial cover generation moved from streaming `onTitle` to `onCoverScene`
  (richer structured data — see `server.js:3843`).
- `unified.js` `extractTitle` falls back to "legacy single-line" parsing
  when the structured `---TITLE---` block is absent — under what
  conditions does Sonnet emit the legacy form?
- Cascade face detection (Python anime detector + Haar) merge order and
  precedence rules in `server/lib/entityConsistency.js`.
- Why Grok is the avatar-face provider (switched from Gemini after
  `IMAGE_OTHER` refusals on adult-face photos — already noted in
  CLAUDE.md, expand here with the model-comparison data).
