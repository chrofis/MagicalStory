# Production story review — 2026-10-04

Six prod stories since 29 Sep, read + every page/cover image viewed (read-only agents).
Ratings (text / images / overall): Enaya 7/5/6, LUNA 6/4/5, Neva 6/5/5.5, Léon 6/5.5/6,
gracchio 6/6/6, Nuvola 6/5/5.

## Fixed in this session (staging)
- Trial page clothing exact-name lookup ("Luna" vs "LUNA" → standard avatar on every page) — 4d8cce94e
- Character names normalised at input (ALL CAPS / all lowercase) — 7724c883d
- Blank-page warning at checkout (≥4 blank pages) — 7a777c796, 2c9aeaccf
- Main role: explanation, live age line, one-main default, cap 1 (≤2 characters) / 2 (3+) — 272ec4777, 774b0a502, 0240812b9
- Cover title erased by repair: already fixed on staging in c9484709c (2026-09-23), NOT on master — prod order 99 printed without a title

## Open — not fixed
- [ ] Neva p3: the writer renamed the premise landmark «Reformierte Kirche Adliswil» to «Reformierte Kirche Rüschlikon» and placed it "am Rand von Adliswil" (prod job_1790680992018_nd95o89r7)
- [ ] gracchio: p1 pins a star on Lio too, so Noam giving Lio his star on p8 is hollow; title says "gracchio" (alpine chough), text and pictures say "taccola" (jackdaw); p2 cake has 3 candles for a 2nd birthday; p10 the hero Lio is missing (prod job_1790719546789_9n47zi342)
- [ ] LUNA p4–p6 wand continuity: put down on p4, "ramassa… tenue serrée contre elle pendant toute la traversée" on p5, "posa la Baguette… dans sa paume" on p6 (prod job_1790769860433_2bhhj0pyi)
- [ ] Nuvola p2 shows only Nuvola while the text counts 6 goats + Nuvola, and the semantic score was 10 (prod job_1790747154374_7f2t99tk6)
- [ ] Léon: the customer rewrote our generated idea into her own complete toddler text (short sentences, sound words); the writer treated it as a premise and wrote a different plot. Whether a user-written full story should be kept closer is an open product question (prod job_1790702181821_o8ynpdjw6)
- [ ] Insufficient credits: 5 create attempts on 2026-09-29 20:27–20:31 CH were refused with "Insufficient credits", logged client-side as "Generation failed" — what the user actually saw is unchecked
- [ ] Admin `POST /generate-book-pdf` still uses its own old page estimate instead of `computeBookPageInfo` → server/routes/print.js:1118
- [ ] Image↔text mismatches seen across stories (missing central objects, wrong scale, missing named characters) — individual instances in the six agent reports, no class fix proposed
