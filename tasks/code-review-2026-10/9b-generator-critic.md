# Area 9b — Generator ↔ critic consistency (review 2026-10-04)
Finder (1 × Sonnet) + verifier (Opus).

Counts are read-only queries over `stories.data.sceneImages[]` (staging + prod). "45d" means stories created in the last 45 days (staging 913 judged pages / 58 stories, prod 253 / 16). Background that changes several verdicts: the blind prompt-compliance judge has been OFF since 2026-09-19 (`docs/SETTLED.md:34`, `server/config/models.js:650`). No stored story created after 2026-09-20 has a single compliance finding on either environment, so every compliance-only finding below is latent today.

## Confirmed

### G1 image-semantic.txt gives the same defect two different severities
- STEP 3 brackets: wrong main action **[CRITICAL]** (`prompts/image-semantic.txt:41`). Wrong location **[CRITICAL]** (`:43`). Broad clothing category **[MAJOR]** (`:45`). Declared physical-contact interaction wrong **[MAJOR]** (`:55`).
- SEVERITIES list in the same prompt: "Wrong main action: MAJOR" (`:91`). "Wrong setting/location: MAJOR" (`:90`). "Wrong clothing type on a character: MODERATE" (`:98`). "Declared interaction missing or in a genuinely different category (e.g. object in pocket drawn as large held plush, on-head drawn in-hand): CRITICAL" (`:89`). The `:89` examples are the same categories `:55` rates MAJOR.
- Nothing in code settles it. `action_interaction`, `setting` and `clothing` have no entry in `MAX_SEVERITY_TYPES` or `MIN_SEVERITY_TYPES` (`server/lib/scoring.js:173-259`). Both lists came in with commit `f3ff0e6df` (2026-04-26), and the old list was never reconciled with the new brackets.
- How often it bites: the judge splits almost evenly between the two printed severities.
  - Staging, 45d: `action_interaction` 187 CRITICAL / 227 MAJOR / 41 MODERATE. `setting` 15 CRITICAL / 29 MAJOR. `clothing` 50 MAJOR / 9 MODERATE.
  - Staging, stories since 2026-09-20: `action_interaction` still 27 CRITICAL / 32 MAJOR.
  - Prod, 45d: `action_interaction` 49 CRITICAL / 62 MAJOR. `setting` 7 CRITICAL / 9 MAJOR.
  - The two severities are far apart. CRITICAL costs 25 points against 15, puts the page in `findBadPages`' critical arm, and three CRITICALs on one page trip the semantic < 30 iterate gate (`repairLogic.js:906`).
- Kind: a contradiction in the prompt, but choosing which side wins is a severity choice, so it **needs the owner**.
- Fix direction: keep one severity per check. Either delete the SEVERITIES list and let the STEP 3 brackets stand, or the reverse. If a code bound is wanted, it is a `MAX_SEVERITY_TYPES` row, which is also an owner call.

### G2 image-semantic.txt asks for two types that its own closed list does not contain
- `:55` and `:64` tell the judge to emit `wrong_interaction`, and `:57` to emit `spec_conflict` CRITICAL. The closed list at `:117-118` contains neither and says "an unlisted value is discarded as unroutable".
- That claim is false: no code discards semantic types.
  - `wrong_interaction` reaches `action_interaction` only because the compound splitter happens to pick its second token (`evalBuckets.js:304-316`).
  - `spec_conflict` has no row in `TYPE_TO_BUCKET`, so it lands in `other`, which repairs by regen.
  - `wrong_interaction` also carries the G1 split: MAJOR at `:55`, CRITICAL at `:89`.
- Downstream mostly settles `spec_conflict`. The consolidator runs its own deterministic declared-interaction check (`feedbackConsolidator.js:1158-1175`), drops those findings with reason `spec_conflict`, and the repair decision routes to iterate first (`repairLogic.js:890`). Both stored pages that carry a semantic `spec_conflict` also carry a `spec_conflicts` plan and a dropped `spec_conflict` reason: `job_1790539784661_6mjcny1c7` p18 and `job_1788471969309_9cg9dqyirre` p11.
- How often it bites: rarely. Staging 45d: `spec_conflict` ×2, `wrong_interaction` ×6 (2 CRITICAL, 4 MAJOR). Prod: `wrong_interaction` ×1.
- Kind: a **pure bug** for `wrong_interaction`. Renaming it to `action_interaction` at `:55`/`:64` keeps the bucket the splitter already produces. For `spec_conflict`, giving it a list entry and a bucket row is routing, so it is a small **owner** call. The cheap alternative is to delete `:57`, because the consolidator already owns this check.
- Fix direction: make the type list and STEP 3 agree, and remove the false "discarded" sentence.

### G4 The compliance judge bills any hair difference MAJOR, with no nuance tier (latent)
- Compliance: `- **Hair**: Vision hair vs prompt.` (`image-prompt-compliance.txt:124`). "wrong hair = MAJOR" (`:161`, `:183`). The type is `character_identity` ("wrong person, age, or hair", `:221`), which has no ceiling.
- Quality D-07 says only colour or a dramatic length change is MAJOR and everything else about hair is MINOR (`image-evaluation.txt:145`). The owner's MINOR cap exists only as the entity type `hair_nuance` (`scoring.js:179-187`), which compliance never emits.
- How often it bit while the judge ran (90d, all before 2026-09-20): `character_identity` MAJOR/CRITICAL findings that mention hair, 158 on staging and 41 on prod. Since the judge was switched off: 0.
- Kind: severity/classification, so it **needs the owner**. It only matters if the judge is re-armed, and SETTLED requires new precision evidence first.
- Fix direction, on re-arm: give compliance D-07's MINOR tier, or the `hair_nuance` type.

### G5 The compliance prompt contradicts itself, and quality, on height order (latent)
- STEP 2b: "never compare two characters' heights to each other, and never report a figure as too tall or too short relative to another figure" (`image-prompt-compliance.txt:134`).
- The "Figure height" paragraph in the same prompt: "Report `scale`, at most MAJOR, when the inventory ranks figures … in an order that plainly contradicts" HEIGHT ORDER (`:176`).
- Quality D-29: "Never deduct for the height ORDER between characters … `height_order` is recorded for review only" (`image-evaluation.txt:187`).
- How often it bit: 2 compliance `scale` height findings on staging, 0 on prod, all before the judge was switched off.
- Kind: deciding which line wins is a policy choice that **needs the owner**. Quality's "record only" is the settled side (decisions.md line 1170). Today it is inert.
- Fix direction: delete `:176` so compliance matches STEP 2b and D-29.

### G7 sceneBriefCheck points at a deleted prompt file
- `server/lib/sceneBriefCheck.js:344`, `:745`, `:1545` and `:1601` cite `prompts/scene-expansion-all.txt` as the live statement of the rule. That file no longer exists. The rule now lives in `prompts/scene-briefs-all.txt:280`.
- The numbers 30/50/3 are written by hand in both places (`sceneBriefCheck.js:370-395` and `scene-briefs-all.txt:280`) and **agree today**. That is a drift risk, not a current contradiction.
- Kind: **pure bug** (stale comments).
- Fix direction: repoint the comments. If wanted, export the three numbers from one constant into both the check and the brief template.

### G8 The text audit's "obvious doer" question has no writer-side rule
- `prompts/story-text-audit.txt:19` (UNFORCED): "So does the obvious doer — where the one who needs the thing, or is plainly the most able to fetch it, stays behind while others go, the book says on some page what keeps them from going."
- The generator-side `CAUSAL_COHERENCE_RULE` (`promptBuilders.js:7007-7011`) covers only the barrier half: "every barrier the story leans on has its way around closed on some page".
- No writer, arc or text prompt states the obvious-doer half. A grep for "stays behind", "most able" and "obvious doer" outside the audit returns nothing. `story-arc-audit.txt:11` asks the barrier half only.
- How often it bites: not counted; the text-audit findings are not typed by question.
- Kind: **pure fix**. The skill says adding the generator counterpart of an existing judge rule needs no ask.
- Fix direction: append the obvious-doer sentence to `CAUSAL_COHERENCE_RULE`, the one constant every writer path already receives.

### G10 `clothing_sex` reaches its bucket only through the splitter
- `clothing_sex` is in `CONSOLIDATED_TYPES` (`evalBuckets.js:440`) and is emitted as quality D-05c (`image-evaluation.txt:142`). It has no `TYPE_TO_BUCKET` row and resolves to `clothing` only via the splitter's first token. That is the exact pattern the comment at `evalBuckets.js:186-193` calls "by accident" and fixed for `hair_nuance` and `face_drift`. The route it gets today (clothing) is the right one.
- Aside: the doc comment at `evalBuckets.js:434-436` says `tests/unit/finding-types-closed-list.test.ts` pins the consolidator's list to `CONSOLIDATED_TYPES`. That test does not exist and has no git history. The two lists match today but nothing pins them.
- Kind: **pure bug** (hygiene).
- Fix direction: add `clothing_sex: 'clothing'`, and write or repoint the pin test.

## Plausible

None. Each candidate either reproduced from the current files or was refuted.

## Rejected
- **G3** (compliance bills a wrong clothing type CRITICAL, quality MAJOR): a deliberate owner ruling of 2026-09-12 (decisions.md "The costume CRITICAL needs actually-modern dress"). Modern dress where a costume is contracted keeps CRITICAL, every other type is MAJOR, and a ceiling was rejected. The judge has been off since 2026-09-19 (94 staging / 5 prod clothing CRITICALs before that, 0 since).
- **G6** (D-18 fires at three faces, generator stages only more than three): no real gap.
  - Every figure on a story page gets a code-written `looksAt` target, never `viewer` (SETTLED:66).
  - D-18 fires only when the prompt has the figures interacting.
  - Measured 45d: 0 quality camera/group-photo `action_interaction` findings on the 72 staging and 13 prod pages with exactly 3 characters.
- **G9** (age judged against the declared age, generators use the photo band): no longer true and partly deliberate.
  - The 2x4 sheet builder now injects the stated age: "That stated age decides the proportions in every cell" (`character2x4Sheet.js:663`). That matches sheet-eval TASK 6.
  - Page prompts use the photo-read `apparentAge`, clamped to ±1 band, by design (`promptBuilders.js:1991-1996`). The judges tolerate a few years.
  - The compliance STEP 2b leg is off.
