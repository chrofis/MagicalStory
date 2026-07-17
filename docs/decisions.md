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

### Scene-plate slot 0 is magenta-extended, never gray-pillarboxed (2026-06-16)
**Context:** A portrait landmark photo (e.g. Baden Altstadt 533×800) used as
the slot-0 scene anchor for a square (1:1) story got pillarboxed to square by
`packReferences` using SAMPLED edge colours — grey on a stone-lane photo. Those
flat-grey bars baked into the empty-scene plate and survived the Grok edit into
the final page (showcase `job_1781557946649` p8+p9, ~17% bars each side). The
earlier magenta-extension fix (`02abce7d`) lived inside `editWithGrok`, but the
page/empty-scene path runs `packReferences` FIRST, which pre-squares slot 0
before `editWithGrok` sees it — so the magenta step was a no-op there. It only
ever worked for covers (which call `editWithGrok` directly).
**Decision:** `padInputWithExtension` is threaded through `packReferences`. When
slot 0 is a scene plate whose aspect differs from target, `packReferences`
leaves it at native aspect and `editWithGrok` magenta-pads + extends it (paints
real scene continuation into the gap). Later slots keep their pad/letterbox
behaviour. Both `generateImageOnly` Grok branches (imageBackend-routed AND
modelConfig-routed) pass the flag to `packReferences` as well as `editWithGrok`.
**Rationale:** Extension preserves the full landmark (no crop, no loss of
the tower/sky) AND produces full-bleed output. Cropping was rejected because it
loses landmark detail; gray pillarbox is the bug itself. Verified end-to-end on
the p8 landmark: before = 17%/17% bars, after = 1%/1% full-bleed.
**Touched:**
- `server/lib/grok.js` — `packReferences` accepts `padInputWithExtension`, skips
  slot-0 pad when set; `editWithGrok` magenta logic unchanged
- `server/lib/images.js` — both Grok branches in `generateImageOnly` pass the flag
**Status:** ✅ active.

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

### Scene composite pipeline killed — every page goes direct
**Context:** Two scene-composite variants were built between 2026-05-08
and 2026-05-16: (1) the **uniform composite** (populated plate with ALL
cast as colored silhouettes → bbox detect → depopulate → paste 2×4 cell
cutouts → blend; ~3 Grok calls flat, +N per phantom-pose render), and
(2) the **stratified composite** (cast depth-split: back stratum rendered
natively in the anchor plate, front stratum as silhouettes → front-figure
plate → diff-crop → composite onto depopulated back plate → blend; flat 4
Grok calls; N=1 short-circuits to anchor plate only). Initial stratified
commit `23fcf070` 2026-05-16 16:04; killed `8557b0ac` 2026-05-16 23:28
(~7.5 hours and ~28 fix-commits later). Same-day saga.
**Decision:** Hard-disable the composite branch at `server.js:5668` —
`const compositeEnabled = false;` regardless of what `decidePageRoute()`
returns. `routeDecision` metadata still populates so the dev panel reports
which method WOULD have been picked; only the gate flips. Every page
takes the direct Grok-edit path (`generateImageWithQualityRetry`).
`server/lib/sceneComposite.js`, `server/lib/compositeCastBuilder.js`,
`server/lib/phantomPoseRender.js` remain in the tree but are unreachable.
**Rationale:** Composite pages produced score-0 outputs on staging
`job_1778925296736_c9ia8qrio` pages 3 + 4. The auto-repair iterate path
salvaged every failed composite by re-running it as direct, so every
composite call was pure cost. Failure modes that never stabilised:
- **Style drift across 3–4 sequential Grok edits.** Each edit shifted
  brushwork, palette, or detail level; the final blend pass couldn't
  reconcile back to the anchor's style.
- **Silhouette detection failures.** Desaturated reds drifted past the
  RGB-distance threshold (commits `d359fabe`, `1a66a0b6`); translucent
  silhouettes required tolerance tuning (`f3096b00`); label bars from
  identity packs leaked into the mask (`5061bdd3`); split silhouette
  fragments needed merge logic (`fb1e6ca8`).
- **Depopulate drift.** Grok edit on the populated plate to "remove the
  silhouettes" frequently moved a building, swapped a VB prop, or
  repainted the floor (`ead1ed8b` ended up dropping the step entirely
  in favor of a direct RGB mask, defeating the architectural purpose).
- **Identity pack leakage.** Grok kept copying labels and reference cells
  from the identity packs into the output (`6f84dbca`, `a08aff78`,
  `11094490`) — same VB-grid-label problem we hit again on covers in
  2026-06-04 (commit `27e375ba`).
- **Aspect / cropping bugs.** Grok edit's input-aspect coercion clipped
  silhouettes off the edges (`3f38b295`, `144041df`, `9e9ce7bc`) — same
  root cause as the cover blur problem solved in 2026-06-04 with
  magenta-pad-extend.
The cover variant (`server/lib/coverComposite.js`) is unaffected and is
still on by default (`MODEL_DEFAULTS.compositeCovers: true`) — covers
have a different shape (3–5 figures in a single group portrait, landmark
backdrop, pre-styled costumed avatars), and 2026-06-04's single-pass
single-edit refactor (commit `b8e72eb9`) stabilised it.
**Before re-enabling scene composite, fix:**
1. Style-drift across sequential edits (probably means collapsing to a
   single edit, like the cover did in `b8e72eb9`).
2. Identity-pack label leakage (apply the `composeCharWithVbRow` no-label
   fix from `27e375ba` to whatever reference packing the composite path
   uses).
3. Grok input-aspect coercion (apply the magenta-pad-extend trick from
   the cover work).
4. End-to-end validation: pick 3 staging stories with cast ≥ 4 and prove
   the composite pages score ≥ direct on quality eval (semantic + visual).
   Without that gate, re-enabling is the same trap.
**Touched:**
- `server.js:5658-5668` — the kill-switch + the comment block explaining
  why it's hardcoded
- `server/lib/sceneComposite.js` — uniform composite (still in tree,
  unreachable)
- `server/lib/compositeCastBuilder.js` — cast builder (still in tree,
  unreachable)
- `server/lib/phantomPoseRender.js` — per-figure pose render (still in
  tree, unreachable)
- `server/config/models.js:enableSceneComposite` /
  `compositeStrategy` / `phantomPoseRender` — flags still defined but
  the kill-switch bypasses them
- `docs/image-generation-methods.html` — Why-not table entry; the
  scene-composite row in the methods table marked killed
- `memory/project_scene_composite_killed.md` — short verdict + don't
  re-suggest without addressing the 4 fixes above
**Status:** 🗄 superseded by direct path. Re-enable only after the four
fixes above land + the validation gate passes.

### Cover & scene composite unified at the test-models dispatcher
**Context:** Two parallel composite pipelines exist — `coverComposite.js`
for covers (sharp-composite figures + 1–2 Grok edits) and `sceneComposite.js`
for scene pages (uniform: populated plate → depopulate → cutout → blend;
stratified: back native + front silhouettes → depopulate front →
front-figure plate → composite → blend). The dev-panel TestModelsPanel
showed Method 1/2/3 toggles for both surfaces but for cover pages
(`pageNumber < 0`) the backend at `regeneration.js:1249` silently ignored
the strategy and ran cover composite regardless. The UI lied to the user.
The split was historical (different code authors, different times), not
principled — covers ARE just scenes with a fixed group-portrait layout and
title/dedication/branding text.
**Decision:** Make `generateSceneComposite` cover-capable by adding
`scene.textOverlay = { type, text, artStyle }` plumbing through
`buildBlendEditPrompt`. Add `buildCoverCompositeCast()` adapter in
`compositeCastBuilder.js` — synthesises a scene-shaped pageData from
`coverHint.characterDetails` + `coverHint.characters`, then delegates to
the existing `buildCompositeCast` for avatar resolution and lazy 2×4 sheet
generation (no duplication). Test-models cover branch dispatches by
`compositeStrategy`: when `'uniform'` or `'stratified'`, route through
the new path; anything else preserves the legacy `iterateCover` call.
**Rationale:** Truthful UI > parallel parallel pipelines. The user picked
Method 2/3 — they should get scene composite for covers, not be silently
re-routed to the legacy cover path. Auto-pipeline routing is unchanged
(covers still default to `generateCoverViaComposite` single-pass);
Method 2/3 for covers is manual-only via test-models, same gate scene
pages already use. Scene composite's documented failure modes (style
drift, label leakage, depopulate drift) will likely show up on covers
via Method 2/3 — that's a known limitation, not a blocker, since manual
testing is exactly where you want to discover that.
**Touched:**
- `server/lib/compositeCastBuilder.js` — new `buildCoverCompositeCast`
  adapter (~120 lines, delegates to existing `buildCompositeCast`)
- `server/lib/sceneComposite.js` — `scene.textOverlay` plumbing through
  `buildBlendEditPrompt`; new `buildTextOverlayDirective` helper
- `server/routes/regeneration.js:1249` — dispatcher branch on
  `compositeStrategy` for `pageNumber < 0`
- `docs/image-generation-methods.html` — methods table updated to note
  the new cover-via-scene-composite path
- `memory/project_scene_composite_killed.md` — note that covers can
  reach scene composite via test-models
**Production-path behaviour after this change:**
- V1 covers (streaming initial gen): unchanged — direct path
- V2+ covers (auto-repair iterate): unchanged — cover composite
  single-pass
- Manual cover regen via repair-panel "Iterate Cover": unchanged
- Test-models on covers with NO composite toggle: unchanged
- Test-models on covers with Method 2 / Method 3 toggle: NEW — runs
  scene composite adapted for the cover, with text rendered in the
  blend step
**Status:** ✅ active.

### Evaluators never judge direction of travel from a mid-motion pose
**Context:** A page whose beat was "character leaps from a vehicle onto
a surface" rendered correctly (push-off foot still touching the
vehicle), but the blind vision inventory *guessed* the leap direction
from the frozen pose ("jumping from the ledge toward the boat") and the
text-only compliance scorer treated that guess as fact → `wrong_action`
CRITICAL on a correct image → unnecessary repair. The repair came back
genuinely inverted, and the scorer then stretched the left/right-mirror
leniency to a *surface swap* (foot on vehicle vs foot on rock),
downgrading it to MAJOR → the wrong image passed and won pick-best over
the correct original (job_1781289599516 p7).
**Decision:** Two rules added to all three eval prompts
(`image-vision-inventory.txt`, `image-prompt-compliance.txt`,
`image-evaluation.txt`): (1) a still frame cannot show direction of
travel — describers report only which surfaces/objects each limb
touches, scorers never flag `wrong_action` from inferred motion
direction; (2) mirror equivalence covers body sides and frame halves
only — a limb contacting a *different object* than declared is a real
contradiction, not a mirror.
**Rationale:** Direction-of-motion in a static image is a guess stacked
on a guess (vision infers, compliance scores the inference). The same
ambiguous pose got CRITICAL when correct and MAJOR when wrong — the
asymmetry, not the ambiguity, is what broke the page. Judging only
visible contacts makes both versions score consistently.
**Touched:** `prompts/image-vision-inventory.txt`,
`prompts/image-prompt-compliance.txt`, `prompts/image-evaluation.txt`.
**Status:** ✅ active.

### Scene-hint `background` is forwarded verbatim into the image prompt
**Context:** The unified outline correctly placed story-essential
antagonists in the scene hint's `background` field ("faint soldier
faces inside the retreating boat" — per the ANTAGONISTS rule in
`story-unified.txt`), but the field never reached the image generator:
`extractSceneMetadata()` dropped it, and the prose — the only channel
into `buildImagePrompt` — omitted the soldiers. The evaluator, which
scores against the hint, flagged the empty boat but only as MODERATE,
so nothing forced a fix. Result: an escape scene with no one to escape
from (job_1781289599516 p7).
**Decision:** (1) `extractSceneMetadata()` exposes `background`
(top-level + `fullData`); (2) `buildImagePrompt()` appends a
`**BACKGROUND:**` line with the hint's background text to the scene
description — even when the prose already covers it (short, harmless
redundancy beats a silent drop); (3) both evaluators score
prompt-placed supporting figures (role + location given) as MAJOR
`missing_element` when entirely absent — ambient decoration ("a few
passersby") stays no-deduction.
**Rationale:** Generator and evaluator must see the same contract. The
prose weaving background in is the happy path, not a guarantee — a
deterministic append closes the gap for every story instead of relying
on the prose writer never dropping a clause.
**Touched:** `server/lib/storyHelpers.js` (`extractSceneMetadata`,
`buildImagePrompt`); `prompts/image-evaluation.txt`;
`prompts/image-prompt-compliance.txt`.
**Status:** ✅ active.

### Antagonists: outline declares them in prose + objects[]; builder keeps the CHR filter
**Context:** Follow-up to the background-forwarding fix. The Visual
Bible had a secondary-character entry for the antagonists (CHR002,
`pages` including the failing page), but the scene hint never
referenced it — soldiers lived only in background prose, and the
2026-06-09 builder change silently skips CHR ids in `objects[]` on the
assumption the prose always carries secondaries.
**Decision (user-chosen scope: outline rule only, no builder safety
net):** `story-unified.txt` now requires story-present antagonists to
be (1) named in the SCENE prose with count + placement + VB signature
look, (2) listed by CHR id in `objects[]` (presence metadata — the
builder still filters CHR ids out of REQUIRED OBJECTS to avoid
duplicating the prose), (3) summarised in `background`. A builder-side
re-inject fallback (when prose drops a declared CHR) was offered and
declined — revisit if antagonist drops recur despite the new rules.
**Touched:** `prompts/story-unified.txt` (SCENE prose rules +
ANTAGONISTS + OBJECTS); `server/lib/storyHelpers.js` (comment on the
CHR filter).
**Status:** ✅ active.

### Scale-repair is verified before promotion; unscored originals get a rescue eval
**Context:** Page 9 of job_1781289599516: the unconditional scale-repair
("shrink the background character") edit DELETED Gessler instead of
shrinking him; the edit was promoted blindly; the pre-repair original is
stored with score:null (eval only runs on the promoted image) and
selectBestVersion skips null scores — so the original (the best image of
the run) was mathematically locked out and the Gessler-less version
shipped at score 30 after three repair rounds made everything worse.
Compounding factor: Gessler is a VB secondary (CHR001), not a user
character, so bgDescriptions came up empty — the repair prompt said
"move Gessler" to a model that has no idea who Gessler is.
**Decision:**
1. `verifyScaleRepair()` (scaleRepair.js) — one gemini-2.5-flash call on
   the edited image checks each background character by VISUAL SIGNATURE
   (clothing/colours/mount, never by name — a silhouette passes for a
   name, not for "crimson cloak + white-feathered hat"). Any "not
   present" → repair discarded, original stays active. Fails OPEN on API
   errors (a verification hiccup must not discard a probably-fine edit).
2. Step 3b rescue eval (images.js) — when a page's best version scores
   < 60 and an unscored original exists, evaluate it with the standard
   eval and re-pick. Healthy pages never pay the extra eval.
3. bgDescriptions in server.js fall back to Visual Bible
   secondaryCharacters for background characters that aren't user
   characters — both the repair prompt and the verification gate need
   the signature description.
4. `sanitizeIssueForInpaint()` (images.js) — entity-consistency grid
   vocabulary ("cells A, D, E, F", "reference (R)", "costume costume")
   is stripped from issue text before it lands in inpaint prompts; the
   inpaint model never sees the comparison grid.
**Verified:** gate replayed on the stored p9 images (flags v1 missing
Gessler, passes v0); rescue re-pick flips best from scale-repair(30) to
original; sanitizer tested on the exact leaked strings.
**Touched:** `server/lib/scaleRepair.js`, `server/lib/images.js`,
`server.js`.
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

## Marketing & Google Ads

### Conversion goal: demote PAGE_VIEW, add "Trial story completed", uncap PMax
**Context:** PMax campaigns were optimizing toward whatever fired most — and
that turned out to be the "Page view" conversion (counting_type MANY,
value CHF 1, primary). Conversion count ≈ click count → algorithm chased
clicks, not value. CHF 0.50 Target CPA on top of that throttled
campaigns toward zero because real conversions cost ~CHF 1.38–2.58.
**Decision:**
1. **Demote PAGE_VIEW** at the customer_conversion_goal level
   (`biddable: false`). It still counts for analytics; just no longer
   feeds the bidder. Done via `customerConversionGoals.update()` —
   the per-conversion-action `primary_for_goal` field is read-only for
   GA4-sourced conversions (origin=2).
2. **Create "Trial story completed"** — a real high-value signal.
   Category SIGNUP, value CHF 10, counting ONE_PER_CLICK, type WEBPAGE.
   Conversion action id 7629103661. Fire is **not yet wired** —
   needs gtag event from the trial-completion screen in the React app.
3. **Remove CHF 0.50 Target CPA** from PMax-Baden/Winterthur/Aarau.
   Daily budget cap (CHF 3/day) is the real spending control at this
   volume. Target CPA needs ~30+ conversions/campaign/month to be
   useful; we have 7/3/2.
**Rationale:** At ~12 conversions/month total, Google's ML bidding
flies blind. Better to keep the algorithm unconstrained but optimizing
for a higher-quality signal (real story completion, not landing page
view).
**Re-evaluate trigger:** once we hit 30+ "Trial story completed"
conversions/campaign/month, switch to Maximize Conversion Value with
per-action values: Trial=CHF 10, Account claim=CHF 30, Book purchase
=CHF 60. Until then, no Target CPA.
**Touched:**
- Google Ads conversions + bidding (no code changes for the Ads side)
- ⚠️ Still TODO in code: fire `gtag('event', 'conversion', {send_to: 'AW-17995593741/<LABEL>'})`
  from the trial-completion screen (TrialGenerationPage / story-ready
  state). LABEL is visible in the Ads UI under Tools → Conversions →
  Trial story completed → Tag setup. Without this the conversion
  action exists but never fires.
**Supersedes:** the earlier "PMax campaigns capped at CHF 0.50 Target CPA"
entry below — that cap is now removed.
**Status:** ✅ active (set 2026-05-30).

### landmark_index broad coverage: all 1,439 Swiss cities (2026-06-01)
**Context:** The Wikipedia-geosearch indexer covered ~22 Swiss cities;
swiss-cities.json catalogues 100; Google Ads' geo-target catalog has
**1,439** Swiss CITY + MUNICIPALITY entries. Goal: every Swiss city
that exists in any of these catalogs should have at least one usable
overview photo in `landmark_index`, so future creative-gen and city-
landing-page features can refer to any city without "no photo
available" gaps.
**Decision:** Built `scripts/admin/broad-city-overviews.js`:
1. Pulls all CH-CITY + CH-MUNICIPALITY entries from Google Ads
   `geo_target_constant`.
2. For each, looks up the city's own Wikipedia page in its primary
   language (DE / FR / IT by canton).
3. Saves the lead `pageimages.original` photo as an entry named
   `<City> (Stadt|ville|città)` with `photo_type='distant'`, country
   = 'Switzerland'.
4. Zero Gemini Vision calls — overviews are definitionally `distant`,
   so the classification is hardcoded. **$0 cost.**
**Result:** Every Swiss city has a baseline aerial/overview photo
useable as a reference image for ad creative generation, city landing
pages, and story prompts.
**Trade-off:** Quality varies — some lead images are coats of arms or
maps rather than aerial shots (limitation of Wikipedia's pageimages).
Acceptable as a baseline; can be improved per-city later.
**Touched:**
- `scripts/admin/broad-city-overviews.js` — idempotent re-runnable
**Status:** ✅ active (run 2026-06-01).

### Photo-type classification: metadata-first, Read-tool second (2026-06-01)
**Context:** `photo_type` (distant/close/interior/view_from/bad) was
unset on 93% of landmark rows. The existing `classify-landmark-photos.js`
uses Gemini Vision (~$0.001/photo × 1,700 photos = ~$1.70). User
preference: avoid the dollar cost; use Claude's Read tool tokens
instead (which are budgeted differently).
**Decision:** Two-tier classifier `scripts/admin/classify-via-read.js`:
1. **Tier 1 — metadata heuristic (free, instant).** For each photo
   slot, fetch Wikimedia Commons extmetadata (ImageDescription,
   DateTimeOriginal, Categories). Regex-match against multi-language
   keyword sets:
     - `bad` (engraving, lithograph, painting, map, coat-of-arms,
       portrait, statue-detail) — auto-discarded
     - `distant` (aerial, panorama, Schrägluftbild, drone, skyline)
     - `interior` (Innenraum, Nave, Chor, Kreuzgang, crypt, altar)
     - `view_from` (Blick von, Aussicht von, vue depuis)
   Confidently classified rows are written immediately. Empirical
   filter rate: ~70-80% per sample.
2. **Tier 2 — Read tool for survivors.** Photos that don't match any
   pattern emit to `ambiguous-photos.json`. A separate pass downloads
   each image, opens it via Read, and writes a decision back to the
   JSON. `--tier2-apply` then writes decisions to DB.
**Result:** ~70-80% of photo_type classifications free at Tier 1; only
~150-300 photos (estimate) need eyes via Read at Tier 2. Zero Gemini
Vision spend.
**Touched:**
- `scripts/admin/classify-via-read.js` — both tiers in one file
**Status:** 🟡 in-progress (tier-1 tested on Baden, full run pending
broad-coverage completion).

### landmark_index iconic-fill + canonical-name rename (2026-06-01)
**Context:** The existing Wikipedia-geosearch indexer
(`server/lib/landmarkPhotos.js` → `indexLandmarksForCities`) systematically
missed or mis-named famous Swiss landmarks. Concretely:
- **Geosearch radius + score filters** dropped some icons that should
  have been the first hit (Grossmünster, Zytglogge, Spalentor, Jet d'eau,
  Käfigturm — none were in the index at all).
- **Cross-language storage** stored iconic landmarks under their non-local
  Wikipedia title (e.g. Berner Münster as "Collégiale Saint-Vincent de
  Berne", Bundeshaus as "Palais fédéral", Cathédrale de Lausanne as
  "Kathedrale Notre-Dame (Lausanne)"). The creative-generation script
  does ILIKE '%<name>%' lookups, so the canonical local name failed to
  match.
**Decision:** Built `scripts/admin/add-iconic-landmarks.js` — a targeted
fetcher that:
1. Looks up each iconic landmark by exact Wikipedia title in the
   appropriate language (DE for Zürich/Bern/Basel, FR for Genève/
   Lausanne) — bypasses geosearch entirely.
2. UPSERTs by either name OR wikidata_qid — catches existing rows under
   different local names.
3. **Renames non-canonical existing rows to the local-language form**
   (e.g. "Palais fédéral" → "Bundeshaus (Bern)"). Keeps the photo and
   wikidata_qid intact.
4. Patches missing nearest_city values.
**Result:** 6 new landmarks inserted, 11 renamed, 13 already-canonical
left alone. Every iconic landmark now findable by its canonical local
name across Zürich, Bern, Basel, Genève, Lausanne. Total Swiss landmark
coverage above tier-1 iconic threshold for these 5 cities.
**Touched:**
- `scripts/admin/add-iconic-landmarks.js` — re-runnable fetcher/renamer
- `landmark_index` table (production DB) — direct writes
**Re-evaluate trigger:** If we extend to more cities (Luzern, Lugano,
St. Gallen, Biel, etc.), add their iconic-list to the same script and
re-push. The script is idempotent.
**Status:** ✅ active.

### PMax tight cost control: Target CPA CHF 0.50 + budget CHF 1.50/day
**Context:** After uncapping PMax earlier today (removed Target CPA),
Baden paid CHF 4.09 for a single click. User confirmed they want
predictable low spend over volume — willing to accept near-zero
serving in exchange for a hard cost ceiling.
**Decision:** Apply both constraints to PMax-Baden/Winterthur/Aarau:
  - `target_cpa_micros = 500000` (CHF 0.50)
  - `budget.amount_micros = 1500000` (CHF 1.50/day)
**Expected outcome:** Campaigns serve very little or not at all
(current actual CPA is CHF 1.38–2.58, so asking for 0.50 means most
auctions won't be entered). Total daily spend ceiling ≈ CHF 4.50/day
across the three; actual likely far lower. Essentially 'paused with
optionality' — keeps the campaigns alive for when we relax constraints
again.
**Re-evaluate trigger:** If we want any volume, either raise target_cpa
(e.g. CHF 1.50–2.00) or remove it. User accepts the trade-off; in-house
priority is the trial-funnel landing pages, not paid acquisition volume.
**Supersedes:** today's earlier 'uncap PMax' decision (the conversion-
goal restructuring from that entry — PAGE_VIEW demoted, 'Trial story
completed' created — stays active).
**Status:** ✅ active (set 2026-05-31).

### 🗄 PMax campaigns capped at CHF 0.50 Target CPA (SUPERSEDED 2026-05-30)
> Superseded by "Conversion goal: demote PAGE_VIEW, add Trial story completed, uncap PMax" above. The CHF 0.50 Target CPA was throttling campaigns to near-zero impressions because actual CPA on real conversions was 2.8–5× higher. Kept here for history. (Note: re-applied 2026-05-31 with a tightened budget — see top of section.)
>
**Context:** Three PMax campaigns (Baden, Winterthur, Aarau) were running
on `MAXIMIZE_CONVERSIONS` with no per-conversion ceiling, paying actual
costs of CHF 1.38 / 2.00 / 2.58 per conversion. Roger wanted a hard cost
ceiling. PMax doesn't support per-click bid caps (Google product
limitation — only Search supports `cpc_bid_ceiling`).
**Decision:** Set `maximize_conversions.target_cpa_micros = 500000` on
all three PMax campaigns (= CHF 0.50 max per conversion). Search-Zurich
keeps its per-click cap of CHF 0.50.
**Rationale:** Explicit budget discipline matters more than maximum
volume at the current spend level (~CHF 12/day total). User accepts
that the algorithm will throttle clicks/impressions sharply to hit the
target — current CPA is 2.8–5× higher than the new target, so volume
will drop.
**Re-evaluate trigger:** if total conversions drop more than ~70%
after 2 weeks with no recovery, either raise the target (e.g. CHF 1.00)
or revert to uncapped MaxConversions.
**Touched:**
- Google Ads campaigns (no code changes) — set via inline node script
  using the google-ads-api SDK. Same script form could become
  `scripts/ads/set-target-cpa.js` if we change it again.
**Status:** ✅ active (set 2026-05-29).

### Sitelinks: 5 account-level + 1 per-city = 6 per campaign
**Context:** Google Ads recommends ≥6 sitelinks per campaign so ads can
serve in the top-of-page formats (higher CTR). MagicalStory had zero
sitelinks attached before 2026-05-29.
**Decision:** 5 generic sitelinks attached at the **customer (account)**
level via `CustomerAsset` → apply to every campaign. One additional
per-city sitelink attached at the **campaign** level via `CampaignAsset`
→ "Geschichten in {City}" pointing at `/stadt/{cityId}`.
**Rationale:** Account-level handles the bulk efficiently (5× CustomerAsset
records vs N campaigns × 5 = duplicated work). The per-city addition
delivers one locally-relevant link on each city campaign — better local
relevance than purely generic copy.
**The 5 account-level sitelinks** (all DE):
- "Zur Startseite" → `/`
- "Gratis testen" → `/try`
- "Geschenkideen" → `/geschenk`
- "Über 44 Themen entdecken" → `/themes`
- "Preise & Pakete" → `/pricing`
**Per-city:** "Geschichten in {City}" → `/stadt/{cityId}` for Aarau, Baden,
Winterthur, Zürich (matched to PMax-{City}-v1 / Search-Zurich-v1
campaigns; Zürich uses both 'Zurich' and 'Zürich' name patterns since
the campaign label is ASCII while the display label keeps the umlaut).
**Idempotency caveat:** Re-running `--push` creates new Asset records
each time. Run once. Future iterations on copy need a dedup pass that
lists existing `CustomerAsset` SITELINK rows and skips matching names.
**Touched:**
- `scripts/ads/create-sitelinks.js` — creates the assets + attaches them
**Status:** ✅ active (pushed 2026-05-29).

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

---

## Trial flow

### Trial skips the 2×4 standard sheet — uses preview avatar as standard
**Context:** Generating both standard and costumed 2×4 sheets adds ~30-40s
to the trial wait. The trial character is in `costumed` for nearly every
page of a 5-page story; the standard look only matters for the rare
non-costumed scene. The preview avatar (9:16 full-body watercolor portrait,
generated cheaply during the wizard) is good enough for that.
**Decision:** Trial `prepare-title` only adds the costumed entry to
`avatarRequirements`. Before calling `prepareStyledAvatars`, the standard
cache key is seeded with the preview avatar via `_seedStandardFromPreview()`.
Page rendering's `applyStyledAvatars` finds it there for standard-clothing
pages and never triggers a separate 2×4 standard generation. If no costume
is configured (unusual), we still fall back to generating the standard sheet.
**Rationale:** ~30-40s saved per trial — major UX win on a flow already
too slow. Quality loss is bounded: standard scenes are rare in trial, and
the preview avatar shows the same character in the same watercolor style.
**Touched:** `server/routes/trial.js` (`prepare-title` handler — `avatarRequirements`
and `_seedStandardFromPreview` call); `server/lib/styledAvatars.js`
(`_seedStandardFromPreview` helper, exported).
**Status:** ✅ active

### Trial DOES generate empty scenes (re-enabled after brief disable)
**Context:** Empty-scene generation for trial was disabled in commit
`05d4c221` to save ~25s on the 5-page wait. User feedback: the scene
quality wins outweigh the latency — page renders look noticeably better
when each one inherits a pre-rendered scene plate as background slot.
**Decision:** Trial re-enables empty-scene generation for all 5 pages
(server.js trial-mode `onVisualBible` block). Each empty scene is a ~5s
Grok call; total ~25s extra in the wait — accepted.
**Rationale:** Scene-anchored renders (`packReferences` uses the empty
scene as Slot 1) are visibly more consistent across pages than text-only
renders. The latency cost is recoverable elsewhere (skipping the 2×4
standard sheet saves ~30s, net positive).
**Touched:** `server.js` trial-mode `onVisualBible` block (~3942).
**Status:** ✅ active. KNOWN ISSUE: empty-scene rendering deviates too
much from the passed landmark photo — needs prompt review (tracked as
task #34).

### Trial uses age-tier phantom (child as fallback for unknown age)
**Context:** Phantom silhouette controls head-to-body ratio of the
generated 2×4 character. A generic adult-proportioned phantom leaks adult
proportions into kid characters. Age tiers (toddler / child / teen / adult)
shipped earlier. The trial form does NOT require age — `canProceed` only
checks name + gender + photo. When users skipped age, the chain was
`age='' → tier null → loadPhantom() falls back to phantom-watercolor.png
(adult-ish)`. Result: kid renders looked adult-ish.
**Decision:** `phantomTierForAge('')` returns `'child'` (not `null`). Any
unknown / unparseable age renders against `phantom-watercolor-child.png`.
**Rationale:** Product is overwhelmingly for kids. Adult-proportioned
default phantom is the wrong fallback; child is the right one. Users who
make an adult character must explicitly enter age 18+ to get the adult
phantom (acceptable friction for the rare case).
**Touched:** `server/lib/character2x4Sheet.js` (`phantomTierForAge`).
**Status:** ✅ active.

### Phantom face replaced with RGB axis-gizmo overlay
**Context:** The 2×4 character sheet generation uses a phantom (mannequin
in 4 angles × 2 rows of head/body) as a pose template. The phantom is
generated with "two small dots for eyes, a small line for a mouth"
(see `scripts/generate-phantom-age-tiers.js:89`) so Grok knows where the
face goes per cell. Problem: Grok **copies whatever it sees** on the
phantom's head into the rendered character. The eye-dots and
mouth-line leak into every render — the character's face structure ends
up reading as "phantom-face-with-skin-tone" instead of "the kid in the
source photo". Tried smooth/featureless heads, but Grok then renders
smooth/featureless faces ("the avatar gets a smooth oval face"). Tried
composite-source-face onto phantom, but that defeats the purpose since
the 2×4 IS the source for downstream composites. Tension: phantom MUST
have a face for orientation cue, but ANY face leaks.

**Decision:** Overlay a 3-axis RGB gizmo (red X, green Y, blue Z) on the
face region of each cell. The gizmo communicates orientation through
its OWN rotation per cell (front=0°, quarter=45°, profile=90°,
back-3/4=135°) but is unmistakably non-anatomical — Grok reads it as
"directional marker, not a face" so no face features leak into the
render. The phantom body (proportions, pose) is preserved untouched.

  Cell layout per angle:
  | Angle | Red (X) | Green (Y) | Blue (Z) |
  |---|---|---|---|
  | 0° front | → right | ↑ up | • dot (toward viewer) |
  | 45° quarter | ↗ up-right | ↑ up | ↘ down-right |
  | 90° profile | • faded dot (perpendicular) | ↑ up | → right |
  | 135° back-3/4 | ↖ up-left | ↑ up | ↗ up-right |

**Rationale:** Keeps the body+pose value the phantom provides without
the feature-leak cost. The gizmo "leak" is benign because the gizmo
doesn't resemble human anatomy — Grok renders the character from the
source face photo, gives the head the orientation indicated by the
gizmo, and discards the gizmo geometry. Build-time transformation
(scripts/generate-phantom-axes.js) keeps the original assets untouched
on disk for easy rollback.

**Touched:**
- `scripts/generate-phantom-axes.js` — generator that overlays gizmos
  onto each existing phantom PNG, outputs `*-axes.png` variants
- `server/assets/phantom-watercolor-{toddler,child,teen,adult,*}-axes.png`
- `server/lib/character2x4Sheet.js` — `loadPhantom()` reads the
  `-axes` variants

**Status:** ✅ active. Cross-character validation (Noah + Emma, all 4
  age tiers) showed clean faces with correct per-cell orientation and
  no gizmo geometry leaking into the renders.

### One trial story per user — no environment exceptions, no merges, no email reclaim
**Context:** During testing, multiple convenience features were added on
staging: cap bypass (let same trial user generate multiple stories),
email reclaim (free up the same email between trial runs), and merge into
existing real account (let an admin claim multiple trial runs into their
own account). The user rejected all of these.
**Decision:** Hard rule across all environments: `stories_generated < 1`
in `/api/trial/create-job`; no staging email reclaim in `/link-email` or
`/link-google`; no merge-into-existing-account path; no `_merge*` helper.
To re-test the trial flow, create a fresh trial account with a fresh
email each time.
**Rationale:** Product policy: trial is the user's one free shot at the
experience and the entire claim/conversion funnel is calibrated around
scarcity. Any "convenience" workaround distorts conversion numbers,
abuse-resistance tests, and the deferred-email helper's idempotency
guard — all assume one trial = one user.
**Touched:** `server/routes/trial.js` (`/create-job`, `/check-status`,
`/link-email`, `/link-google`); CLAUDE.md (rule).
**Status:** ✅ active.

### JSONB R2 sweep — every inline base64 leaves stories.data
**Context:** A 14-page repair-heavy Berger smoke (`job_1780141948847_xzk2o00ua`)
hit Postgres' 256 MB JSONB cap (`total size of jsonb object elements exceeds
the maximum of 268435455 bytes`). `extractInlineImagesToR2` had explicit
walkers for known image-bearing fields, but every new field added to the
data model was one more chance for base64 to leak. Profiling a 5-page 1-char
trial showed 11 MB of leaks across 74 fields the explicit walkers missed
(notably `styledAvatarGeneration[*].passes.pass{1,2}.imageData`,
`sceneImages[*].sceneCharacters[*].bodyNoBgUrl`,
`visualBible.locations[*].photoVariants[*].cachedPhotoData`,
`...sentToGrok.referenceImages[*].dataUri`). Multiply by 14 pages × 5 chars
× 4 repair passes → past the 256 MB cap.
**Decision:** Add a Phase 1.5 generic recursive sweep to `extractInlineImagesToR2`
that walks the entire data tree and queues every remaining base64 / data:image
string for R2 upload, replacing each field in-place with the R2 URL under
`stories/{id}/aux/{path}.jpg`. Per-field walkers stay (semantic R2 keys
under `/stories/{id}/page-{N}/...` are nicer for browsing) and a `queuedInputs`
Set prevents the sweep from re-queueing strings already targeted by the
explicit walkers (would race two `apply()` callbacks on the same field).
**Rationale:** The original per-field strip philosophy required adding a
new walker for every new image field — an unmaintainable allowlist that
silently regressed every time anyone added an image-bearing key. A generic
sweep + a `queuedInputs` dedup gives us **deny-by-default** for inline
base64 in JSONB without breaking the semantic R2 keys we still want for
audited fields. Nothing destructive: failed R2 uploads leave bytes in
place for the existing strip to drop (same behaviour as before).
**Touched:** `server/services/database.js` (`extractInlineImagesToR2`).
**Status:** ✅ active.

### Trial landmark photo variants — surface per-angle descriptions to Claude
**Context:** Every Baden trial picked "Holzbrücke (Baden)" and the renderer
always used variant 1 (an exterior far-away river shot), even when scenes
took place inside or on the bridge — Holzbrücke has 5 indexed variants
including 2 interior shots (variants 4-5). Two compounding bugs: (1) the
trial landmarks instruction at `storyHelpers.js:5388` listed only landmark
names with no photo-angle descriptions, so Claude had no signal to pick a
variant; (2) the trial prompt's `landmarkQuery` example was literally
`"Holzbrücke Baden"`, biasing Claude to pick it over higher-scored
candidates (Sankt-Nikolaus-Kapelle 135, Stadtpfarrkirche 135 both beat
Holzbrücke 134). Few-shot examples in prompts are sticky.
**Decision:** Carry the full `photoVariants` array (with per-variant
descriptions) through `storyIdeas.js` → trial landmarks instruction.
Emit a `PHOTO ANGLES` block per landmark when ≥2 variants exist, plus a
variant-syntax instruction (`[LOC###.N]`) so Claude can pick interior
vs exterior per scene. Remove the Holzbrücke example from the trial
prompt and replace with a generic "copy verbatim" instruction.
**Rationale:** The variant indexing + `getLandmarkPhotosForScene`
`[LOC###.N]` parser were already in place; the planner just never knew
about them. Full mode uses a second scene-expansion pass that loads
variant descriptions, but trial has no second pass — variant info must
land in the unified prompt or it never lands.
**Touched:** `server/routes/storyIdeas.js` (variant carry-through);
`server/lib/storyHelpers.js` (`buildTrialStoryPrompt` landmark
instruction); `prompts/story-trial.txt` (drop bias example).
**Status:** ✅ active.

### Trial scenes: character physical traits + VB-secondary descriptors
**Context:** Trial scene prose came out as bare action ("Lukas stands at
the wooden garden gate") with zero visual descriptors — Grok had to rely
entirely on the styled-avatar reference image for the uploaded main
character, and **invented secondary characters** (Mia, Noah, shopkeepers)
landed in the prompt as just a name. Grok reinvented their appearance
every page, breaking cross-page consistency. Two distinct leaks: (1)
`buildTrialStoryPrompt` emitted `name/age/gender/traits` but not
`character.physical` even though `trial.js:737-745` stamps Gemini-
extracted `hairColor/eyeColor/skinTone/detailedHairAnalysis` onto the
character row; (2) `buildImagePrompt`'s storybook path strips the full
VB text when `skipVisualBible: true` (the default for Grok — 8000-char
limit, VB grid sent as image instead), so secondary-character VB entries
with hair/face/clothing fields never reach the prompt.
**Decision:** Surface `character.physical` to Claude via the trial
CHARACTERS section (`hair: brown; eyes: blue; skin: fair; hair detail:
...`) so prose can weave it in. Separately, in `buildImagePrompt`,
inject a compact `**SECONDARY CHARACTERS IN THIS SCENE:**` block built
from `visualBible.secondaryCharacters` filtered by `.pages[]` —
preserves the Grok-skips-VB optimization for the bulk text while keeping
the per-scene-relevant secondaries (typically 1-3 per page) so invented
characters render consistently.
**Rationale:** Photos work for uploaded characters; descriptors work
for invented ones. We need both. Filtering by `pages[]` means each page
only carries ~50 chars per relevant secondary instead of the full cast
(would blow Grok's 7500-char effective limit on busy stories).
**Touched:** `server/lib/storyHelpers.js` (`buildTrialStoryPrompt`,
`buildImagePrompt`).
**Status:** ✅ active.

### Avatar eval: normalize inputs + use face crop + tighten scoring (F1/F2/F3)
**Context:** User flagged avatar evaluation scores as suspiciously high.
Three issues compounded: (F1) `evaluateAvatarFaceMatch` used a string
`.replace(/^data:image\/\w+;base64,/, '')` to peel data-URI prefixes
before sending to Gemini — a no-op for HTTPS R2 URLs (the common case
post-R2 migration), causing the URL string to be sent as "base64 image
bytes", Gemini returning 400, and the function silently returning null
(stale score persists, no retry fires). (F2) All 4 callsites passed
`referencePhoto` (the bg-removed body with clothing — face is ~5% of
pixels) as the face-match anchor instead of the dedicated `facePhoto`
(zoomed face crop the Python service produces). Dilute signal. (F3) The
prompt was lenient — Gemini was told to score eyes/nose/mouth/overall
structure but not face geometry (forehead height, cheekbone prominence,
jawline shape), so avatars with visibly different geometry could pass
with 7-8 if individual features happened to look similar.
**Decision:**
- **F1:** Normalize both `evaluateAvatarFaceMatch` args via
  `r2.bytesFromAnyImage()` (handles URL / data URI / raw base64
  uniformly), fail loudly on decode failure.
- **F2:** Prefer `facePhoto` / `faceRefPhoto` over `referencePhoto` at
  all 4 callsites (job + sync, initial + retry). Falls back to
  `referencePhoto` only when no dedicated face crop was uploaded.
- **F3:** Add `foreheadCheekJawline` as an explicit scored feature in
  `avatar-evaluation.txt`. Cross-style cap explicit: 8-10 requires ALL
  of faceShape + foreheadCheekJawline + eyes + nose + mouth to agree;
  one off → cap at 6; two off → cap at 4. Raise `MIN_BASE_AVATAR_SCORE`
  5→7 so genuinely-different-geometry sheets actually retry.
**Rationale:** The face photo IS sent to the evaluator (rules out the
"no face photo" hypothesis), but the wrong-shape input (F1) silently
broke it for URL inputs, the wrong-photo input (F2) starved Gemini of
signal even when decoding worked, and the lenient prompt (F3) let
genuine identity drift slip past. All three are independent root
causes with independent fixes.
**Touched:** `server/routes/avatars.js` (`evaluateAvatarFaceMatch` +
4 callsites + `MIN_BASE_AVATAR_SCORE`); `prompts/avatar-evaluation.txt`
(scoring rules + JSON schema).
**Status:** ✅ active.

## Performance

### Landing+nav static images shipped as WebP at display-resolution
**Context:** PageSpeed Insights flagged 871 KiB of unnecessary bytes on
the landing page, dominated by `logo-book.png` (664 KiB, an 868×864 PNG
rendered at 40px) plus oversized JPGs for the section illustrations,
hero thumbs, and video poster. Also: a 512×512 arrow icon rendered at
42px (`arrow-icon-1162.png`, 12 KiB), and the landing-characters image
had no `width`/`height` causing a 0.121 layout shift.
**Decision:**
- One-shot resize + WebP encode via `scripts/optimize-landing-images.js`
  (sharp). Each entry has an explicit target width — roughly 2× the
  measured display dimension. Originals get a `-orig.<ext>` backup the
  first run, so the script is idempotent (always re-encodes from the
  backup). Backups are gitignored.
- Consumers switched to `.webp`. Arrow icon stays PNG but in-place
  shrunk to 128×128 (12 KiB → 2 KiB).
- Every `<img>` got explicit `width` + `height` (CLS fix) plus
  `loading="lazy" decoding="async"` for below-fold images and
  `fetchPriority="high"` on the logo + first hero thumbs.
**Rationale:** WebP is supported by 97 %+ of browsers — no `<picture>`
fallback needed for a public landing page. The originals stay on disk
under `images/*-orig.*` so a one-line `git checkout` can roll back if a
browser issue surfaces. Display-2× resolution is the standard retina
buffer; going higher just wastes bytes the rendering layer doesn't use.
Total measured savings: 1,230 KiB → 339 KiB (−891 KiB, 72.4 %).
**Touched:** `scripts/optimize-landing-images.js` (new); 11 files in
`images/` (new `.webp` siblings + arrow-icon shrunk in place);
`client/src/pages/LandingPage.tsx` (7 imgs); `Navigation.tsx`,
`ClaimAccount.tsx`, `SharedStoryViewer.tsx`, `TrialGenerationPage.tsx`,
`TrialWizard.tsx` (logo references); `.gitignore` (backups).
**Status:** ✅ active.

---

## Covers get full page-style evaluation (semantic + 3-stage + placement)
**Context:** Cover images (title page, initial page, back cover) skipped semantic
eval, three-stage compliance, and the P1 visual-inventory pass — all gated to
`evaluationType === 'scene'` in `evaluateImageQuality`. Those passes carry the
standing-surface / implausible-placement check, so a title page with characters
"standing in the river" scored 86 and shipped; the single quality pass missed it.
The original rationale was that semantic eval compares an image against the page's
story prose, and a cover has no prose — but the physics/placement/figure checks
were bundled into the same scene-only gate even though they need no prose.
**Decision:**
- Covers now run all three fidelity passes. The semantic reference is the cover
  brief (`sceneHint` = `scene.outlineExtract`) in place of page prose.
- Covers are head-on portraits, so viewer-gaze and a flat (non-3D) title are
  intended, NOT defects. Two-part fix: (1) the outline's cover `GAZES AT` rule
  now sets every cover figure to gaze at `the viewer`, so a correctly rendered
  cover matches its brief; (2) a COVER note tells the fidelity + quality
  evaluators not to deduct for viewer-gaze or a flat title — while still flagging
  placement, garbled object text, and missing/extra/mismatched characters.
- Only the unified repair pipeline's eval was changed (the authoritative scorer
  that persists versions, picks best, and triggers cover regen). The in-loop
  generation-time eval for covers was deliberately left without fidelity passes
  to avoid extra cover regens on every story.
**Rationale:** Covers are the marketing image; an in-river or garbled-text cover
must be caught and regenerated like any bad page. Viewer-gaze leniency prevents
the new strictness from regenerating good covers for facing the camera.
**Touched:** `server/lib/images.js` (`evaluateImageQuality` gates + cover note),
`prompts/story-unified.txt` (cover GAZES AT rule).
**Status:** ✅ active.

---

## 2026-07-04 — Code-review cleanup: 18 fixes shipped, 6 structural refactors deferred

**Context:** The 2026-07-04 high-effort review (docs/review-2026-07-04.html) found
43 issues. 19 P0/P1 (security/billing/pipeline) shipped earlier. A follow-up pass
implemented the remaining contained findings.

**Decision:** Shipped 18 more to staging — DUP-1..7 (dedup: data-URI strip x56,
withRetry, image-metadata/costume-key helpers, grokAspect + rembg modules), SW-1..5
(collapse dead composite gate to single source `enableSceneComposite:false`; delete
dead storyAvatarGeneration.js + face-comparison code + phantomPoseRender flag),
SPD-1..6 (poll knownPages dedup, per-page rehydrate on repair endpoints,
structuredClone + parallel image inserts, parallel cover bbox, useMemo parse),
STR-6 (7 inline prompts → prompts/*.txt). Deferred 6 structural refactors
(STR-1 pipeline split, STR-2 images.js god-file split, STR-3 positional-args→object,
STR-4 25-endpoint ownership middleware, STR-5 StoryDisplay split, VAR-1 image-version
data-model unification) to individual staging-tested PRs.

**Rationale:** The 18 are behavior-preserving and provable by the generation
showcase. The 6 deferred touch god-files / 25 repair endpoints / persisted data that
one autonomous showcase cannot validate; bundling them would risk the safety gate.
Each has a concrete plan.

**Touched:** ~30 files across server/lib, server/routes, server.js, config/models.js,
client; new lib/grokAspect.js, lib/rembg.js, utils/imageMetadata.js, utils/costumeKey.js.
**Status:** ✅ active. Plans: docs/review-2026-07-04-structural-plan.md.

---

## 2026-07-05 — jsonb 256MB overflow on repair-heavy stories (finalize save)

**Context:** A staging showcase (comic, 14pp, 11/11/11 repairs) failed at finalize
with Postgres `total size of jsonb array elements exceeds the maximum of
268435455 bytes`. Root cause: `extractInlineImagesToR2` moves debug base64
(bboxOverlayImage, charRepair*, grids, grokRefImages…) to R2 and swaps in URLs,
but on an R2 upload failure it retains the base64. The safety-net
`stripInlineImagesFromStoryData` is an explicit allow-list that did NOT cover the
per-version `charRepairGrokRaw/BlendMask/Whiteout` fields, so those leaked and,
across many repaired versions, overflowed PG's 256MB jsonb cap. Pre-existing
(unrelated to the 2026-07-04 cleanup; discovered by its validation showcase).

**Decision:** (1) Added `charRepair*` to the version strip explicitly. (2) Added a
generic recursive base64 safety-net sweep at the end of
`stripInlineImagesFromStoryData` that drops ANY remaining inline base64 image
string, EXCEPT within `styledAvatars`/`costumed` subtrees (per-story data with no
other home). Guarantees the blob can never overflow from a debug field again,
regardless of R2 outages or newly-added image fields.

**Rationale:** Every inline payload here is redundant (source of truth is the
characters table / story_images / R2). Losing a diagnostic image on an R2 outage
is always better than failing the entire story save. Unit-tested: base64 dropped,
R2 URLs kept, styledAvatars preserved.

**Touched:** `server/services/database.js` (`stripInlineImagesFromStoryData`).
**Status:** ✅ active.

---

## 2026-07-05 — Search ads land on the HOMEPAGE — final, do not re-litigate

**Context:** June: 79 paid clicks → homepage, 0 reached /try (the /try page-view
conversion pixel fired zero times), 0 trials, 0 attributable books. Prior
history: ads pointed at /try, repointed to homepage 2026-06-14, question
re-raised 2026-07-05.
**Decision (user, explicit):** ads keep landing on the homepage. Permanently.
The optimization surface is the HOMEPAGE→/try path (CTA prominence, homepage
conversion), never the ad final URL.
**Touched:** none (status quo confirmed).
**Status:** ✅ final.

## 2026-07-09 — Storage & observability overhaul: what shipped, what's deferred, what's dead-by-decision

**Context:** Four-agent audit of image storage (R2 completeness), the version
viewer, prompt/output logging, and repair-method docs. Full findings in the
session; fixes shipped across `ba2d2f92..50d79c26`.

**Decisions:**
- **Dead code is MARKED, not deleted** (user decision): the mask-inpaint
  dispatcher (`inpaintWithMask` + 8 siblings in images.js), server
  `chooseRepairStrategy`, `MODEL_DEFAULTS.inpaintBackend`,
  `enableAutoRepair`, and the two unread `REPAIR_DEFAULTS` iterate
  thresholds all carry DEAD CODE/CONFIG banners. Do not document them as
  live; do not wire the thresholds in without recalibrating (their values
  disagree with the hardcoded gates in repairLogic.js).
- **Eval calls have a 120s timeout** (stuck-at-51% incident 2026-07-07):
  abort → withRetry → skip-eval-and-continue. A hung provider call can no
  longer freeze a job.
- **grokRefImages is the model-agnostic "refs sent" field**: all
  callGeminiAPIForImage/generateImageOnly branches stamp prompt + refs on
  their results (name kept for save-path + viewer compat).
- **Character source photos upload to R2 at write time**; the wizard's
  echoed base64 never overwrites a stored URL; the backfill script no
  longer self-blinds (marker doesn't exclude rows). Full prod backfill run
  2026-07-09: 31 rows, 77 MB reclaimed.
- **Cover retryHistory persists to story_retry_images under negative page
  numbers** (frontCover -1, initialPage -2, backCover -3).

**Deferred (deliberately, not forgotten):**
- `saveStoryData`/`upsertStory` ~150-line duplication merge — highest-risk
  write path; needs its own session with an end-to-end story-save
  validation run.
- Deleting the `/images` SLOW blob path — blocked: 11 prod stories (mostly
  Jan 2026) still have no story_images rows. Migrate them first (re-save
  through saveStoryData), then delete.
- R2 orphan cleanup on character delete + checkpoint cleanup on job
  failure — improvement, not selected in this round.
**Touched:** server/lib/images.js, sceneValidator.js, entityConsistency.js,
coverComposite.js, scoring.js, services/database.js, routes/regeneration.js,
routes/avatars.js, routes/characters.js, routes/stories.js, config/models.js,
server.js, client repairDefaults.ts, scripts/admin/backfill-character-photos.js,
docs/codebase-guide.md, docs/image-generation-methods.html.

## 2026-07-09 — Realistic style: redress pass instead of full styling skip

**Context:** For realistic, styled-avatar generation was skipped entirely
("photos are already realistic"). But the outline contract
(story-unified.txt: clothingRequirements.description "IS the outfit" and the
model MAY change garments/add accessories) is fulfilled by the styled-avatar
redress for every other style. Skipping it meant realistic scene refs (and
composite-cover cutouts, whose pass-1 prompt commands "keep clothing
exactly") wore the creation-time outfit while the prompt text said the story
outfit — the visual ref wins, so story outfits never rendered, and the
entity eval (which judges against clothingRequirements) flagged the
mismatch it couldn't fix.

**Decision (user, option A):** realistic keeps skipping STYLE transfer (the
2x4 sheet's Pass 2 already skips it) but redresses per category when the
resolved story outfit differs from the stored avatars.clothing — Pass 1
generates a realistic sheet in the requested outfit. Unchanged outfits (the
common case) generate nothing. server.js gates no longer exclude realistic;
prepareStyledAvatars decides per category. applyStyledAvatars applies
redressed avatars for realistic (cache misses are the normal case there —
logged quiet, not as ERROR).

**Also fixed:** getStyledAvatarForClothing's no-styled-avatars fallback
tried base 'standard' BEFORE the requested category (winter-page repairs and
entity grids got standard-clothing references); and when realistic has some
redressed categories, a non-redressed category now prefers its own base
avatar over a redressed standard.

**Touched:** server/lib/styledAvatars.js, server/lib/entityConsistency.js,
server.js (4 gates).

---

### Char-repair misregistration + blur guards (blended/cutout)

**Date:** 2026-07-09

**Context:** A prod page shipped with a blurred/"blended"-looking figure after
character repair. Two verified mechanisms in `repairCharacterMismatchWithGrok`:
(1) Grok redraws the page freehand and `resizeGrokToSceneDims` can center-crop
— the output sits a few px off the original, and the blend mask (feather ring
+ ORIGINAL-scene silhouette) is built in original coordinates, so old and new
content crossfade into a smeared figure; (2) blended mode signals "redraw
this" with a blur, and diffusion editors sometimes ENHANCE the blur instead
of replacing it — the exact failure that gave the cutout path its magenta
crosshatch, never ported to the blended path (sibling gap, still open —
switching blended to a shape-aware hatch needs scene-harness validation
before shipping).

**Decision:** three guards at the `repairCharacterMismatchWithGrok`
chokepoint (all callers inherit): (a) `estimateGlobalShift` — background-patch
SAD (±8 px, ≥3-patch consensus, low-variance patches skipped) measures Grok's
global drift; output is re-aligned via `shiftRawRegion` before any mask math
(blended + cutout); (b) blended's silhouette gate now uses old ∪ new — rembg
runs on Grok's repaint too, union-gated by area plausibility (⅓×–3×), so an
offset repaint is neither clipped by the old outline nor leaves old-figure
pixels standing; (c) sharpness gate — Laplacian edge-energy of the figure
bbox, repaired < 50% of original → repair rejected
(`rejectedReason: 'repaired_figure_blurred'`), original page kept. Plus one
eval bullet (image-evaluation.txt figure-completeness list): a whole figure
noticeably blurrier than the rest of the page → MAJOR `smeared_artifact`.
Gates fail open (guard error → repair accepted unchecked, warned) so rembg
or sharp failures never kill a repair that used to succeed.

**Rationale:** feathering smooths seams but cannot re-register shifted
content; the mask must match where the figure actually landed. Ratio-based
sharpness (not absolute) so soft art styles (watercolor) pass. Thresholds:
`REPAIR_SHARPNESS_REJECT_RATIO 0.5`, `REPAIR_SHARPNESS_MIN_ORIG 25`,
`MAX_SHIFT 8`, `MIN_VARIANCE 60`.

**Touched:** server/lib/images.js (helpers + blended + cutout branches),
prompts/image-evaluation.txt, docs/image-generation-methods.html.

## 2026-07-10 — /geschichten-aus town URLs removed from the sitemap

**Context:** Organic-decline investigation found 51 towns × 3 langs (153
URLs) submitted in the sitemap since 2026-03 that never had a client route
or prerendered page — every one served the generic SPA shell (soft-404 /
duplicate ballast). GSC data showed the only thing they attracted was
zero-intent trivia impressions.
**Decision:** de-sitemap (not build): /stadt/:city already covers city SEO
with real prerendered pages; a second thin city-page family would be
doorway-page territory. seoMeta route handlers kept (direct visits still
get correct meta). Re-add the sitemap loop only when the pages become real
(route + prerender + own content).
**Touched:** server/lib/seoMeta.js (generateSitemap).

## 2026-07-10 — Image versioning: pinned active versions + explicit DB index stamps

**Context:** Version-handling audit (write paths, read paths, git history)
found one recurring root cause behind years of "wrong version shows" bugs:
`recomputeAllActiveVersions` (score-based, runs inside EVERY save) fought
every path that sets an explicit active version. Style-transfer/scale-repair
set active then called saveStoryData — the recompute immediately reverted to
the best-scored older version (the new one is unscored, so it could NEVER win);
manual version picks survived only until the next save. Second cause: two
index allocators — `getNextVersionIndex` (DB MAX+1) vs `imageVersions.length-1`
— diverge on lazy-migrated stories, and `_alreadySaved` was honored for covers
but ignored by both scene save loops (double-write, possibly at a WRONG index,
overwriting an older version's bytes). Third: the blob `activeVersion` mirror
ran AFTER the `UPDATE stories SET data` on a clone, so it never persisted —
blob readers (client, entityConsistency) fell back to "latest" while serving
paths (PDF/print/share) resolve meta = best-score.

**Decision:**
- `image_version_meta[key]` gains `pinned: true`. Pinners (explicit user
  choice): manual active-image PUT, iterate, style-transfer, scale-repair,
  inpaint auto-repair, cover regen/iterate/edit. The recompute (and
  scripts/admin/recompute-active-versions.js) skips pinned keys but still
  mirrors the pinned choice onto the blob. A PLAIN `setActiveVersion` call
  replaces the meta entry and thereby CLEARS the pin — deliberate: pipeline +
  repair-workflow pick-best hand the page back to score-based selection.
- Version entries written by regen routes carry `dbVersionIndex` (the real DB
  version_index) + `_alreadySaved`. Save loops (scenes now too) skip
  `_alreadySaved` and write at `dbVersionIndex ?? arrayToDbIndex(i)`; all
  pickers/mappers (`getActiveIndexAfterPush`, recompute, rehydrate, GET
  merges) prefer the stamp over identity mapping.
- Both `length-1` allocation sites (iterate scene, auto-repair) now use
  `getNextVersionIndex`.
- Recompute moved BEFORE the blob UPDATE in `persistStoryToDatabase` and
  `saveScenePageData` so the `activeVersion` mirror actually persists.
- Stale-pointer fallback unified on v0 (serving parity): `/images` full mode
  no longer clamps to max. `resolveActiveVersionData` (entityConsistency)
  prefers numeric activeVersion, then ROOT imageData (= meta-active after
  rehydrate), and "latest" only as a last resort. GET slow path attaches
  meta-resolved activeVersion. `getActiveVersion` blob fallback checks numeric
  `activeVersion` before the legacy `isActive` boolean.
- `updateStoryDataOnly` deleted (zero callers; saved cover versions but not
  scenes, never recomputed).

**Rationale:** one selection rule needs one escape hatch, not seven endpoints
racing it. Score-based selection stays the default; a pin is the single,
explicit, durable way to override it. Explicit DB stamps make the blob↔DB
mapping self-describing instead of relying on identity that lazy migration
breaks.

**Touched:** server/services/database.js, server/lib/scoring.js,
server/lib/versionManager.js, server/lib/entityConsistency.js,
server/routes/regeneration.js, server/routes/stories.js,
server/routes/admin/database.js, scripts/admin/recompute-active-versions.js,
tests/unit/version-manager.test.ts, tests/unit/active-version-recompute.test.ts,
tests/manual/test-save-merge.js.

## 2026-07-11 — Rendered-text severity is graded: small in-world signage ok, large/wrong text catastrophic
**Context:** Commit 5792322e (2026-06-07) made every rendered-text leak flat
CRITICAL so the redo gate would fire ("Holzbank am Stadtturm" painted on a
bench shipped at 70 ≥ 60). Flat-CRITICAL over-penalised harmless in-world
signage (a shop sign, a book spine) the same as a garbled caption across the
sky.
**Decision:** Owner rule: "minor text on signs is acceptable, large wrong
text is catastrophic." Graded severities in `image-evaluation.txt`:
incidental small plausible in-world signage → not flagged (MINOR if
garbled); prominent/large text, wrong or garbled words,
captions/watermarks/story-text painted into the image → CATASTROPHIC. Same
grading applied to `character_marking` (avatar back-panel artifact):
obvious/prominent marking → CATASTROPHIC, subtle/ambiguous → CRITICAL. Cover
TEXT RULES block (`images.js` `evaluateImageQuality`): title
missing/misspelled → CATASTROPHIC (the title is the point of a cover); other
prominent unrequested text → MAJOR (inpaintable STRAY_TEXT path); the old
"Score MUST be 0" sentence dropped (the model's numeric score is
audit-only). The "so the redo gate fires" clauses were deleted — under the
math scale a CATASTROPHIC (−50) lands the page ≤ 50 < 60 and fires the redo
arithmetically; `decideRepairMethod` also routes any catastrophic-severity
issue to iterate (commit "catastrophic severity routes like critical").
**Rationale:** Grading restores the intended effect (real text leaks always
redo) without nuking pages for a legible shop sign that belongs in the
scene. Supersedes the flat-CRITICAL rule from 5792322e.
**Touched:**
- `prompts/image-evaluation.txt` — §3 rendered-text definition, STEP 0
  catastrophic trigger list, STEP 3 RENDERED TEXT + CHARACTER MARKING blocks
- `server/lib/images.js` — cover TEXT RULES injected block; TITLE_ERROR
  classifier matches CATASTROPHIC|CRITICAL (old stored evals)
**Status:** ✅ active (supersedes commit 5792322e's flat-CRITICAL rule).

## 2026-07-11 — Cover gaze is code-owned: `gazes at:` removed from cover hints, always the viewer
**Context:** The cover-hint per-character `gazes at:` field created a
three-way conflict (finding #21): the outline could aim a gaze at a prop
(`gazes at: ART005`), the composite POSES lines hardcoded "Eyes wide OPEN
looking straight at the viewer", and pass-2 said "do NOT redirect any gaze
toward the camera". The prompt rule already said every cover gaze must be
`the viewer` — a field whose only valid value is a constant is not data.
**Decision:** The field is removed from the cover-hint spec in
`story-unified.txt` (rule bullet, field shape, example, all template
lines); one scene-level sentence states covers are head-on portraits.
Rendering owns gaze: every cover consumer hardcodes "the viewer" /
"gazing at the viewer" and ignores any parsed `gazesAt` value. Parsers
(outlineParser/shared.js + unified.js) still ACCEPT `gazes at:` on
bullets — old stored stories and model habit — the value is simply unused
on covers. Scene-page gaze semantics (facing-vs-gaze rules,
interactions[]) are untouched.
**Rationale:** One owner per fact. Extends the logged viewer-gaze rule
from prompt-enforced to code-owned; the pass-2 "preserve gaze" line now
agrees (keep looking at the viewer) instead of contradicting.
**Touched:**
- `prompts/story-unified.txt` — cover section (rule deleted, shape/example/
  templates stripped, portrait sentence added)
- `server.js` — streaming cover prose composer (constant gaze)
- `server/lib/coverIterate.js` — buildCoverSceneFromHint (constant gaze,
  resolveGazeTarget removed)
- `server/lib/coverComposite.js` — STORY ACTION lines (holds only), pass-2
  synth prose (constant gaze), pass-2 PRESERVE line aligned
- `server/lib/compositeCastBuilder.js` — buildAction (constant gaze)
**Status:** ✅ active (extends "cover portraits: viewer-gaze not a defect").

## 2026-07-11 — Story clothingRequirements is the ONE canonical clothing source; entity eval was repainting story outfits back to stored
**Context:** Realistic showcase (staging, "Die rote Dose"): redress pass,
page prompts, and cover refs were all CORRECT (story outfits), but the
entity-consistency eval judged against the character-level stored
`avatars.clothing[category]` — its canonical came from
`buildCharacterDescriptionsForBbox`, which fed raw stored clothing into
`bboxDetection.characterDescriptions`. It flagged every page + cover as
`clothing_inconsistent`, issued fixInstructions like "change the bright
pink jacket to the dark blue butterfly jacket", the cover repair executed
one, and the scorer (same wrong canonical) ranked the reverted cover ABOVE
the correct v0 (73 vs 55). The July-8 fix (591b19a2) covered
evaluateImageBatch but not this sibling builder.
**Decision:** Every canonical clothing text resolves through
`buildClothingDescription` with the story's `clothingRequirements`
(signature → description → stored fallback), and every reader of
`clothingRequirements[name]` goes through the shared case-insensitive
`resolveCharacterReqs` (clothingCategories.js). Supporting fixes: cover
prompts now carry a per-character CLOTHING block (previously image-refs
only — no text anchor); redress name-miss logs ERROR instead of silently
skipping; `getStyledAvatarForClothing` normalizes its category at entry;
repair paths resolve the page's stored clothing before defaulting to
'standard'; `applyStyledAvatars` prefers the originally requested category
over a photo-fallback category; `primaryClothing` is computed (dominant
category) instead of hardcoded 'standard'.
**Rationale:** One source of truth per concept. Image refs and prompt text
previously desynchronized through independent fallback ladders; the eval
loop then actively reverted correct images because its reference text was
from a different (stale) source than the generation path.
**Touched:** `server/lib/clothingCategories.js` (resolveCharacterReqs,
resolvePageClothingCategory), `server/lib/storyHelpers.js`
(buildCharacterDescriptionsForBbox, getCharacterPhotoDetails,
buildCharacterReferenceList includeClothing), `server/lib/entityConsistency.js`
(buildClothingDescription, getStyledAvatarForClothing, repairSinglePage),
`server/lib/images.js` (quality-retry threading, char-fix category),
`server/lib/styledAvatars.js` (redress name guard, applyStyledAvatars),
`server/lib/coverIterate.js` + `server.js` (cover clothing text +
threading, primaryClothing), `server/routes/regeneration.js`.
**Status:** ✅ active.

## 2026-07-14 — Last clothing-default leak closed: vision analysis primed iterate rounds with the stored outfit
**Context:** Continuation of the 2026-07-11 sweep above — one leak site was
missed. On job_1783889777354 ("Grossvaters Kiste") P1, v0 rendered Hans
correctly in his story polo, but every iterate round (v2+) repainted him in
his base-character default (red plaid + suspenders); Emma the same (default
butterfly shirt instead of her story cotton top). The scene prose was NOT
dropping the outfit — it was being FED the wrong one. `formatCharacterContext`
(sceneValidator.js), which builds the character context that primes
`analyzeGeneratedImage` (the vision analysis feeding `previewFeedback.composition`
into scene iteration), read `char.avatars.clothing[category]` directly — the
stored default — instead of the story clothing. The vision model then described
the default outfit even though the image showed the correct one, and the iterate
adopted that description.
**Decision:** `formatCharacterContext` resolves clothing through the same
`buildClothingDescription(char, category, null, clothingRequirements)` every
other path uses (story `clothingRequirements` → `avatars` fallback). Swept all
remaining `avatars.clothing[category]` reads in `server/lib`; every other one
already prioritizes `clothingRequirements`, so this was the sole unguarded site.
Reverted the interim prose-mandate attempt (84790ac7) — it was built on the
false premise that the model was DROPPING correctly-supplied clothing, and its
"mandatory" banner wording violated the terse-prompt rule; the real input fix
makes it redundant.
**Rationale:** The stored per-character default must never enter a story — only
the per-story `clothingRequirements` is authoritative. A vision-analysis prompt
primed with the wrong outfit silently propagates it through the whole repair loop.
**Touched:** `server/lib/sceneValidator.js` (formatCharacterContext +
buildClothingDescription import), `server/lib/storyHelpers.js` (corrected the
buildImagePrompt comment), `prompts/scene-expansion.txt`,
`prompts/scene-iteration.txt`, `prompts/scene-iteration-free.txt` (reverted
prose mandate). The entity-eval costumed-promotion guard (943c0198 Part B) is a
separate, still-active fix.
**Status:** ✅ active.

## 2026-07-11 — SOLID-GROUND rule: one canonical wording per prompt layer
**Context:** "Characters stand on solid ground, never in water" lived in six
drifted formulations (3 cover templates, coverComposite pass-1 + its
PRESERVE carve-out + pass-2, coverIterate plate characterSpace).
**Decision:** Three canonical formulations, one per layer:
1. Cover templates (front-cover / initial-page-with-dedication /
   initial-page-no-dedication), identical bullet: "All characters stand
   firmly on solid ground — feet flat on a stable surface (floor, pavement,
   cobblestones, grass, path). Never standing in or on water, never
   floating, never mid-air; feet visible on the ground and level with each
   other."
2. Composite edit prompts: module const `SOLID_GROUND_REPAINT`
   (coverComposite.js) shared by pass-1 and pass-2; the PRESERVE carve-out
   references "per the SOLID GROUND rule above" instead of restating it.
3. Empty-scene plates (coverIterate characterSpace): band-level variant —
   plates prepare ground before figures exist, so it speaks about the
   bottom fifth of the frame, not about feet.
**Rationale:** Six drifted statements of one rule invite partial edits;
each layer genuinely needs different phrasing (generation bullet, edit
repaint instruction, plate preparation) but not six.
**Touched:** prompts/front-cover.txt, prompts/initial-page-*.txt,
server/lib/coverComposite.js, server/lib/coverIterate.js
**Status:** ✅ active. (Note: back-cover.txt has no solid-ground rule at
all — pre-existing gap, not added here.)

## 2026-07-11 — OPEN QUESTION: cover text baked into the image vs app-side overlay
**Context:** Cover titles / dedications / the back-cover URL are painted by
the image model (front-cover.txt TITLE block, composite textLine). Model
lettering is the top source of garbled cover text; an app-side overlay
(like the story-text overlay) would be pixel-perfect but loses the
hand-painted look and needs per-style font work.
**Decision:** OPEN — no implementation. Current state: baked-in. The
composite flow renders text exactly once (two-pass: pass-2 only; single
pass: pass-1 only, no pass-2), so no re-lettering pass exists.
**Rationale:** Product call (aesthetics vs reliability) — needs owner
input, not an engineering default.
**Touched:** (none — question only)
**Status:** 🟡 open product question.

## 2026-07-12 — Text-usage accounting: chokepoint is the single source of truth
**Context:** Token/cost accounting undercounted Anthropic usage by ~3.5x per
story (and the Anthropic console showed ~12M tokens/week vs the pipeline's
logged ~0.7M). Root cause: every Claude/Gemini/xAI text call had to remember
to call the job's `addUsage()` closure, and most didn't — or only
conditionally, or into a `byFunction` bucket that had to be pre-declared or the
entry was silently dropped. Whole stages (scene expansion, phantom patch,
eval consolidation, VB dedup, and every unlabeled eval/repair Claude call) were
invisible.
**Decision:** The two text dispatchers `callTextModel` / `callTextModelStreaming`
are the ONLY place text usage is recorded. A new AsyncLocalStorage usage context
(`server/lib/usageContext.js`) holds the running job's sink; the chokepoint
records every call into it automatically. Guarantees: (1) no call escapes —
unlabeled calls land under `text_uncategorized`; (2) no double-count — a
dedup-by-usage-object-identity guard in `addUsage`, plus removal of the two
`phantom_patch` manual adds (that helper returns a COPY of the usage, the one
case identity-dedup can't catch); (3) clean breakdown — callers pass
`options.usageLabel`, and unknown labels auto-create their `byFunction` bucket
instead of being dropped. Concurrency-safe (per-job async context, mirrors the
styled-avatar cache scoping), no-op outside a job, never throws into the render.
**Rationale:** One chokepoint that can't be bypassed beats N scattered
conditional call sites. Verified on staging (job_1783832998294_vzhyem13c):
per-story Claude capture rose 88K → 313K; previously-invisible
`eval_consolidation` (100K) and `text_uncategorized` (140K) now appear; no
doubling.
**Touched:** `server/lib/usageContext.js` (new), `server/lib/textModels.js`
(chokepoint), `server.js` (both addUsage closures: sink + dynamic buckets +
dedup; removed phantom double-adds; usageLabels), `server/lib/phantomCharacters.js`,
`server/lib/feedbackConsolidator.js`, `server/lib/images.js`,
`server/lib/visualBible.js` (internal usageLabels).
**Follow-up:** `text_uncategorized` (~140K/story) bundles the remaining
unlabeled Claude eval/repair calls — label them individually if finer
attribution is wanted. The landmark-indexing batch calls Claude via
`callAnthropicAPI` directly (bypasses the dispatcher) but runs outside a job,
so it's out of scope for per-story accounting.
**Status:** ✅ active.

## 2026-07-13 — Generation and evaluation share ONE per-page clothing source
**Context:** On a costume-change page (job_1783889777354 P1: Noah has donned the
ninja suit, Emma is still in standard clothes holding hers), the pipeline
flip-flopped Emma's outfit between repair rounds — iterate rendered her standard
(correct), a later inpaint repainted her into ninja (wrong). Root: generation
and evaluation resolved her per-page clothing from DIFFERENT data.
- **Generation** learned clothing only from the free scene PROSE + avatar pixels;
  the canonical per-character clothing STRING computed in buildImagePrompt was
  logged and discarded (removed once to save Grok chars). The prose said Emma was
  "gripping a folded black ninja costume" (held, not worn) and never stated her
  worn standard outfit — so "ninja" was the only textual clothing token.
- **Evaluation** judged against characterClothing category → buildClothingDescription.
  Two evaluators diverged: the semantic-compliance eval reads the PROSE (misreads
  held-vs-worn), and entityConsistency.js collectEntityAppearances had a
  page-agnostic fallback that promoted ANY character with a costume anywhere in
  the story to `costumed` on EVERY page (Emma uses standard + costumed:ninja).
**Decision:** One canonical per-page, per-character clothing category
(`characterClothing[name]`) → `buildClothingDescription`/`clothingDescription`
feeds BOTH sides.
- (A) The worn outfit is ALWAYS supplied as input to the scene prose (each
  character's `Wearing:` line, resolved from the characterClothing category —
  verified: Emma page-1 got "light pink cotton top…"). The failure was the
  scene-expansion / scene-iteration model DROPPING it and narrating a HELD
  costume instead. Fixed at the source: scene-expansion.txt / scene-iteration.txt
  / scene-iteration-free.txt now mandate stating every character's WORN clothing
  in the prose and clarify that a costume held/found/nearby is NOT worn. (An
  earlier attempt injected a separate WORN CLOTHING block into the image prompt;
  reverted — it duplicated data already carried by the prose and lengthened it.)
- (B) entityConsistency.js collectEntityAppearances fallback only assumes
  `costumed` when the costume is the character's SOLE outfit across the story
  (no standard/winter/summer used); otherwise keeps the standard default. Emma →
  standard, Noah (costume-only) → costumed.
**Rationale:** generation and evaluation must be driven by the same clothing
field or they contradict and repair oscillates. clothingRequirements is
page-agnostic (lists every outfit a character wears anywhere) — never use it to
DECIDE a per-page category, only to describe one already chosen.
**Touched:** server/lib/storyHelpers.js (buildImagePrompt worn-clothing block),
server/lib/entityConsistency.js (costume-only fallback guard).
**Follow-up:** scene-expansion prose could also be tightened to always state
worn clothing + mark held items; and the >7500-char prompt truncation should
protect the WORN CLOTHING block over trailing prose.
**Status:** ✅ active.

## Char-repair figure mask: box-prompted SAM on a padded crop, not a whole-crop box (2026-07-15)
**Context:** The fullScene inpaint char-repair (`grok_inpaint`) built its magenta
crosshatch by cropping the scene tight to the figure box, then asking the
silhouette endpoint for `[0,0,cropW,cropH]` — the entire crop. On a loose box
that also spans a bright doorway/window (background figures standing near an
opening), both SAM and rembg segment that background object instead of the
figure, so the magenta landed on the background. Grok then repainted the
background (a no-op) and the target stayed unrepaired. Reproduced deterministically
on p4 of `job_1783981243217_bhub4d1ji` (Daniel, anime): magenta hatched the
covered-bridge doorway; SAM on `[0,0,cropW,cropH]` returned the doorway (62% fill),
SAM on the full image + Daniel's real box returned a clean Daniel silhouette.
**Decision:** (1) `figureMaskForHatch` crops with 50% padding around the figure box
and passes the REAL figure box mapped into crop pixel coords — the same pattern the
blended path (`fetchFigureMaskPng(cropForSilhouette, figureBoxInCrop)`) already used.
Both fullScene call sites (input hatch + feather fitness-check) go through it.
(2) Default `figureMaskBackend` flipped `rembg` → `mobilesam`: box-prompted SAM
isolates the single figure; rembg (salient-object, no box) cannot. rembg stays the
graceful fallback when SAM is unavailable/empty.
**Rationale:** Padded-crop + real-box gives the segmenter spatial context (verified to
isolate the figure) while keeping the rembg fallback correct (it runs on a
figure-centred crop, not the full scene where it would mask every figure). Chosen over
literal full-image + box specifically so the rembg fallback doesn't segment all figures.
**Touched:** `server/lib/images.js` (`figureMaskForHatch` in the useFullScene branch;
both hatch + feather call sites), `server/config/models.js` (`figureMaskBackend` default).
**Status:** ✅ active. Staging-first; prod default flip pending staging validation.

## Test Lab: is_test sandbox versions + explicit-template prompt overrides (2026-07-15)
**Context:** Prompt changes were validated on whatever single story was at hand —
no way to check a change across art styles/story types, and viewing other users'
stories required impersonation (2h token, lossy switch-back). Test generations
also polluted the story owner's version list.
**Decision:** (1) Plain admins may READ any story (`canReadAnyStory` in
stories.js) — write endpoints stay owner/impersonation-gated. (2) Test Lab
generations write `story_images` rows flagged `is_test` (+`experiment_id`);
every user-facing read filters `NOT is_test`, while `getNextVersionIndex`
deliberately counts test rows so promote = flip the flag with no re-index.
Promote appends a dbVersionIndex-stamped entry to the data blob and pins active.
(3) Prompt A/B overrides pass an explicit template into the builders
(`buildEmptyScenePrompt`/`buildEvaluationPrompt` `opts.template`,
`evaluateImageQuality` `evalOptions`, `evaluateSemanticFidelity` 5th param) —
never mutate `PROMPT_TEMPLATES` across an await; the only swap-based path
(`buildImagePrompt`) is synchronous, so no concurrent generation can observe it.
(4) Experiments run sequentially in-process, max 25 targets — bounded cost, no
queue infra; per-target results persist to `testlab_experiments.results`.
**Rationale:** Flag-on-rows reuses all existing versioning/R2/eval plumbing with
one column; a separate table would duplicate the byte-serving and promote paths.
Explicit-template params beat a global swap because prod generations share the
process.
**Touched:** migrations/008_testlab.sql, server/lib/testlab.js,
server/routes/admin/testlab.js, server/routes/stories.js, server/services/
database.js, server/services/prompts.js, server/lib/images.js,
server/lib/sceneValidator.js, client/src/pages/TestLab.tsx.
**Status:** ✅ active (staging-first; migration runs at boot).

## GroundingDINO uses a concise grounding prompt, not the image-gen description (2026-07-15)
**Context:** The GDINO figure-detection path fed each character `buildCharacterPhysicalDescription`
(+ `Wearing:` appended) — ~250 chars of face geometry (jawline/chin/nose-tip/cheekbones/lips) that
GDINO can't see in a render, filling its 256-token cap and truncating the one groundable token
(clothing colour). Measured across styles (staging, char-repair p4 investigation): verbose prompt
scored anime 0.445 / realistic 0.422, both with figure MISATTRIBUTION (one character's box collapsed
onto another's). A short "adult man with a beard wearing a green shirt" scored 0.86 on the same page.
**Decision:** New `buildGroundingPrompt(char)` (storyHelpers) emits a concise grounding prompt —
`a[n] {ageCategory} {genderTerm} with {hairColour} hair [and a beard] [glasses]` — carried as
`gdinoIdentity` through `buildCharacterDescriptionsForBbox`, then `buildExpectedCharactersForBbox`
appends the per-page clothing colour (short, capped) as `gdinoPrompt`. `detectFiguresWithGroundingDino`
prefers `c.gdinoPrompt` over the verbose `c.description` (falls back to it). The verbose description
stays the Gemini bbox prompt (Gemini reads face geometry fine).
**Rationale:** GDINO grounds on visually-locatable tokens, not fine facial features. Re-validated with
production wiring: anime 0.445→0.585, realistic 0.422→0.688, misattribution gone, all figures found.
Same-outfit same-age figures (e.g. two kids in identical kimonos) can still collapse in BATCHED
multi-figure detection; single-figure queries (char-repair) avoid it. Watercolour stays weak (painterly
render vs photo-trained backbone) — keep it on Gemini.
**Touched:** `server/lib/storyHelpers.js` (buildGroundingPrompt + gdinoIdentity + export),
`server/lib/images.js` (buildExpectedCharactersForBbox gdinoPrompt, detectFiguresWithGroundingDino
prompt source, export), `scripts/analysis/validate-gdino-figures.js` (harness).
**Status:** ✅ active (staging). Does NOT change the realistic-only detection gate — only improves the
prompt. Broadening the gate to anime/pixar is a separate future decision informed by this data.

## Correction (2026-07-15): watercolour is NOT weak once the prompt is concise
The entry above said "Watercolour stays weak … keep it on Gemini." Re-validation with the concise
`buildGroundingPrompt` disproved that: watercolour scored 0.632 (vs 0.34–0.50 with the verbose prompt),
comparable to anime (0.585) and realistic (0.688). The realistic-only gate is an artifact of the old
verbose prompt, not a real style boundary. Broadening GDINO to all styles is data-supported; the only
real cost is ~15s/figure CPU latency. Remaining soft spots (same-outfit kids, batched-attribution
collapse) are not style-specific. **Status:** ✅ correction active; gate still realistic-only in code
pending a broadening decision.

## GroundingDINO gate broadened from realistic-only to all figure-rendering styles (2026-07-15)
**Context:** GDINO detection was gated to `artStyle === 'realistic'` (73cf220f), set when the verbose
prompt made stylized styles look weak. Once the concise buildGroundingPrompt landed, re-validation
showed all three tested styles land together (realistic 0.69, anime 0.59, watercolor 0.63) — the gate
was an artifact of the bad prompt, not a style boundary.
**Decision:** New `MODEL_DEFAULTS.figureDetectionEligibleStyles` allow-list; the gate is now membership
in it. Enabled: realistic, anime, watercolor (tested) + steampunk, cyber, pixar (user-requested,
anime/3D-render family) + comic, cartoon, manga, concept, oil (same clothed-human clean render,
inferred). Excluded (stay on Gemini): chibi (super-deformed head/body), pixel (blocky low-res),
lowpoly (geometric faceted) — these break GDINO's human-figure assumption. Env override
FIGURE_DETECTION_STYLES=a,b,c.
**Rationale:** GDINO + concise prompt grounds on clothed-figure shape + clothing colour, which every
non-abstract style renders. Validated across the widest span (photo-realistic / cel-anime /
painterly-watercolor). comic..oil untested but structurally identical to what passed; chibi/pixel/lowpoly
genuinely differ. Still fails open (GDINO error → Gemini). Backend still env-gated to grounding-dino
(prod stays gemini).
**Touched:** `server/config/models.js` (figureDetectionEligibleStyles), `server/lib/images.js` (gate).
**Status:** ✅ active (staging). Latency unchanged (~15s/figure CPU) — only widens where GDINO may run.

## DINO goes generic: "person"/"face" prompts for geometry, identity resolved separately (2026-07-17)
**Context:** Even the concise identity prompt (age+gender+hair+clothing) produced bad production
boxes — Sarah's bodyBox collapsed to her head, Hans to a 0.046-height sliver, Noah lost entirely
(watercolor job_1784149662006). User insight: semantic vision (Gemini) trivially tells the young girl
from the old woman; the failure was always box GEOMETRY. Asking one text prompt to do detection AND
identity attribution is the design flaw.
**Decision:** Split the jobs. DINO gets generic prompts only: `"person"` for figure boxes (best +
candidates, NMS 0.5), `"face"` for face boxes (filter out person-sized leaks by IoU>0.5 vs person
boxes; keep box_threshold 0.20 — small-object face scores run 0.27–0.51). MobileSAM masks each person
box (box-only; face points optional via new `/figure-mask` points param but not needed when the box is
tight — and a bad point can drag the mask out of the box). Identity (which box is which character) is
a separate assignment step (Gemini face names / position prose), never a grounding-prompt job. DINO
`"face"` also replaces the Haar/anime cascade for face anchoring — it found a background elderly face
Haar missed and has no phantom problem after the size filter.
**Rationale:** Validated on 12 pages / 28 figures across watercolor, anime, realistic, comic (incl.
the exact production-failure pages): 100% figure recall, scores 0.59–0.73, zero head-only collapses;
Sarah's generic-prompt box matched ground truth within ~4px. Point-only SAM is unusable (control).
**Touched:** `photo_analyzer.py` (/figure-mask points/point_labels), `scripts/analysis/test-figure-cutouts.js`,
`scripts/analysis/test-sam-face-point.js` (validation harnesses). Commit 787e160f.
**Status:** ✅ validated; production wiring of detectFiguresWithGroundingDino to this design still pending.

## Test Lab — full-coverage stages (2026-07-17)

**Context:** Coverage audit found Test Lab could re-run only 9 of 37 pipeline features; the whole repair loop, covers, and text zone had no isolated re-run path.

**Decision:** Every new stage wraps the exact core function the existing regeneration.js endpoints / repair pipeline already call — zero new pipeline logic. New stages: text_zone (ensureCalmZone), consolidate (consolidateEvaluation), inpaint (inpaintPage), iterate (iteratePageCore), repair_round (decideRepairMethod → inpaint/iterate/char-fix auto — one full automatic round on one page), edit_image (editImageWithPrompt), artifact_repair (gridBasedRepair), scale_repair (runScaleRepair), style_transfer (applyStyleTransfer), pick_best (report-only version ranking), scene_expansion + scene_description (LLM diff stages, sync template swap), avatar_eval (sheet evals standalone), cover (iterateCover with new explicit promptTemplateOverride option — never a PROMPT_TEMPLATES swap across await), style_check (checkStoryStyleConsistency, report-only). Cover/style_check are story-level targets ({storyId, coverType}); promote now supports cover types (pin via coverType key in image_version_meta). repairMode on char_repair was silently ignored before (no such option) — now mapped to useBlended/useCutout/useFullScene.

**Rationale:** One source of truth per repair method; Test Lab results stay representative of production behaviour (same fn, same params), and prompt A/B runs can't leak overrides into concurrent prod generations.

**Touched files:** server/lib/testlab.js, server/routes/admin/testlab.js, server/lib/coverIterate.js (promptTemplateOverride), client/src/pages/TestLab.tsx, client/src/services/testlabService.ts.
