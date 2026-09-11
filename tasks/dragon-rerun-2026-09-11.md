# Dragon rerun 2026-09-11 — first live exercise of the 2026-09-09 → 11 fixes

Staging job `job_1789147573901_m3uam0nxi` ("Der Drache, der nicht fliegen konnte"), rerun of
`job_1788903616404_iqvhj4l8m` by `scripts/admin/rerun-story-on-staging.js`. 18 pages, de-ch,
watercolor, summer, cast Levin 5 / Julian 3 / Max 3 / Kiaan 3, brief names Max's dog Nia.
Staging commit `25513ee5`. Launched 19:26 CH, `completed` 20:19 CH (53 min). Read-only
evaluation — no paid calls, no code changes.

Evidence sources: `stories.data` for both jobs (dumped locally), `story_jobs` polling,
`GET /api/health/config`, Railway `railway logs -s MagicalStory -e staging -n 5000` (the CLI
refuses more than 5,000 lines, so the arc-stage server lines are not retrievable; the stored
`generationLog` and `arcReviewReport` cover that stage), and every page/cover image viewed.

## Checklist

| # | Item | Evidence | Verdict |
|---|------|----------|---------|
| 1 | VB trim persisted (`c16838db7`) | `beatsReviewReport.vbAssignmentTrim`: 9 pages over budget → 0, 19 (element,page) claims stripped, 2 states dropped (`ART003.1`, `ART003.2`). `rankPageElements` re-run over the STORED bible with the stored briefs: 0 pages over `VB_ELEMENT_BUDGET`; by `appearsInPages` alone: 0. `vbTrimLostPages(storedVB, trim)` = `[]`. Outline `---VISUAL BIBLE---` JSON carries the trimmed `pages` (ANI001 `[6,7,8,10,11,12,13,14,15,18]` = stored; ART003 `[]`, ART009/010 `[]`). No `vb_trim_lost` in `generationLog`. | **PASS** — the trim reached the stored bible and the outline. **But see D1**: the trim stripped the key prop ART003 from every page. |
| 2 | Creature tone (`{CREATURE_TONE}` → `not-menacing`) | Commit `05ba6c706` is an ancestor of `25513ee5`. Bible ANI002 Fauchi: "rounded snout with wide friendly nostrils, large warm amber eyes with a level brow ridge, small rounded ear-frills", "four sturdy legs with rounded claws", size "body length approximately four metres … wingspan approximately five metres". Guards CHR001/002: "expression permanently calm and open", "horizontal crack forming a closed neutral mouth". Original bible: "children appear tiny beside him", "two backward-swept curved horns", "dark clawed feet"; Nolo "small deep-set amber eyes under heavy brow ridges". Pixels: p4/p7 dragon = big round eyes, closed mouth, small horns, friendly; p12/p13/p15 guards = boulder heads, calm; p16 small guard drawn as a slim grey humanoid with large black eyes (odd, not menacing); **p18 dragon has open jaws with visible teeth and tongue** — the one page that reads fierce. Original p4 (narrow-eyed horned dragon) and p13 (hooded, heavy-browed troll) are gone. | **PASS at the bible level; 17/18 rendered pages not-menacing; p18 shows bared teeth.** |
| 3 | Invented cast enumeration + forced round (`4ba47ceff`) | `arcReviewReport.create` critique carries `Invented figures:` / `- Fauchi — the grounded dragon` / `Allowed: 2. Written: 1.` Round-1 retell critique: "Invented named figures: Fauchi only. Allowed 2, written 1. Nia and the four boys are commissioned; the guards stay unnamed." No parent figure. `roundsConfigured 1, roundsRun 1`; no `arc_invented_overcount*` event in `generationLog`; no forced round; cost of forced round $0. Beats cross-check (`recheck.counterFindings`, the shipped plan): `ARC_INVENTED_UNDECLARED: Gemüsebrücke, Limmat, Velolampe, Velos, Velo, Nia … (arc declared: Fauchi)`. | **Arc side PASS** (count correct, parent gone, nothing forced). **Counter side FAIL** — bridge, river, lamp, bikes AND the commissioned dog are still reported as undeclared invented figures (D3). |
| 4 | Cover roster + `extra_character` (`53f7a9b62`, `a80eb1786`) | Cover description names Levin/Julian/Max/Kiaan + Gemüsebrücke only; KEY STORY ELEMENTS carries **Fauchi** (full definition) and the scale **Artifact** — every named entity is defined; Fauchi is defined but not placed in the prose, and rendered anyway as a statue-like dragon behind the boys. EXPECTED CAST = 4 (the `fixableIssues` text quotes the roster; Nia is neither in the description nor the roster nor the prompt — `prompt.includes('Nia') === false`). Quality eval `figures[]` = 4, `matches`: 1→Levin .85, 2→Max .85, **3→unmatched**, 4→Kiaan .85 → `missing_character: Julian` CRITICAL + `extra_character: figure 3` CRITICAL. Figure 3 = "blonde, curly, short; yellow t-shirt, grey shorts" = Julian's own wardrobe line in the same prompt; the semantic eval and the consolidator's `preserve` list both say "Julian in front center". The consolidator still emitted "Remove the boy in yellow from center-foreground"; the inpaint (v1) **removed Julian** — 3 boys, score 5, rejected; v0 shipped at **13**. Pixels v0: four boys, all four commissioned faces, Levin holding a large green dish, dragon behind, **no dog**. | **FAIL** — `extra_character` fired on a mis-matched commissioned child and drove a destructive repair (D2). Dog absent from the cover by construction (not in hints/roster). |
| 5 | Repair gate + caps (`75ee892bf`) | Railway: `[FIND-BAD] page 13: score 70 … CRITICAL`, `page 15: score 70 … MAJOR object_presence (semantic) — type rescue`, `page 17: score 85 … CRITICAL`, `page -2: score 85 … type rescue`; `[REPAIR-CAP] Round 1: 16 page(s) eligible for repair on a 21-page story — cap is 11 (50%). Admitting 11 worst-first: 6, 9, -1, 10, 5, 13, 17, 2, 7, 14, 4. DEFERRED: 11, 16, 15, 3, -2`. `repairMaxPasses` on staging = 1, so deferred pages got nothing. `runMetrics.redo_trigger = 11`. | **Mechanics work as coded**, but the denominator is 21 (18 pages + 3 covers pushed into `rawImages` at `storyJobPipeline.js:5276`), so the cap was 11, not the 9 the decision entry describes ("20 pages → 10"); two pages (p11 55, p16 55) shipped unrepaired while a type-rescued cover slot was admitted (D4). |
| 6 | Text move rule + shingle check (`08fd2d5ad`) | `textRefineReport.repetition = {minShingles 4, pairs [], correctivePassRan false, resolved true, cost 0}`. Own run of `findRepeatedPassages(sceneImages[].text, 4)` = `[]`; at floor 2 = `[]`. Full read: no scene repeated across pages; p12/p13 (the original's duplicate) are distinct. Lector applied 4 corrections. | **PASS** (nothing to correct; corrective pass not exercised). |
| 7 | Truncation guard (`497890e1f`) | `/api/health/config` `textTruncation`: `suspected 2, byReason {cap_hit: 2}, byLabel {arc_panel: 1, plan_recheck: 1}`, `last`: `plan_recheck`, `openai/gpt-5.6-luna-pro` via Azure, `outputTokens 17278`, `capInForce 16384`, `stopReason "stop"`. Both replies were consumed normally (3/3 panelists proposed; plan_recheck yielded 7 counter + 10 model findings). No `truncation` entry in `generationLog`; no stage marked failed. | **Guard fires; suspicion unverified.** 17,278 output tokens with a 16,384 cap "in force" and `finish_reason=stop` cannot all be true — either OpenRouter's `completion_tokens` for luna-pro includes reasoning tokens or the cap is not enforced upstream (D5). |
| 8 | Plan counters (`756033e73`, `e541d93b5`, `38fdd4d9c`, `2edeb4e82`) | Shipped-plan check (`recheck.counterFindings`): `CAST_OVER_3 page 6, 9` (p6 = Max, Kiaan, **Velo**, Nia), `INVENTED_DOMINANT_EXCESS page 1, 17, 18` (p1 = Levin + Gemüsebrücke + Limmat), `NO_COMMISSIONED_ON_PAGE page 12, 17, 18` (plan says "all four boys"/"the four boys" — no names), `ARC_INVENTED_UNDECLARED: Gemüsebrücke, Limmat, Velolampe, Velos, Velo, Nia`. `cast.invented = [Velo, Gemüsebrücke, Limmat, Velolampe, Velos, Fauchi, Nia]`. No full-name/first-name double count (no such names in this story). | **FAIL** — `cast.invented` is not sane; 4 of 6 counter findings on the shipped plan are false positives (D3). |
| 9 | Every page viewed | Table below. | 18/18 + cover viewed. |
| 10 | Cost | `tokenUsage.byFunction` sum **$6.382** (text $3.49, image gen $1.84, eval $1.05). Original story $7.119. Marginal new: forced arc round $0, corrective text pass $0, cover repair (admitted via cap) $0.04 inpaint + evals, 2 cap-excess admissions ≈ $0.10–0.15. | **OVER the $6.00 cap by $0.38 (6.4%)**; $0.74 cheaper than the original. |

## Per-page read (best version = what ships)

Scores are `finalScore` of the shipped version. "regen" = `wasRegenerated`.

| Page | Score | regen | Human read |
|------|-------|-------|------------|
| 1 | 85 | no | Levin alone on the Rathausbrücke, lamp raised, beam bright. Cast 1/1 correct; a few tiny background pedestrians, no phantom cast. Fine. |
| 2 | 68 | yes | Levin (red) ahead looking back at Julian (yellow) on the hill road, both on bikes. Cast 2/2. Fine. |
| 3 | 73 | no | Levin crouched at the cave mouth with the lamp; the "small scale" is a **dinner-plate-sized green dish** (spec: coin-sized). Cast 1/1. Prop wrong. |
| 4 | 70 | yes | Plan/brief: Fauchi alone emerging from the cave (`sceneCharacters = []`). Image: **Levin with a red bike, Julian sitting, Nia, and a small friendly dragon in the cave mouth** — three phantom cast members on a creature-only page. Dragon tone friendly; house-sized in the text, toddler-sized here; wing gap not visible. |
| 5 | 70 | yes | Levin calm at the cave, lamp in hand, dragon wing with a hole at the frame edge. Cast 1/1. Good. |
| 6 | 0 | yes | Four boys + Nia + green bike at the cave; Nia's nose points at Julian, not Levin (CRITICAL `action_interaction`, unrepaired). Cast 4+1 correct. Shipped at 0. |
| 7 | 55 | yes | Fauchi's head low beside Levin and Julian, calm amber eyes, closed mouth, small horns. Cast correct. Tone: not-menacing. |
| 8 | 98 | no | Levin fist raised, mouth open; Julian grinning up. Cast 2/2. Best page. |
| 9 | 5 | yes | Four boys + Nia at the stone steps; Levin and Julian lay bikes flat, **Max and Kiaan sit on theirs** (CRITICAL, unrepaired). Cast correct. Shipped at 5. |
| 10 | 45 | yes | Kiaan pointing at a **two-arm, letterless** wooden signpost (plan: three arms, painted letters); Levin beside him. Cast 2/2. Shipped at 45. |
| 11 | 55 | no | Max pushing the slab with both hands, Nia digging, low sun. Cast correct. Deferred by the cap, never repaired. |
| 12 | 70 | no | Four boys from behind, two boulder-headed stone guards either side of the crack, mountains. Cast correct. Guards calm. Good. |
| 13 | 85 | yes | Levin before the big guard (arms crossed) — and a **whole green dragon lying at the guard's feet** where the scale should be (CRITICAL `object_presence`, unrepaired; Fauchi is not on this page). Phantom creature shipped at 85. |
| 14 | 70 | yes | Julian holding the small fragment beside the large fan-ridged scale on the stone; stone hand reaching. Cast 1/1. Reads correctly. |
| 15 | 70 | no | Levin sitting sad; the guard reduced to a rock formation with the engraved circle. Cast 1/1. Acceptable. |
| 16 | 55 | no | Levin shines the lamp at the two guards; the small guard is a slim grey humanoid with large black eyes (off-model but not menacing). Deferred by the cap. |
| 17 | 85 | no | Four boys + Nia descending the steps; Levin carries a **green spiky lizard/dragon** instead of the scale (CRITICAL `object_presence`; the inpaint scored 15 and was rejected). Lamp glow at the top of the steps present. |
| 18 | 60 | no | Four boys + Nia on Fauchi over Zürich (Grossmünster). Cast correct, joyful. **Dragon's jaws open with teeth and tongue showing** — the only fierce-looking dragon frame. |
| Front cover | 13 | v1 rejected | Four boys (all commissioned), Levin holding a large green dish, dragon as a statue behind, title baked and legible, **no dog**. Eval misread Julian as an extra figure → CRITICAL; the repair removed him (3 boys) and was rejected. |

Original story comparison: orig p4 (horned, narrow-eyed dragon looming over two boys) and orig p13
(hooded troll with heavy brow and glowing eyes) — both replaced by friendly designs this run.

## Cost line

Total **$6.382** on a **$6.00** cap (over by $0.38). Split: text chain $3.49 (arc create/retell
$0.98, arc panel + hints $0.17, beats stages $0.85, plan checks $0.07, text refine + audits + diff +
lector $1.32, translation + compress $0.10); image generation $1.84 (page_images $1.16, inpaint $0.24,
covers $0.18, 2×4 sheets $0.26); evaluation $1.05 (page_quality $0.39, semantic $0.28, repair-round
eval $0.22, consolidation $0.07, rest $0.09). Original run: $7.119. Nothing new was expensive: no
forced arc round, no corrective text pass; the cap admitted the cover and two more pages than an
18-page denominator would have (≈ $0.15).

## Confirmed defects (evidence first)

**D1 — the assignment trim stripped the key prop from every page, and the pages then hallucinated it.**
`vbAssignmentTrim.stripped` removes ART003 (Grosse Schuppe) from 13, 14, 15, 16, 17 ("not named in
page N's plan line") and drops states ART003.1/.2; stored ART003 `appearsInPages = []`,
`referenceImageUrl` undefined (no cell ever rendered). Briefs p13 `objects = [LOC006, CHR001]`, p14
`[CHR002]`, p17 `[LOC005, ANI001]`; no REQUIRED OBJECTS row for the scale on 13/14/15/17; `ART003`
absent from every page prompt. Results: p13 phantom dragon, p17 lizard, p3/cover dish (ART002 —
same family). The plan lines say "the big wing scale", never the id, so "named in the plan line"
ranks the story's central object last. → `server/lib/beatsPipeline.js` assignment trim,
`server/lib/vbElementBudget.js` ranking.

**D2 — `extra_character` CRITICAL fired on a commissioned child and drove a destructive cover repair.**
Cover v0 matches `3→unmatched` while figure 3's own inventory ("blonde, curly, short; yellow
t-shirt, grey shorts") is Julian's wardrobe line; semantic eval lists Julian present; the
consolidator's `preserve` says "Julian in front center" and its instruction says "Remove the boy in
yellow". v1 = three boys, score 5. A CRITICAL on an identity-match failure is a removal order for a
real child. → `prompts/image-evaluation.txt` D-04b, `server/lib/evalPipeline.js` roster,
`prompts/feedback-consolidator.txt`.

**D3 — plan counters still count things and the commissioned dog as invented cast.**
`resolveCast` → `cast.invented = [Velo, Gemüsebrücke, Limmat, Velolampe, Velos, Fauchi, Nia]`.
`isThingMarked` needs an article/place-preposition IMMEDIATELY before the name; the shipped plan
writes "Levin alone, Gemüsebrücke stone railing and Limmat water", "his lit Velolampe", "their
Velos", "his Velo" — possessives and bare appositions are not markers, so every one "acts
unmarked". `commissionedNames` holds only the four main characters, so Nia (named in the brief)
is undeclared. Downstream: `CAST_OVER_3 p6, p9`, `INVENTED_DOMINANT_EXCESS p1`,
`NO_COMMISSIONED_ON_PAGE p12/17/18` ("the four boys" carries no name), `ARC_INVENTED_UNDECLARED`.
→ `server/lib/planCounters.js` `THING_MARKERS`, `resolveCast`, `runPlanCounters` callers
(`commissionedNames`).

**D4 — the per-round repair cap counts the three covers as pages.** `[REPAIR-CAP] … on a 21-page
story — cap is 11`; `rawImages` receives covers with negative page numbers
(`storyJobPipeline.js:5214-5298`) and `applyRoundCap` is called with
`totalPages: Object.keys(roundEvalPages).length` (`repairPipeline.js:~1901`). The decision entry
says "20 pages → 10"; here 18 pages → 11, and with `repairMaxPasses = 1` the deferred p11/p16 (55)
never got a round. Owner call whether covers should count; the number does not match the rule as
written. → `server/lib/repairPipeline.js`, `docs/decisions.md` per-round cap entry.

**D5 — truncation guard `cap_hit` with `finish_reason=stop` and a complete reply.** Two suspects
this run (arc_panel, plan_recheck), both luna-pro via OpenRouter, both used normally. Either
`completion_tokens` includes reasoning tokens (then `cap_hit` is a false suspect and the counter
will keep climbing on every luna-pro call) or 16,384 is not the provider's real ceiling. Needs the
raw OpenRouter usage object for one such call. → `server/lib/textReplyGuard.js:65`,
`server/lib/textModels.js:733/864/1057`.

**D6 — p4 rendered three phantom cast members on a creature-only page** (brief `sceneCharacters =
[]`, plan "Fauchi steps out of the cave for the first time"); the eval only scored the wing gap and
shoes. The EXPECTED CAST roster for a page with no people should make two boys and a dog a
CRITICAL `extra_character`; the stored `issuesSummary` shows no such finding. → same files as D2.

Also noted, not new: the VB character-cell render gate rejects the stone guards ("not a plausible
human skin color") twice and accepts anyway — the gate has no non-human branch; p10 signpost lost
its third arm and lettering; p16 small guard off-model.

## What to fix next

1. D1 — the trim must never strip an element the page's prose names (match by entry name/aliases,
   not only by id), and the central prop needs a cell. Highest impact: three CRITICAL pages and
   the cover prop all trace to it.
2. D2 — `extra_character` must not be a removal order when a roster member is reported missing at
   the same time (one figure, two findings = a match failure, not a phantom); or the consolidator
   refuses "remove" when its own `preserve` list names the same zone.
3. D3 — possessive markers ("his/her/their <Name>") and bare noun appositions as THING marks;
   animals from the brief join `commissionedNames`.
4. D4 — decide the cap denominator (story pages vs pages+covers) and write it into the decision.
5. D5 — capture one raw OpenRouter usage payload for luna-pro and settle whether reasoning tokens
   are in `completion_tokens`.
6. p18 dragon teeth: the tone text governs the bible, not the page prompt; check whether the
   `not-menacing` clause reaches `image-generation.txt` for creature pages.


---

## Second pass, 2026-09-11 (owner: "we generate too much shit") - D7-D25

Independent read of the same 21 images and all 18 page texts, after the D1-D6 checklist above.
D1 and D2 are root causes for defects listed here (the prop pages and the cover); D7-D9 are the class
the owner is pointing at - **the pipeline scored these defects, wrote accurate findings, and shipped
them anyway**. Nothing has been written to `tasks/bugs.json`: which of D7/D8/D13 become push-blocking
bugs is the owner's call, and D8 and D14 are prompt-vs-code decisions needing sign-off first.

### D7. A page scored 0 or 5 ships into the final book, silently

p6 finalScore **0** (six CRITICAL `action_interaction`, `unrepairedCritical` populated) and p9 finalScore **5** are the ACTIVE versions. Repair ran on both and moved -20 -> 0 and -15 -> 5; there is no floor, no second pass (`repairMaxPasses=1` on staging), and nothing in the run summary, the job status or the user-facing story says these pages are known-broken. `feedback_gates_are_guidelines` (never kill a paid run) is right, but "ship with a warning" currently means ship with NO warning anywhere. Owner decides the shape: a floor that forces another repair pass, a final-strike WARN surfaced in the run summary + `/api/health`, or a visible failed-pages list on the story.

-> `server/lib/scoring.js`, `storyJobPipeline.js` pick-best-version

### D8. `unrepairedCritical` is populated and then ignored by the score the page reports

p13 and p17 each carry an unrepaired CRITICAL `object_presence` finding **and report finalScore 85**, so to every downstream consumer (pick, run summary, the owner skimming scores) they look like good pages. A CRITICAL that survives repair must cap the score, not sit beside it. Prompt-vs-code decision per CLAUDE.md (`MAX_SEVERITY_TYPES`/`ZERO_POINT_TYPES` ceiling vs an evaluator type) - propose the shape and ask BEFORE writing either. Same two pages as D1: the root cause of the defect is the ART003 trim, this is why it shipped looking fine.

-> `server/lib/scoring.js`, `server/lib/evalPipeline.js`

### D9. Both evaluators are blind on p5 - a missing character and a headless dragon score semantic 100

Text: Julian hides behind his big brother; Levin and the dragon lock eyes, amber and warm. Rendered: **Julian is absent**, the dragon is a disembodied wing at frame-left with no body and no head, Levin looks at empty sky. quality 70, semantic **100**, zero findings - from the same two-witness pair that wrote precise findings on p6/p9/p10/p13/p17. A missing commissioned child plus the page's whole emotional beat absent is not a subtle miss. Same blind-spot class as D6 (p4 phantom cast unflagged): the cast check is not firing on creature/wing pages. Reproduce on the stored p5 v1 image before touching a prompt.

-> `prompts/image-semantic.txt`, `prompts/image-evaluation.txt`, `server/lib/evalPipeline.js` `buildExpectedCastBlock`

### D10. The bicycle lamp renders as a CCTV / broadcast camera in 5 of 5 appearances - probably the same trim as D1

p1, p3, p5, p16 and the initial page all draw the Velolampe as a bulky black box light; **on p16 it has a pistol grip**, so the climax reads as a toddler pointing a black gun-shaped object at two figures. This prop is the story's emotional currency (Levin trades it away in the resolution) and it was never flagged once - p1 scored 85. D1 records that the assignment trim emptied ART003 **and ART009/ART010** to `pages: []`; check whether the lamp is one of those two, in which case it never had a cell or a page-prompt line either and this is one bug, not two.

-> `server/lib/beatsPipeline.js` assignment trim, `server/lib/referenceSheets.js` `elementKindSentence`

### D11. The dragon has no stable size across the book

Text says house-sized. p4 and p7: knee-high, puppy-sized, emerging from a burrow a fox would use. p5: a wing with no body. p18: correctly house-sized. p3's cave cannot contain what comes out of it on p4. The bible fixes Fauchi at "four metres body / five metres wingspan" (checklist row 2) and nothing checks a rendered creature against that, or against the adjacent page.

-> VB creature states, `prompts/image-evaluation.txt`

### D12. Guard identity drifts mid-scene

p12 and p13 draw the stone guards as blocky Michelin-man boulder figures; **p16 draws the second guard as a slim grey humanoid mannequin with large black eyes** (the checklist already noted it as "odd, not menacing" - it is also a different character). p12 renders both guards the same size when the text is explicit that one is door-wide and one small and narrow. Secondary consistency across pages is not covered by the entity check, which tracks `characters[]`.

-> `server/lib/entityConsistency.js`, `server/lib/compositeCastBuilder.js`

### D13. Visible white paper borders on p1, p3, p6, p9, p11 - the bleed rule is not holding

The image prompt says verbatim "filling the canvas, bleeding off all four edges - no borders, frames, margins, white edges". Five of eighteen pages have a white paper margin on at least one edge. For a print product that is a hard defect (Gelato trims into it) and nothing detects it. Cheaply mechanical - edge-row luminance on the final image - rather than another prompt rule (`feedback_mechanical_rules_and_fed_back_retries`).

-> `server/lib/images.js` post-render checks, `prompts/image-generation.txt`

### D14. The whole cast renders as 2-year-olds while the text is 1st-grade with a declared-5 protagonist

Levin is declared 5; every render is a toddler - round face, ~3-head proportions, no neck. Max and Kiaan (declared 3) read as 2. The semantic evaluator **wrote this finding in plain language on p3, p7, p11 and p16** ("rendered as a toddler, 3-3.5 heads tall, not the specified 4.5") and nothing acted on it. The result is a book in which 2-year-olds cycle up a mountain alone, read a signpost, memorise a lock code and lever a boulder: the visual age and the narrative agency are two different books. Highest-leverage single visual fix in this run, and predicted by memory `project_declared_age_vs_photo` (numeric age never reaches image gen; apparentAge is derived, not measured).

-> `server/lib/promptBuilders.js` character description, avatar apparentAge derivation

### D15. Levin's shirt drifts between a blue-collared polo and a plain red crew

Polo on p1/p3/p8, plain crew on p2/p5/p12/p13/p15/p16/p17/p18 and the cover. Everything else holds across all 18 pages (Max green/brown, Kiaan orange/black, Julian yellow/grey), so this is a single-garment detail drift. Low severity, logged so it is not rediscovered.

-> `server/lib/clothingResolve.js`

### D16. p10 - the page is about reading and there is nothing to read

Text: three arms with painted black lettering plus a code board on the third path. Render: **two blank arms pointing the same direction**, no lettering at all, Julian / Max / Nia missing, and a dry Mediterranean scrubland instead of a Swiss alpine path. This is the known "no-lettering rule vs a sign that must be legible" backlog item landing on a real page - the page's entire plot function is illegible.

-> `server/lib/promptBuilders.js` REQUIRED OBJECTS, `prompts/image-generation.txt`

### D17. p12 - the gate and the coded lock, the page's entire plot event, are not drawn

Kiaan turns the little wheels and the iron grate springs open; the image has bare granite, no gate, no lock. Composition is otherwise the best staging in the second half, and it scored 70.

-> scene brief for p12, `prompts/scene-expansion.txt` one-moment rule

### D18. p15 - the image contradicts its own light

Text: the sun goes behind the ridge and the summit turns cold. Render: bright midday blue sky. The guard Levin is pleading with is absent, and Julian, who is crying in the text, is absent. Emotionally the strongest image in the book, in the wrong weather. Time-of-day continuity is not checked anywhere, on any page.

-> `prompts/image-semantic.txt`, scene brief lighting field

### D19. p9 - Nia's red collar becomes a red bandana

Accessory drift on a named animal; the collar is in the bible and is correct on p4, p6, p11, p17, p18. Only p9 swaps it for a neckerchief.

-> `server/lib/entityConsistency.js` object canonicalization

### D20. p11 - Nia is drawn snarling with bared teeth

Text: she digs at the earth under the boulder with her front paws. The render is a dog with its lips pulled back over its teeth, which reads as aggressive in a book for 3-to-5-year-olds. The `{CREATURE_TONE}` work (checklist row 2) covers the dragon and the guards; a commissioned pet is not covered. Same page also puts the boulder beside the path rather than across it, and has Max pushing with hands and chest rather than his shoulder (both already flagged by the eval, both deferred by the D4 cap).

-> `prompts/scene-expansion.txt` creature tone, `server/config/runtime.js` CREATURE_TONE scope

### D21. p2 - the ride goes the wrong way and the lamp is missing from the bike

Text: out of the city and UP the green hill. Render: a road running downhill toward a village, with both boys stationary and their feet off the pedals. Levin's bike also has no lamp mounted, although the lamp is on the bike at this point in the story - he unclips it on p9, which is the plot point that puts it in his pocket for p16.

-> scene brief for p2, VB artifact placement

**Gradient half: FIXED 2026-09-11.** Not a scene-brief fault - the brief's prose already
read "pedalling it forward up a ... road". The gradient was lost in `emptyScenePrompt`,
which the plate is drawn from before any figure is placed. The geometry-mirroring bullet
in `scene-expansion.txt` / `scene-expansion-all.txt` now mirrors gradient as well as
direction. Validated by re-sending the stored 72k prompt with only that edit and rendering
both plates through the production path. A second clause banning imported settlements was
tested and REJECTED - it made the model name a city and the plate render it larger. See
docs/decisions.md 2026-09-11 "The empty-scene plate mirrors the route's GRADIENT".

**Lamp half: OPEN, and wider than one lamp.** ART001 declares `appearsInPages: [1,2,3,16]`;
p2's brief cites `["LOC002","ART011","ART012"]` - no lamp. Not a budget cut (3 artifacts,
`VB_ELEMENT_BUDGET` is 3). The same mismatch holds on 15 of 18 pages; p9 - where the lamp
is unclipped - cites no objects at all. Nothing reconciles the bible's page assignments
against the briefs, and the semantic evaluator scored p2 100.

### D22. p10 is a 126-word page at 1st-grade level and its three-way group split is never paid off

Double the page budget (run mean ~75 words). It splits the group three ways (Levin+Julian centre, Max+Nia left, Kiaan the third path) and everyone is simply back together on p12; it also has Kiaan reading the code off the third path's sign BEFORE choosing that path, which is backwards. Cutting the split costs the story nothing and fixes the length. p12 is the same class at 112 words: gate + code + summit + reunion + crack + two guards + a threat + Julian's fear in one page, exactly where the tension should land.

-> `prompts/story-text-from-beats.txt` page budget, the beats planner

### D23. The title promises a story the book does not tell

"Der Drache, der nicht fliegen konnte" promises a dragon who cannot fly. The dragon flies fine; he is missing a scale, and we never once see him try and fail. It is a fetch quest wearing a disability-story title, and the title is the first thing a buyer reads. `titleJudge` / `titleCandidates` scores candidates but never tests one against the arc it was drawn from.

-> `server/lib/textModels.js` title judge, `prompts/` title templates

### D24. The coded lock is an adult escape-room contrivance invented to give a peer a job

A combination lock with rotating wheels on a mountain gate, with the code posted on a signpost further down the path, exists only so that Kiaan has something to do. Planner-level pattern: a commissioned peer who needs a beat gets a puzzle invented for them rather than a role inside the beat that already exists. Related to the `NO_COMMISSIONED_ON_PAGE` noise in D3 - the planner knows it has peers to place and solves it badly.

-> the beats planner, `prompts/story-arc*.txt`

### D25. Smaller narrative faults, logged together

(a) p7's backstory is a single dragon-dialogue info-dump - two guards, the Grauhorn, the crevice, the same night, all in one breath. (b) Nia has no owner: she arrives dragging someone and it is never said whose dog she is, although the brief names her as Max's. (c) Fauchi cannot cross the Grauhorn without the scale, yet four small children walk there and back in an afternoon.

-> `prompts/story-text-from-beats.txt`, the beats planner

**Not regressions - keep these:** p8 (98, deserved - real expression and real sibling energy), p14 (the two scales matching, the clearest storytelling in the book), p18 (the payoff spread over Zurich with the Grossmuenster), the back cover, the initial page, and the p16-17 lamp-for-scale trade, which is a well-built resolution with a sympathetic motive for the guards. Swiss conventions are correct throughout.
