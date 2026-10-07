# Showcase fixes — mermaid job_1791315635053_t0t8qpebu (2026-10-07)

Source: full review of the staging showcase (arc/beats/text + images p1-7, p8-14, covers) and the
eval/repair/speed proposals. Owner goal: fix all issues; prompts checked in-console with
agent-as-model (`.claude/skills/running-prompts-on-agents`), Lab only where that can't work.
Code-editing agents run one at a time in the main checkout (no worktrees). Cost target: < CHF 5/story.

## Done
- [x] Page plan: focal cast-out direction bug, arc-fact fixes unblocked on protected pages, lead pages
      counted by who leads, idea-card figures not commissioned → 4be3f986c (staging)

## Queue (in order)
- [x] (8d1660de3) Light/season/plates: season block gated; submerged places → skyless light (owner ✅);
      indoor flag vs indoorP bug; p4 beach-under-water plate; p6 interior plate; plate QC no silent ship
- [x] (1b67fb4a1) Avatar sheets: Sarah two-person sheet, photoreal sheets, Daniel's baked-in blanket + labels,
      Noah hair vs description, Emma standing on fin / mixed ponytail; gates incl. hair-style check (owner ✅ A6)
- [ ] Eval/repair (owner ✅): A1 creatures to top level (bug); A2 paired re-judge; A3 no left/right in briefs;
      A4 clipped figures not judged; A5b+B6 main action must happen; B2 text findings don't pick the winner;
      B3 paste-back + no-op gate [x built 2026-10-07, awaiting a real-story verify]; B5 critical-gone needs no new MAJOR; B1 store executed repair plan
- [x] (2026-10-07, see decisions.md) Art Director: letter dropped from p9/p10 briefs; cover prose "sky fills upper third";
      mermaid tails on dry dedication hillside; brief hat vs avatar cap; contradictory scale words
- [x] (2026-10-08, decisions.md) Text/arc leftovers; p9 climax weakening NOT fixed, see BACKLOG: shout-rule leak, refine adds explaining lines (p5, p8), p9 refine weakens climax,
      "Wir sollen bei Berta bleiben" rule nobody set, world rule packs 3 facts behind a colon,
      5 of 8 figures carry a fact, Sarah has no scene, Noah's thread unresolved
- [x] (2026-10-08, decisions.md) Speed/cost: planner/re-plan/bible effort medium (low measured worse), 10-05 entry corrected; trial writer already medium
- [x] (2026-10-08) Small: progress counter counts covers (D1); review-page.js reads R2 image_url (D2); stale verify.json hashes (D3b)
- [ ] Cost ledger, cost-cuts group C (owner ✅) → tasks/cost-cuts-2026-10-05.md
- [ ] Measure renders per story after the repair fixes (target ~25, was 45)

- [x] Repair mechanics built 2026-10-07 (routing to iterate, billing, kept frames, anchor gate, paste-back, no-op, prompt composition; see decisions.md); rounds still NOT cut. Original item: deep investigation running (char-fix failures 22/24 on prod, per-method review of last
      10-20 attempts, noise-free repair test method, internet research); owner ✅ route re-staging
      (extra/missing character, setting) to iterate, bill rejected char-fix calls, no-op gate checks the
      target, research a new "wrong action" method. Rounds NOT cut until the strategy is optimised.
- [x] (2026-10-08, decisions.md) Trial (prod ninja story job_1791139823152_z51kjiu3f): idea commission rule "the hard thing this
      story was asked for" points at nothing for adventure → stock antagonist (dragon); companion axis
      adds an unneeded child vs "keep the cast minimal"; trial writer had no dash ban (645cf7fc3 on
      staging, unverified); fox came from prompt_compress (deleted, now on prod)

## Open owner decisions
- Re-plan "balance" rule strict vs a rewritten line counting as its declaration
- Lead page on a group page vs the 3-page floor
- [ ] Re-plan round 2 still not bought on the 3 stored measurements after the untouched-page change (remaining minted findings are on changed pages or name no page); real-story verify → verify.json replan-untouched-flips-2026-10-08
