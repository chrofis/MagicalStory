# Learning topic "rhyming" = the book is told in rhyme (owner, 2026-11-07)

Owner: "we must say that the story is in rhymes, not about rhyming". The topic stays under Learning.
The owner read a hand-written verse sample of Laternen and said "The verse is good we can keep this".
Sample: the session scratchpad `rubi/verse.json`.

Today `[rhyming]` in `prompts/educational-guides.txt` says "teach rhyming words … create simple rhyming
pairs". The Laternen book turned that into a unicorn that answers in single rhyme words (plot gimmick,
meaningless rhymes, a rule the climax broke). See `tasks/janna-books-issues-2026-11-07.md` A6/D.

## Decisions (AskUserQuestion 2026-11-07)
- Label: **"In Reimen erzählt"** / EN "Told in Rhyme" / FR "Raconté en rimes" / IT "Raccontato in rima"
  (`client/src/constants/storyTypes.ts:306`, `server/lib/seoMeta.js:136`). Same id `rhyming`, so stored
  stories still resolve.
- Build approved, with a paid text-stage test of about USD 1.50 (about 5 stored stories × USD 0.30).

## Plan
- [ ] Starts after the plot-fix agent (F1–F3) has committed, because both edit the writer prompt.
- [ ] Guide `[rhyming]`: the whole book is told in rhyming couplets at the child's reading level. The
      plot is an ordinary plot; rhyme is the form, never a plot device or a rhyming creature. The
      guide stays language-neutral (decisions.md 2026-09 "A guide names no natural language").
- [ ] Writer (unified + trial siblings, if trials can carry a learning topic): verse output for the
      topic, with line breaks kept.
- [ ] Text passes (lector / refine / diff / audit): keep the rhyme and the line breaks for this topic,
      and check that the lines rhyme and make sense (generator↔critic: one shared constant).
- [ ] Idea stage: the rhyming topic must not turn into a rhyme gimmick in the premise.
- [ ] Label in client + SEO meta.
- [ ] Unit tests; then the paid test: `story_text_replay` (or equivalent) on about 5 stored stories,
      shown to the owner in verse.
- [ ] decisions.md, verify.json, prompt-inventory, sibling registry.
