# Gull story rerun — open findings (2026-10-17)

Staging rerun `job_1792226018737_lb65hzkqs` of prod `job_1792078014622_uh8tj6ht1`
(build 30f9305f6). All pictures and the full text were read by hand.

## Briefs (Art Director) drop what the page text needs
The image model drew what the brief said; the brief was wrong. Owner asked for these six
pages to be redone by hand with corrected scenes (regenerate route, `editedScene`).
- [ ] p1: brief has Eliah only; text has Yara and the crew sitting up. Ship drawn toy-sized.
- [ ] p4: brief has Yara only (over-the-shoulder); text has Eliah coming off the ship to take her hand.
- [ ] p5: brief has no Lotti, no rowing pirates, "clear" weather; text has Lotti on deck and fog rising.
- [ ] p17: brief has `characters: []` and no creature; text has Lotti screaming on deck. The page was never scored (finalScore null).
- [ ] Measure the rate over stored stories (brief cast vs page-text cast) before deciding a fix.

## Ship drawn twice when the scene is aboard it
- [ ] p14 and p18: metadata has `aboard: VEH001` AND `VEH001` in `objects`; the picture shows a
  second full ship in the background. Count over stored stories how often an aboard page lists its
  own vehicle as an object and how often a second ship appears.

## Gangplank drawn as a short board on a rail stump (p6, p15, p16 — owner's worst pages)
- [x] 2026-10-17: rule fixed (OBJECT_NOT_PLACED_RULE, 8e9115566, placement 14.8% -> 3.6% on 10 replayed stories); this story's ART002 cell redrawn via Test Lab #1767 and set as its reference; p6, p15, p16, p17 redone by hand and good. ART002 description bakes a scene state into the object ("its inner end resting on the ship's rail
  and its outer end reaching out toward the water"). The reference cell drew a short board lying on a
  curved rail fragment (gate first rejected it as "a bench", the re-render was accepted). The pages copy
  that object: p6 a board tilted on the rail ending in mid-air, p16 a ramp up onto a rail stump, p15 no
  plank over the water at all. Same class as the hurt-wing marker: an object's position/state on a page
  belongs in the page brief, never in the look-book description. Count over stored VB entries.
- [ ] p15 text is self-contradictory ("ging bis ans Ende der Planke, das noch beim Schiff lag") and the
  brief copies it (stands at the inner end + leans out over the water).
- [ ] p16 brief drops Fridolin and the rope although the text has Fridolin untying it.
- [ ] p15 carried a reader MAJOR (setting) at score 83 and was not repaired — check why the admission did not fire.
- [ ] Eval passed p6 and p16 at 100: it checks picture vs brief, so a brief that is wrong passes.

## Other
- [ ] p18 drew a fantasy castle instead of the LOC003 Schloss Unterseen house.
- [ ] p19 scored 20 for a placement nit on a fine picture (eval severity).
- [ ] Ending: the ship turns back to leaves at the Unterseen quay at night; the children never get home.

## Redo route bugs found on the way (fixed)
- [x] Portrait output for square books, prefill junk in stored briefs (8eff73710); edit-scene redo crash on the clothing table (ec05d6f23).
