# 05 — STORY TEXT stage group: findings

## Status 2026-09-23

Checked against staging `31fd7db0c` (after the evening fix round). FIXED = the commit that fixes it; OPEN = no fix yet, no ruling needed to start; OWNER CALL = touches a decision, a SETTLED line or has options the owner picks. Stale-doc and registry items listed at the end of each file were corrected in `a25ecb865` unless listed below.

- FIXED: #1 the diff reverting the refine's fixes — `5a4672c7a` (the diff sees the findings each rewrite answered) + `e47a513f0` (ledger settled after the diff, `restoredSentences`; the word counter also measures the shipped text). #2 arc hints now reach the arc-informed audit and the refine (`{ARC_HINTS}`, `HINT_VS_ARC_RULE`) and both are in the `arc-hint-handoff` set — `e47a513f0`. #5 refine scope is one rule and the refine gets the checker form of DO-NOT-WRITE — `e47a513f0`. D outline-reviewer const assignment — `e47a513f0`.
- FIXED (text-stage round, see decisions.md 2026-09-23 "Text stage after prompt audit 05"; commit in that entry's log line): #3 audit questions — LIMIT covers deadlines, ASSUMED a named feeling never shown, CAUSE a refusal let go, new CONTRADICTION + ENDING, LOADBEARING scoped to what the plot turns on (writer told each rule; blind gains the same cases + ENDING). Replay on the stored writer text ($0.354): deadline, reversed refusal and unshown fear caught, LOADBEARING 5 → 0; the vague ending not caught. #4 blind exemption narrowed to what a picture shows at that instant (owner order; blindness kept). #6 sentences + paragraphs counted in the same counter and fed to the refine (`PAGE_MEASURES`, one `PARAGRAPH_SHAPE` constant). #7 lector gets the reading level. B/05: critics read the writer's brief spec (one builder), refine checks scoped to rewritable pages. C storage: audit prompts and the refine raw reply stored.
- OPEN: #8 wording (Tüte, heavy words); the vague ending (ENDING question did not fire in the replay). Backlog: rough-text lines (run 6).
- OWNER CALL: B wardrobe in the text-stage spec — only a METADATA-built spec removes it safely (BACKLOG); the 1st-grade sentence band (writer runs 6-13 on every page); a Lab recall check of the blind slot; #1 (b) a code guard on restored spans was not built (decisions: "no code provenance guard").

---

Run: job_1790100385959_1nitlympp, "Das Ei im Laub", 18 pp, de-ch, 1st-grade (budget 25-70 words, 3-6 sentences), cast 3-5, commit b03c64b0.
Chain: writer (sonnet-4-6) -> audits (arc-informed gemini-3.1-pro: 10 faults; blind grok-4.6: 0) + word counter (1) -> text_refine (claude-opus-5, rewrote 9 pages) -> text_diff (gpt-5.6-luna-pro, **11 corrections applied**) -> lector (gemini-3.1-pro, 4 applied).
Since b03c64b0, **no text-stage template or builder has changed** (`git diff b03c64b0 HEAD` touches only OTS/shot code in promptBuilders.js and arc effort in beatsPipeline.js). So none of the findings below is fixed yet.

---

## A. CONFIRMED BY THIS RUN (ranked by severity)

### 1. [CRITICAL] The diff judge reverted the refine's audit fixes and invented new text. The shipped book now contradicts its pictures
- Evidence: `11-text.before_after.json` diffApplied. The final text holds:
  - **p11**: refine wrote «Turi sprang von der Mauer und riss ihnen das Bündel aus den Händen … Turi zuckte zusammen» (this closed the audit's LOADBEARING flinch finding and matches the p11 picture: Turi "drops forward off the wall and snatches"). The diff replaced it with **«Turi blieb auf der Mauer.»** That sentence is new, it was never in BEFORE, and it contradicts both the picture and arc beat 10. It then put back «Turi fuhr herum und griff … um seinen Bruder festzuhalten», so the flinch (the arc's stated cause) is gone again.
  - **p16**: refine placed the nest at the wall and had Levin take off his fleece. That closed two audit findings: the p16 TRANSITION about the fleece and the p17 MISMATCH (the p17 picture has the wall behind the hatching). The diff restored «Levin trug das Ei zurück zum Lindenbaum … legte die Jacken der Buben darüber», so **both findings ship again**. p18 «Er glitt von der Mauer» now also contradicts the nest being at the linden.
  - p4: the diff restored the cuts the counter had asked for (92 words; refine had 69). p3 «grössten»→«grossen» and p12 «Niemand antwortete ihm»→«…oder widersprach ihm» are "merely different" changes, which prompts/story-text-diff.txt:3 explicitly excludes.
- Root cause (structural): the diff judge sees only BEFORE and AFTER (`textRefine.js:1399-1402`, `buildTextDiffPrompt` promptBuilders.js:9147). It does not see the audit findings the rewrite answered, the ledger, or the picture spec. Under prompts/story-text-diff.txt:3 ("a fact dropped or contradicted"), any deletion made to fix something looks like damage. Its corrections are applied mechanically (`applyLectorFindings`) and nothing re-audits them.
- Ledger is now false: `findingLedger` is resolved at `textRefine.js:1228`, before the diff runs. It says p11, p16 and p17 were handled, but the shipped text re-carries all three. The word counter (`textRefine.js:1323-1360`) also runs before the diff, so it never measures p4 after the diff restored the words.
- Doc conflict: decisions.md:36826-36856 ("The diff pass does NOT invent prose … every long replacement … was a restoration") and memory project_lector_config_verdicts.md ("they do not invent"). This run disproves both for p11 («Turi blieb auf der Mauer.» is invented). The same entry calls the diff "the safety net behind a hole that is itself already patched". Here the restoration was the damage.
- Improve (generic; this does not reverse "no length guard"): (a) give the diff the findings each page was rewritten for, plus the page's plan line/picture. Tell it that text a finding asked to remove or move must not be restored, and that a correction may not contradict the picture. (b) Or skip diff corrections that restore a span the refine's ledger lists as removed for a finding. (c) Recompute the ledger outcomes and the word counter after the diff and lector. Proposing this touches a logged decision, so the owner decides.

### 2. [HIGH] Arc hints reach the writer but not the audit or the refine, so the refine rebuilt the contradiction the hint had fixed (p15)
- The arc is self-contradictory. Beat 14: Levin "sends Turi to the piles by the wall while he takes the piles by the tree". Beat 15: Levin finds the steam "at the wall". Hint 1 (01-arc/08-arc_hints) fixes this. The writer received it under `{ARC_HINTS}` (promptBuilders.js:9740) and applied it («Er selbst legte sich an die Mauer»).
- `buildTextAuditPrompt` (promptBuilders.js:9186-9236) and `buildTextRefinePrompt` (:5465-5570) get only the unamended arc. The audit therefore filed "FAULT[LOADBEARING]: p15 — The text drops the story's fact that Levin sends Turi to search the piles by the wall", and the refine obeyed. The final p15 reads: «Turi, du nimmst die Haufen an der Mauer. Ich nehme die beim Baum.» / «Levin suchte beim Baum und kroch dann bis zur Mauer.» A parent will ask why he assigns the wall and then searches it. Also, Turi searched those same piles and found nothing, and no page says so. The diff and lector did not catch the new incoherence.
- Hint 2 (Turi should not glide "out of the linden branches") was **not applied** by the writer: p6 «Aus den Ästen des Lindenbaums schoss etwas herab». No critic can see hints, so nothing flags a hint that was dropped.
- Registry gap: set `arc-hint-handoff` (sibling-registry.json) lists only promptBuilders.js, story-beats.txt and story-text-from-beats.txt. The two critics that judge the hinted text (story-text-audit.txt, text-refine.txt) are missing.
- Improve: one master. Either fold the accepted hints into the arc once, before planning, so every downstream stage reads the same story, or pass `ARC_HINTS` (with HINT_VS_ARC_RULE) to both the arc-informed audit and the refine. Then add both to the registry set.

### 3. [HIGH] Story-logic defects in the final text that no judge flagged
- **Broken deadline (LIMIT).** p7: «Ein kaltes Ei wacht nie auf … bevor es dunkel wird». By p12 it is dark («Dazwischen war alles dunkel»), and on p16 the egg is «kühl und still». It still hatches on p17, and no page says why the stated limit did not hold. The writer prompt forbids this ("a limit the plot leans on is stated in the text, and no later page breaks it", 01 prompt line 196), and audit Q8 LIMIT asks exactly this. Neither the writer nor the judges caught it. The source is the arc (stage 01), but this stage states the limit as a rule.
- **Reversed refusal with no stated reason (CAUSE).** On p10 Turi says «Nein … Ich lege das Ei selbst zurück in diese Wurzeln … Das mache ich alleine». On p16 he wordlessly «legte sich rund um das Nest», and it is Levin who beds the egg. Audit Q5 was widened on 2026-09-17 for exactly this case (decisions.md:6079ff) and did not fire. The blind CONTRADICTION twin did not fire either.
- **Fear asserted, never shown (ASSUMED).** p13: «Der Drache, der ihnen Angst gemacht hatte». No earlier page shows the boys afraid. The arc's "the four boys duck" (beat 4) was dropped on p6, and the only reaction there is Julian's defiant sit-down.
- **Self-contradiction added by the refine.** p14: «Julian hatte seine Tüte die ganze Zeit in der Hand behalten», yet p8 has him lay the whole bag flat against the shell. text-refine.txt forbids "a sentence that asserts both the claim and its opposite".
- **p14 undercuts the stake.** The egg is lost and cooling, and everyone sits and snacks («Niemand wusste, was jetzt kommen sollte»). This comes from the plan/hint ordering (stage 02 put the huddle before the egg is found), and the text has to carry it. No judge flagged it as UNFORCED/IDLE.
- **The ending is vague and wrong.** p18: «war aus vier fremden Buben etwas anderes geworden». Two of the four are brothers, and "etwas anderes" states no feeling. That breaks the writer's own rule "land one feeling, plainly and warmly" (01 prompt line 200).
- **Clunky insertion from a LOADBEARING false positive.** p1: «Levin sah hin. Er war fünf, Julian war erst drei.» Ages are not a cause, a uniqueness or a limitation, yet the audit (prompts/story-text-audit.txt:24, "a fact of the story that no page carries at all") treats every arc fact as load-bearing. Five of its ten findings were LOADBEARING. Two of those were misfires (the ages, and p15 per item 2).

### 4. [MEDIUM] Blind audit "FAULTS: 0": a real verdict, not a broken call, but a low-recall one
- The stored audit (read-only DB read of stories.data.textRefineReport.audits[1]) shows ok:true, cost $0.0657, 180s, model x-ai/grok-4.6. At $6/M output that is roughly 10k reasoning tokens. It was not truncated and not an empty-retry, so the model reasoned and concluded zero.
- It read the writer text, where a listener would stumble on several things: the p14 bag (last pressed against the egg, which is now lost; arc-informed caught this), p16 «die Jacken der Buben», the p10→p16 reversal, the deadline broken p7→p12, and the p13 unestablished fear.
- Likely suppressor (judgement): prompts/story-text-audit-blind.txt:1 says "Pictures exist but you cannot see them, so never fault a page for something a picture could be showing." Almost any transition, possession or payoff could be pictured, so the blanket exemption licenses silence. There is also no Lab measurement of grok-4.6 in this blind slot: models.js:367-369 says its 3/10 score "is not evidence about this slot". The only measured blind result in the docs is a single correct catch (decisions.md:6079).
- Is it documented? Yes, as a deliberate design: decisions.md ~32423 (owner ruling 2026-09-03) and prompt-inventory.md:45. The blind audit is denied the arc, plan, picture spec, back cover, cast and reading level. The arc-informed audit gets the arc (no hints), plan lines and the **full brief** per page. Reasons are given in both places. There is no recall measurement for the blind slot.
- Improve: narrow the exemption to "what a picture shows at that instant (a pose, a place, an object in view)". Keep TRANSITION/CONTRADICTION/PAYOFF faultable. Run a Lab recall check of the blind slot on stored text with known faults (this run's writer text is a ready ground truth: at least 5 listener faults).

### 5. [MEDIUM] Refine prompt contradicts itself on what it may rewrite and what it must re-check (05 PROMPT)
- text-refine.txt:58 says a page is rewritable only when AUDIT FINDINGS names it, with four exceptions. But :68, :70 and :72 ("Rewrite any page with…", "Rewrite every occurrence", "Rewrite any page carrying…") and :88 ("A page that contradicts its scene outline … is rewritable on that ground alone", not one of the four exceptions) all grant wider licence.
- DO-NOT-WRITE preamble "the analysis pass does NOT need to re-check them" (prompts/do-not-write-list.txt:1, reaching the refine via `buildDoNotWriteSection`) contradicts check 18 "Verification — Confirm the pages honour the DO-NOT-WRITE LIST" (text-refine.txt:149). The outline reviewer strips that exact line (promptBuilders.js:5348-5354) and the refine does not: an unfixed sibling.
- In this run the refine obeyed the narrow reading. Its analysis flagged the p7/p10 one-sentence closers and «behutsam», then left them alone. So these contradictions cost output tokens rather than defects here. They are latent.

### 6. [MEDIUM] Reading-level contract is not met, and nothing checks it
- The prompt allows 3-6 sentences a page, 2-4 sentences a paragraph and at most 4 paragraphs (01 prompt lines 13-14, story-text-from-beats.txt:14). The final text has about 6-12 sentences on 15 of 18 pages, one-sentence paragraphs on 9 pages, and 5 paragraphs on p18 (approximate count; each quote counted as one sentence). p6 has 103 words and p18 has 94, against a 70 maximum. The counter tolerance of +50% (textRefine.js:278, hi = 105) lets both through. Only p4 (109) was flagged.
- The sentence and paragraph rules have no counter, so "the sentence count wins" is a dead letter. Improve: count sentences and paragraphs in the same $0 counter, or drop the numbers from the prompt if they are not meant as a contract.

### 7. [LOW] Lector: 2 of its 4 applied changes made the text worse
- p14 «längst gegeben»→«längst beigetragen» changes the meaning and lifts the register above a 3-5 audience. p1 «am Stand auf der Bahnhofstrasse»→«an der» is not a fault. «liegt aus dem Wind»→«im Windschatten» is a real idiom fix, but a harder word than needed («geschützt vor dem Wind»). «zu dem, das»→«was» is fine.
- The lector has no reading level in its prompt (story-text-proofread.txt carries only LANGUAGE and PAGES), so it cannot prefer the child's word. Not a reversal of the medium-effort verdict (memory project_lector_config_verdicts.md). Precision here is 50% on n=4.

### 8. [LOW] Swiss conventions and wording
- Typography is clean: grep found no ß, no em/en dash, and no spaced «» or space before !?:; in the final text.
- «Tüte» appears 6 times. Swiss Standard German normally says «Sack/Säckli/Papiersack» (Marroni come in a «Säckli»). The de-at instruction lists «Sackerl» (not «Tüte») (languages.js:41), and the de-ch list has no such entry. Judgement, not measured.
- Words heavy for 3-5 read-aloud: «Ofenkachel» (from the arc), «Flanke», «Windschatten», «beigetragen», «gewölbt wie ein Schild», «nutzlos».
- p6 «mit rostroter Haut» vs p10 «Schuppen» (the picture shows scales). Minor.
- The writer's «Knieet hin» typo was correctly fixed by the refine («Kniet»).

---

## B. PER-PROMPT REVIEW

### 01 beats_story_text (writer, sonnet-4-6), 39.6k chars
- **Wrong**: the LANGUAGE block states the Swiss rules three times (instruction, note and "Write in Swiss Standard German …", lines 5-9), under a "CRITICAL RULES" banner that feedback_prompt_writing.md rejects. The HINTS heading "apply these … where the beats have not" (promptBuilders.js:9741) asks the writer to know which hints the planner applied, which it cannot. Hint 2 was silently dropped.
- **Missing**: no age or listener line beyond "1st-grade early readers", although the cast and audience are 3-5 (see the 2026-09 age-band work). No rule that a character acting against their own stated refusal needs a stated reason. Actually it is there, line 196, and was not followed, so this is a compliance miss rather than a missing rule.
- **Bloat**: LOCKED ILLUSTRATIONS is 21.7k chars (55% of the prompt). Appearance and clothing still recur on p4, p9, p11, p12, p16 and p18 (the dedupe at promptBuilders.js:9703-9727 only drops a look that has not changed), while the prompt forbids narrating clothing. Cutting clothing and appearance and camera clauses would save about 8-10k. Most CHARACTER DETAILS strengths lists (15-25 adjectives each, about 1.5k) are instructed away ("never work through the list"). DO-NOT-WRITE is 1.9k and fine.
- **Data vs instructions**: data is about 29k (arc 4.9k, hints 1k, briefs 21.7k, characters 2k). Instructions are about 10k.
- **Improve**: strip appearance from briefs at the text stage (keep events, props and who is present). Give "what the listener must be able to follow" as the audience age, not only a school grade.

### 03 text_audit arc-informed (gemini-3.1-pro), prompt not stored, rebuilt from prompts/story-text-audit.txt + promptBuilders.js:9186
- Sent: preamble, STORY_ARC (unamended, no hints), PLAN_LINES, and per page TEXT plus THE PICTURE SHOWS (full brief via `resolveTextStagePictureSpec`), with 12 questions. PULL is live (not a simple band). No back cover, no cast list, no reading level.
- **Wrong**: LOADBEARING (:24) is over-broad ("a fact of the story that no page carries at all") and produced the ages and p15 misfires. No hints are given, so it faults hint-applied text.
- **Missing**: hints (item 2). It missed LIMIT, CAUSE and ASSUMED (item 3) despite having the exact questions, and 12 questions × 18 pages in one pass is a recall problem (decisions.md ~40420 already notes 4-9 faults across three identical runs).
- **Bloat**: full briefs with clothing (the same about 19k as the refine outlines).
- **Improve**: scope LOADBEARING to "cause, uniqueness, limitation, or a spoken line the plot turns on", and state that a descriptive attribute (age, colour) is never load-bearing. Feed the hint-amended arc.

### 03 text_audit_blind (grok-4.6): see item 4

### 05 text_refine (claude-opus-5), 53.7k chars
- **Wrong**: items 5 and 1. The refine did good work on p3→p4 (MISMATCH move), p8 (hunger), p11 and p16. It did bad work on p1 (age info-dump), p14 (self-contradiction) and p15 (it obeyed a hint-blind finding). It also dropped Turi's motive clause on p11 («um seinen Bruder festzuhalten»), leaving the snatch unmotivated.
- **Missing**: hints; the word counts per page (it is told "p4 has 109 words" but not the others); the audience age.
- **Bloat**: SCENE OUTLINES is 19.4k, the full brief with clothing, and unlike the writer it gets no appearance dedupe (the writer and refine picture specs differ, which is sibling drift). CHECKS A-E (4.7k) force a full analysis of all 18 pages (about 8k chars of output here) while rewrites are confined to audit-named pages. Most of that analysis cannot act. Suggest limiting the checks to the rewritable pages.
- **Improve**: "a finding contradicted by the picture or by the hints is closed with a stated reason, not obeyed". The prompt only says the outline and picture are read-only.

### 07 text_diff (gpt-5.6-luna-pro): see item 1
- **Bloat**: none (9.3k, mostly the BEFORE/AFTER data).
- **Missing**: the findings per page, the picture/plan line, and "do not restore text removed to close a finding".
- **Wrong in practice**: it flagged "merely different" changes, which violates its own prompt.

### 09 text_lector (gemini-3.1-pro): see item 7. Lean (9.3k, mostly pages). Missing: the reading level.

### Title (writer self-pick): «Das Ei im Laub» is true of the pages, spoils nothing and is sayable by a child. It's fine.

---

## C. DOC GAPS / STALE DOCS
- prompt-inventory.md:44 says the arc-informed audit gets a "back cover … DEPICTS-only picture info". The code (promptBuilders.js:9196-9206) sends no back cover and the full brief. The same stale "back cover" appears in the textRefine.js:16 header and the decisions.md ~32418 chain entry, and the misplaced docblock at promptBuilders.js:9107-9111 describes a blind audit with back cover and DEPICTS above the lector builder.
- prompt-inventory.md:55 says the writer output order is TITLE, ANALYSIS, STORY TEXT. The actual order is ANALYSIS, STORY TEXT, TITLE, and it gets `{ARC_HINTS}` plus full ILLUSTRATION briefs, which the entry does not mention.
- The chain entry names the refine model deepseek-v4-pro. The run used claude-opus-5. Check that a superseding entry exists.
- decisions.md:36826 and memory project_lector_config_verdicts.md ("diff does not invent") are contradicted by this run (item 1).
- No decisions entry records why hints are withheld from the audit and refine. It looks accidental: the registry set `arc-hint-handoff` omits them.
- Registry: story-text-diff.txt is in no generator-vs-critic set with text-refine.txt (only `lector-and-diff-pass`), and story-text-audit-blind.txt is not a critic of the writer in `story-text-generator-vs-critic`.
- SETTLED.md has no text-chain line. Nothing proposed here reverses a SETTLED entry. Item 1's proposal touches the "no length guard" decision but does not reverse it: it adds context to the diff rather than a length rule.

## D. INCIDENTAL (outside this stage, seen while reading)
- promptBuilders.js:5352-5355 (outline reviewer): `const doNotWriteList = …; if (!doNotWriteList) doNotWriteList = …` assigns to a const. It throws a TypeError exactly on the missing-template path it tries to handle. It only fires when that template fails to load.

## E. JUDGEMENT WITHOUT RUN EVIDENCE
- The blind-exemption wording as the cause of the 0 verdict (item 4).
- «Tüte» vs «Säckli» as the Swiss norm (item 8).
- Whether 12-question single-pass audits lose recall with page count (item 3, supported only by the 4/5/9 spread already in decisions.md).
