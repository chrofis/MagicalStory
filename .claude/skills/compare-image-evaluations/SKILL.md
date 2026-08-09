---
name: compare-image-evaluations
description: Analyze image quality evaluations from a story - reads directly from database for accurate per-page results
---

# Compare Image Evaluations

Analyzes the evaluation methods used during story generation to understand image quality issues. **Reads directly from the database** (not logs) for accurate per-page results.

## When to Use

- After story generation completes with quality issues
- When debugging why characters look wrong or inconsistent
- When the user asks to "analyze evaluations" or "check image quality"

## How to run it

Per page (preferred — prompts, evals, retry history, versions in one dump):

```bash
node scripts/analysis/review-page.js <storyId> <pageNum>
```

Whole story: query the DB directly (connection strings in `.env` — `DATABASE_URL` / `STAGING_DATABASE_URL`; see db-direct-access memory):

```javascript
// node -e or scratch script: per-page score/verdict/issues table
const r = await pool.query(`SELECT data->'sceneImages' AS imgs FROM stories WHERE id=$1`, [storyId]);
for (const img of r.rows[0].imgs) {
  const q = img.qualityReasoning || {};
  console.log(img.pageNumber, q.score, q.verdict, q.issues_summary);
}
```

## The evaluation data shapes

| Method | What it checks | Stored in |
|--------|----------------|-----------|
| **Quality eval** | Single image against prompt + references | `sceneImages[].qualityReasoning` |
| **Incremental consistency** | Current page vs previous pages | `sceneImages[].retryHistory` (`type: "consistency"`) |
| **Final consistency** | All pages in batches | Not stored — triggers regeneration; `grep "CONSISTENCY REGEN"` in logs |

`qualityReasoning` shape: `figures[]` (detected figures), `matches[]` (`figure`, `reference`, `confidence`, `face_bbox [ymin,xmin,ymax,xmax] normalized`, `hair_ok`, `clothing_ok`, `issues[]`), `score` (0-10), `verdict` (PASS / SOFT_FAIL / HARD_FAIL), `issues_summary`, `fixable_issues[]`.

`retryHistory` consistency entries: `consistencyScore` (0-10), `consistencyIssues[]` (`[MAJOR] clothing: ...`).

## Why database > logs

Parallel generation interleaves log lines, so log parsing associates issues with the wrong pages. Use the DB for evaluation analysis; use logs (`node scripts/analyze-story-log.js`) only for timing and costs.

## Reading the results

Focus on pages with score < 80%. Common finding classes, by severity: character swap / missing character / clothing mismatch (CRITICAL), wrong colors / pose mismatch (MODERATE), object issues (MINOR). Remember the user counts versions 1-indexed (V1 = DB v0), and pose mirrors deliberately don't deduct (see memories).
