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
