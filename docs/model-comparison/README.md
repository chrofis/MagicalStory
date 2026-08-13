# Model comparison — story-quality scorecard

A judgment-based scorecard for comparing the **models** that generate a story's
four text artifacts. Unlike `scripts/analysis/writer-model-scorecard.js` (a
mechanical regex counter over scene briefs), this scores the **final outputs**
on quality dimensions, reviewed by a human/agent reviewer — not by an in-pipeline
eval model. One record per story; records accumulate in `scores.jsonl` so runs
from different models are directly comparable.

## The four artifacts and their dimensions

Each dimension is scored **1–10**. An artifact's score is the mean of its
dimensions; the story's `overall` is the mean of the four artifact scores.

### 1. `beats` — the narrative skeleton (per-page BEAT lines, post-review)
- `arc` — clear beginning → rising action → climax → resolution across the book
- `pacing` — age-appropriate; one clear idea per page; no rushing or dragging
- `emotion` — emotional beats land; character feeling drives the story
- `causality` — each beat follows causally from the last; no non-sequiturs
- `themeFit` — matches the requested topic/theme and its intended life-skill goal

### 2. `scene` — the illustration briefs (final scene descriptions)
- `clarity` — one unambiguous, renderable moment per page
- `variety` — cast & framing variance across pages (angle, distance, solo/group)
- `grounding` — characters correctly identified with trait/clothing anchors
- `setting` — world/setting detail rich and consistent (landmarks, props)
- `composition` — copy-space / calm-zone awareness, focal clarity

### 3. `storyText` — the child-facing prose (final, refined)
- `language` — grammar + Swiss orthography (ss never ß, «guillemets»), correctness
- `readability` — vocabulary and sentence length fit the target age
- `voice` — warmth, charm, engaging narration; not flat or generic
- `alignment` — the text matches what its page depicts (no drift from the scene)
- `dialogue` — natural, character-appropriate dialogue

### 4. `visualBible` — the entity / consistency spec
- `completeness` — all characters + key entities present with physical traits
- `wardrobe` — clothing/costumes specified per scene, concrete
- `world` — locations, recurring props, vehicles, artifacts defined
- `anchors` — descriptions concrete enough to keep renders consistent
- `consistency` — internally non-contradictory (no conflicting traits)

## Workflow

```bash
# 1. Fetch the four final artifacts + model provenance for review
node scripts/analysis/score-story.js <storyId>

# 2. (reviewer reads the dumped artifacts, decides dim scores 1-10)

# 3. Persist the scored record (provenance auto-filled; totals computed)
node scripts/analysis/score-story.js <storyId> --save '<scoresJSON>'

# 4. Compare everything scored so far
node scripts/analysis/score-story.js --report
```

`<scoresJSON>` shape (notes optional but encouraged):
```json
{
  "beats":       {"dims":{"arc":8,"pacing":7,"emotion":8,"causality":8,"themeFit":9},"notes":"…"},
  "scene":       {"dims":{"clarity":8,"variety":9,"grounding":6,"setting":6,"composition":7},"notes":"…"},
  "storyText":   {"dims":{"language":9,"readability":9,"voice":8,"alignment":8,"dialogue":8},"notes":"…"},
  "visualBible": {"dims":{"completeness":7,"wardrobe":6,"world":8,"anchors":6,"consistency":7},"notes":"…"}
}
```

Provenance captured per record: `outlineModelId` (writer) and the review models
(`beatsReviewReport.model` etc.), so a record answers "which model made this, and
how good was it." `reviewer` records who did the scoring.
