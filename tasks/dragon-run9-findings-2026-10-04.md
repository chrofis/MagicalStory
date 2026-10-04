# Dragon run 9 — open findings (2026-10-04)

Staging `job_1791040103540_atbttop6w` (build a7fbbb7b, Jev 1.13, arc on Opus 5.5 xhigh).
Scores (hand): arc 8, page plan 8.5, text 8, pictures 6. Fixed since run 8: Levin identity,
clothing swap, stray lettering, low-angle shots, missing covers.

Fixed on staging after this run (2026-10-04): title proofread (4fc70bb54), size never cut by the
prompt shrink (09bf2d495, bed083b6b), back-view worn-item line + `garment_facing` finding (ed5c57184),
sheet garment colours kept in the watercolour pass (50b5b856c), sheet no-lettering rule (21b9671ec).
All need the next full dragon run to confirm (verify entries title-proofread, prompt-shrink-keeps-size,
worn-item-facing, avatar-sheet-garment-colour, avatar-sheet-no-lettering).

## Open

- [ ] **Grown creature still drawn young / small.** ANI001 reference reads juvenile (big head) even
      with "a fully grown adult dragon" in the VB entry; its first cell failed the gate as "baby
      dragon". Pages: child-size p5/p6, horse-size p16, egg/dog-size p17/p18. Re-check after the
      size-never-cut fix; if still small, the reference image is the lever.
- [ ] **Object continuity across pages.** p12: Kiaan wears the jacket again and holds the bare egg
      right after wrapping it on p11 (the wrap state is not carried to the next page).
- [ ] **Location jumps.** p10 and p14 render in other parks, not the declared Lindenhof location
      (run 8 had the same on p12).
- [ ] **Small prop oversized.** The football-sized egg renders 1.5-2× a child's head on p3, p9,
      p17, p18 (people-yardstick + contact rule shipped 9020a56bb; Lab #1512 helped 1 of 2 egg pages).
- [ ] **Pass-2 sheet judge misses printed labels.** The style judge passed a labelled sheet twice;
      the body-row judge and the restyle prompt are the guards that work (21b9671ec).
- [ ] **Over-cap prompts now spend other rules.** With size protected, the longest pages cut
      HEIGHT ORDER and the single-illustration / no-lettering rule. Real fix: shorter fixed blocks
      (550-900 chars), needs a Lab render first.
- [ ] **Stored stories have no garment `back` field.** A repair on an old story names the garment
      only and logs an error (ed5c57184).
- [ ] **promptComplianceJudge is off on staging** — 28 `check_not_evaluated` on run 9. Confirm
      whether intended.
- [ ] **Smaller render misses:** p7 Levin shouts (Max's action); p6 wings spread instead of over the
      ears; p9 stairs rise instead of drop, ultra-wide not rendered; p12 Herr Keller's face
      deformed; p15 leaf blower fused to a wheel; p18 Rubina's climb-down and nose-stroke missing.
- [ ] **Page plan:** round-2 replan discarded (cast/focal must-fix 4→5); 6× Jev's location not copied
      into the brief (code restored it), 2 pages with two locations.
