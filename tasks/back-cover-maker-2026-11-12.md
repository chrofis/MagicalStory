# Back-cover maker for printed books (2026-11-12)

Bug: `book-blank-cover-without-back-cover` (tasks/bugs.json). A one-story book whose story has no back cover prints a
white cover spread (pdf.js generatePrintPdf ~318); an unreadable cover only warns. 32 production stories (28 trial-sized,
4 full, all watercolor, one character, newest 2026-08-16). Plan research: Plan agent 2026-11-12 (summary below).

## Owner decisions (2026-11-12, question tool)
- Build the maker now (printed books make the missing back cover; we pay, no credits).
- Outfit text: read it from the character picture with one cheap vision call and store it in the story's wardrobe.
- Weak result: a second attempt, then use the better of the two (a low score never blocks the order).
- PDF downloads / admin PDF: open WITHOUT a back cover (front cover still drawn). "Books have a back cover. PDFs do not."
- Stories without stored avatars: use today's character; a deleted character fails loudly on the order page.

## Steps
- [x] pdf.js: generatePrintPdf draws the front cover even without a back cover (PDF downloads); an unreadable cover
      buffer THROWS (single + combined, incl. story-2+ back cover). A print build that still lacks a back cover throws.
- [x] Outfit: vision call fills the missing standard outfit description from the avatar/photo, stored in the wardrobe.
- [x] Maker `server/lib/backCoverMaker.js` `makeMissingBackCover(storyId, storyData)`: buildCoverBeats (backCover) →
      one shared per-page Art Director brief (export from beatsPipeline, no copy) → shared page render (split from
      iteratePageCore, no third renderer) → stamp (throw if stamp fails) → save like regeneration.js (version,
      backCover + backCoverArt, briefedAsPage, active version, repair cost) → in-flight lock per story. Weak score: one
      more attempt, keep the better.
- [x] gelato.buildBookPrintPdf: before attachSquareCovers, make it for a single story without a back cover, or for
      story 1 when no story has one. print.js generate-book-pdf calls buildBookPrintPdf instead of its copy.
- [x] Order page + voucher page: POST /api/stories/:id/ensure-back-cover; BookBackCover gating like BookSquareCovers.
- [x] Tests (fail before fix) + decisions.md entry (print pays for the cover; page-path brief for pre-brief covers).
- [ ] Paid test: 4 production stories copied to staging (trial job_1780438044462_oolwasq34, job_1786888522777_8l1dv50lk;
      full job_1773093284773_isudrmgrj, job_1773170696610_cdwuw7kui), cap USD 1.20. Negative: staging
      job_1787693271900_cyc9lol5y (no front cover) must fail loudly.

## Cost
About USD 0.15-0.30 per made cover (brief gemini-3.1-pro, plate + render Grok, eval gemini-2.5-flash), +0.02 square.

## Build review (2026-11-12, agent)
Built and unit-tested with stand-ins (USD 0). Free replay over the 32 production stories: 13 build a brief prompt, 19 stop loudly (13 no avatar and no character of today, 6 only a costumed avatar). The paid staging run stays open (needs the owner's cap).
