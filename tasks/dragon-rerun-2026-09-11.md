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
