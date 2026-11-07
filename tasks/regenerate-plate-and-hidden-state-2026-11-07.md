# Regenerate on the stored plate + hidden-then-revealed VB state — 2026-11-07

Owner decisions (AskUserQuestion, 2026-11-07):
- **Plate:** "Each redraw request ends with 'background: keep' or 'background: redo — <what to change>'.
  Keep = redraw on the same stored plate. Redo = paint a new plate with that change, save it as the
  page's plate, then redraw on it. A customer's own regenerate always keeps the stored plate."
- **Hidden state:** "Any feature the story keeps hidden until a reveal page gets a first 'hidden'
  reference picture (with whatever hides it, forelock or stuck leaves) and a 'revealed' one from the
  reveal page on. Tested on stored stories first: the reference-planning step is replayed on >=20
  stored stories, most of them without anything hidden."

Evidence that started it: prod Rubi `job_1793959308869_fre2mb4d0` p6. The redraw through regenerate +
customPrompt had no plate (non-landmark page, `pageNeedsPlate` false) and came out in an orange palette.
The Lab `image` stage on the stored plate matched the book. Einhorn `job_1793893086454_ao77wh9j5`: the
VB has one unicorn cell with the horn, so every edit on the head brought the hidden horn back.
Log: tasks/customer-height-edits-2026-11-06.md.

## What the code does today (read 2026-11-07)
- `images.ensureStoryPagePlate` (images.js:4313, regenerate / test-models / style-lab) and
  `landmarkScene.resolveRepairScene` (repair re-render) return NO plate unless `pageNeedsPlate`, i.e.
  only for landmark pages that are not cast-0.
- `images.resolveIteratePlate` (images.js:4352, iterate incl. the book review's NEW route) reuses the
  stored plate only when the iterate rewriter (scene-iteration*.txt) answers `reuseEmptyScene: true`;
  `false` paints a fresh plate from its `emptyScenePrompt`; an omitted/null answer on a non-landmark
  page sends NO plate.
- regeneration.js:822: a `customPrompt` replaces the whole prompt (no style template).
- prompts/visual-bible.txt states rules: no hidden/revealed concept.

## Build 1: the plate
- [x] B1.1 One function decides the plate of a stored-page re-render: the stored plate whenever one
      exists (every page, not only landmark ones); none stored → render one, save it as the page's
      `empty_scene`, use it; render refused → throw (no plate-less render). Cast-0 landmark exemption stays.
      Replaces the `pageNeedsPlate` gate in `ensureStoryPagePlate` and `resolveRepairScene`.
- [x] B1.2 Book review: prompts/book-audit.txt (+ BOOK_REVIEW_RULES) asks every NEW fault line for a
      trailing `background: keep` or `background: redo — <change>`. `bookAudit.parseRoutes` reads it into
      `route.background = {keep:true} | {keep:false, change}`; a NEW line without it is unroutable
      (logged error, not guessed).
- [x] B1.3 bookReview `chooseMethod` → iterate carries it; code pins `reuseEmptyScene` from it (the
      iterate rewriter no longer decides on this path). redo → fresh plate from the stored plate prompt
      + the change, saved as the page's plate, then the redraw.
- [x] B1.4 Customer regenerate (regeneration.js) always keeps the stored plate.
      Customer iterate (free-text edit): the rewriter's `reuseEmptyScene: false` still repaints (the
      customer may ask for another place); an omitted answer now means KEEP, never "no plate".
- [x] B1.5 Siblings: repair-entrypoints set (repairPipeline / regeneration / entityConsistency), Lab
      `image`/`iterate` stages, covers (cover plates stay as they are, out of scope — say so in the
      decisions entry). `check-sibling-paths.js --list`, generator↔critic: book-audit is the generator of
      the background tag and the parser is its only reader.
- [~] B1.6 Tests: unit (parser: keep / redo / missing; plate resolver: stored / none-stored→render+save /
      refused→throw; iterate pin). Stored-data replay: parse the stored Opus review raws (`eval_calls`)
      of >=20 stories with the new parser (free; old raws have no tag → expect "unroutable" counts,
      proves the parser, not the prompt). Prompt check: one Lab `book_audit` on 3 stored books
      (≈ USD 0.45-0.75 each) — price asked before running.
- [~] B1.7 decisions.md entry, SETTLED check (no line reversed found: lines 46-49 are about light,
      people and landmark photos), verify.json entry, docs/image-generation-methods.html, BACKLOG tick
      ("regenerate draws a non-landmark page with no plate").


### Build 1 status (2026-11-07)
- Built and unit-tested; decisions.md 2026-11-07 "A re-render keeps the page's plate", verify.json `rerender-keeps-page-plate`, image-generation-methods.html updated.
- Stored pages with an `empty_scene` row (read-only count): prod 835 of 1757 (48%), staging 1592 of 1825 (87%).
- B1.6 open: the PAID Lab `book_audit` check on 3 stored books (does Opus write `background:` on every NEW line, and judge keep/redo sensibly) is NOT run; price to be asked. Parser replay ran free over 15 stories / 54 stored review rounds (only 15 stories hold book-review raws; the 20-story target could not be met without new runs); all 57 stored NEW lines read as unroutable, as expected.
- B1.7 open: BACKLOG line ("regenerate draws a non-landmark page with no plate") is NOT ticked until the paid prompt check is done.
- Known limits: in-run calm-zone / repair-regenerate callers (storyJobPipeline.js, repairPipeline.js) pass no renderer; a redo stores the new plate image but not its changed description.

## Build 2: hidden-then-revealed state
- [x] B2.1 (HIDDEN_FEATURE_STATE_RULE in promptBuilders, both templates) visual-bible.txt + story-trial-arc.txt (vb-authoring-sites set; one constant in
      promptBuilders like ONE_SIDED_FEATURE_RULE): a feature the story keeps hidden until a reveal page is
      a state — `hidden` (drawn with what hides it) for the pages before, `revealed` from the reveal page on.
- [x] B2.2 (stateCellsGatePrompt carries the constant; registry anchor added; the only critic on a state batch) Check the state-cell gate in referenceSheets.js accepts a "hidden" cell (generator↔critic).
- [ ] B2.3 PENDING (paid, needs price approval: ~USD 0.35 one arm, 20 stories; `node scripts/analysis/replay-vb-hidden-feature.js --cap 0.6`; script + dataset prepared, dry run and --estimate done) Replay the VB planning step on >=20 stored stories (mostly nothing hidden; include Einhorn):
      rate of correct hidden states, rate of false states. Price asked first (text-only call, est. a few
      cents per story).
- [x] B2.4 (decisions.md 2026-11-07, SETTLED extended, verify.json; BACKLOG tick of 'VB has no hidden state' left to the replay result) decisions.md, SETTLED line 36 (states) is extended not reversed, verify.json, BACKLOG tick
      ("VB has no hidden state").

## Not in scope
- `customPrompt` skipping the style template (BACKLOG line stays open).
- Pricing (owner raised 2026-11-07: generation margin is ~zero / negative on big packs).

## Review
(after implementation)
