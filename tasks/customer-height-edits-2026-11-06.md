# Customer height edits (Janna family, prod) — 2026-11-06

Owner report: the customer of `job_1793893086454_ao77wh9j5` (Einhorn), `job_1793959308869_fre2mb4d0`
(Rubi) and `job_1793964466256_1tmyzh1do` (Laternen) used the page edit box ten times to fix the
girls' height order; almost every edit failed. Her order: Polina shortest, Melodi a little taller,
Janna, Melisa tallest.

## Done
- [x] Customer edit text names each character by descriptor (age, hair, garment, position), case-insensitive;
      garment ahead of an accessory (efa45e018, 6f20f5d32; decisions.md 2026-11-06). Free replay: her 9 sentences
      all resolve to the right girl; prod stored edits 11/12.
- [x] Staging copies of the three books: heights Polina 106 / Melodi 111 / Janna 115 / Melisa 121 and apparent
      age Polina+Melodi kindergartner, Janna+Melisa young-school-age, on the stories' character snapshots only
      (her profile untouched, owner choice).
- [x] Back-cover "THIS IMAGE DEPICTS" header dropped (5561b70cc).

## Open
- [ ] **Photo-derived apparent age overrides the family's real order.** Polina (5) was rated `young-school-age`
      from her photo, Melodi (5) `kindergartner`; every page prompt and Art Director brief then draws Polina as
      the older, taller child, and a HEIGHT ORDER line alone does not overcome it (staging Einhorn p9 redraw,
      v4 vs v5). The customer can set height and apparent age on the character form, but nothing tells her these
      fields drive the picture. Owner decision pending: surface it / ask for relative heights / apply to her profile.
- [ ] **Edit resizes overshoot.** With the right girl now identified, "polina ist kleiner als melodi" on
      Einhorn p9 v1 still made Polina ~25% shorter (toddler next to Melodi), quality score 20
      (staging `..._edittest`, E2). The edit call carries no target size. Results of all 9 replays:
      `scratchpad` edittest → summarised below once run.
- [ ] **Quoted speech in the scene-intent line is drawn as a caption.** Staging Rubi p6 rewrite: the
      THIS IMAGE DEPICTS line quoted «Alle still!» and the render shows a caption strip "Alle still!".
      Same class as the back-cover caption (5561b70cc) on story pages; not measured beyond this one page.

## Results
(filled in after the staging runs)
