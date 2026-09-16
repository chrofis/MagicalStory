<!-- Design item awaiting owner triage. Ideas only — nothing here is decided and nothing is coded.
     Indexed from tasks/BACKLOG.md. Evidence: job_1789420511893_zly5rcdej, see tasks/staging-story-review-2026-09-15.md -->

# Scale: one VB element for a ship or a walnut — ideas (owner asked for ideas only, 2026-09-15)

## Evidence from job_1789420511893_zly5rcdej (staging)
- ART004 "roasted chestnut" has `size: "the size of a thumb"` in the VB. The p8 brief never places a chestnut in the
  foreground (its only chestnut sentences are the cart's pan far behind the crowd). ART004 was attached as one of three
  reference cells for p8. The render put a football-sized chestnut as the nearest object to camera.
  → A correct free-text size did not help. A thumb-sized prop given its own reference cell became a hero object: a cited
  reference has to appear, and the model made it prominent.
- VEH001 "wooden sailing ship" has `type: undefined, size: undefined` — the vehicle schema has no size slot. p12 cited
  VEH001 as a reference cell; the ship rendered as a small open rowboat although the empty-scene plate mentioned the ship.
  → Mirror failure: a huge thing with a cell got too small. A reference cell has one size — the cell — and nothing in the
  cell says whether it depicts a thumb or a three-master.
- Already tried/settled (memory): `size` free-text on artifacts authored everywhere (e476ca314); AD must name a size ratio
  (b62396e4a, reach only, effect unmeasured); "foreground is placement, not size" (2adea0dd9); a scale referent INSIDE the
  VB cell was REJECTED — anything sharing the cell leaks onto the page (feedback_no_scale_referent_in_vb_cell).

## Ideas, in order of expected trust
1. **Scale class enum, not a size sentence.** `hand | arm | person | vehicle | building | landscape` on EVERY VB element
   (artifacts, vehicles, locations, animals). Mechanical; drives prompt wording, cell framing and eval from one field.
   Fixes the ship's missing size by construction.
2. **Hand-class props never get their own reference cell.** Describe in prose only, or fold into the holder's cell. A
   chestnut needs no cross-page identity the way a face does. Cheapest fix; directly addresses p8; saves a paid cell.
   (Adding a hand to the cell is the rejected leak path — removing the cell is the clean move.)
3. **A hand-class object must be anchored to a referent in the brief** — in a hand, on a named surface, beside a named
   object. Never free-floating, never nearest-to-camera. The foreground is where the model decides the subject.
4. **Structures go in the plate, never in a cell.** Vehicle-class and larger are world-scale; the empty-scene plate already
   sizes them via bollards/cobbles/quay height. p12 cited the ship as a cell and got a rowboat despite the plate — the cell won.
5. **Frame the cell by class** where a cell is still needed: hand-class at ~25% occupancy with wide margins, person-class
   filling, structures cropped so only a portion fits. Same cell, different framing. Weaker than 2 and 4; complementary.
6. **Measure scale mechanically after render.** Detector already returns figure boxes + expected-object boxes. Ratio
   object-height / nearest-figure-height vs the class band (hand < 0.15, vehicle > 1.5, …) → derive a `scale` finding in
   code, exactly as presence is derived from figure counts vs cast (derivePresenceFinding). A measurement feeding an
   existing type, not text pattern-matching — on the right side of the classification rule. Would have caught p8 and p12;
   gives the retry a concrete reason to carry.
7. **Boardable vehicles inherit scale from an occupant.** Any vehicle large enough to board is drawn with a cast member
   aboard/beside it where the story allows — free scale anchor.

Recommended start: #1 (everything hangs off it) and #2 (unambiguous evidence, removes a paid cell per small prop).
Not decided; not coded. Needs owner triage → then Lab stage design.

---



**Status:** not decided, not coded (owner asked for ideas only, 2026-09-15). Next step is owner

triage of the seven, then a Test Lab stage design for whichever are taken.

## Status update 2026-09-16 — idea #1 shipped, then repaired

Idea #1 shipped on 2026-09-15 as a granular 12-band enum (`SCALE_PHRASES`, `server/lib/visualBible.js`),
not the six-value list sketched above; the six values survive as `LEGACY_SCALE_CLASSES`.

It then produced its own defect. The ladder mixed two comparison modes under one body-part
vocabulary — `forearm`/`arm` compared the object's SIZE, `knee`/`hip`/`chest` compared its HEIGHT —
and collided on `head`. On `job_1789506283204_3kxqshifx` the writer classed a football-sized dragon
egg as `head` meaning head-sized; every page carrying it was told it was "as big as a standing
adult" (correct on p2/p4, oversized p13, enormous p14/p17).

Fixed 2026-09-16: the height rung is `adult`, the head-SIZED band is the new `melon`, every phrase
states its mode, `head` resolves to `adult` for stored bibles, and the authoring text is one
constant (`SCALE_CLASS_SPEC`) both authoring templates carry verbatim.
→ `docs/decisions.md` 2026-09-16 "The scale ladder states SIZE or HEIGHT, and says which".

Ideas #2-#7 remain undecided and uncoded. #6 (measure scale after render) is the critic-side half
that is still missing: nothing deducts for an element rendered off its declared band.
