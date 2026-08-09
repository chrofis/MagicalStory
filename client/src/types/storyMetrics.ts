/**
 * One row of the story_metrics table (migrations/014_story_metrics.sql),
 * as returned by GET /api/admin/story-metrics.
 *
 * NOTE: node-pg serializes NUMERIC columns as strings; INTEGER as numbers;
 * JSONB as objects; TIMESTAMP as ISO strings. Numeric-ish fields are typed
 * `number | string | null` — coerce with Number() before doing math.
 * Backfilled rows have NULL counters / churn / judge scores (expected).
 */

export type NumericField = number | string | null;

export interface StoryMetricsRow {
  story_id: string;
  created_at: string | null;
  collected_at: string | null;
  environment: string | null;
  pipeline_mode: string | null;
  art_style: string | null;
  language: string | null;
  pages: number | null;

  // A: extracted scores
  duration_s: number | null;
  cost_usd: NumericField;
  mean_page_score: NumericField;
  min_page_score: NumericField;
  pages_below_80: number | null;
  findings_by_category: Record<string, number> | null;
  repair_rate: NumericField;
  versions_per_page_mean: NumericField;
  consistency_mean: NumericField;
  outline_fix_count: number | null;
  outline_fixes_by_category: Record<string, number> | null;
  cover_scores: Record<string, unknown> | null;
  avatar_fallback_count: number | null;

  // B: change magnitude
  text_churn_pct: NumericField;
  scene_churn_pct: NumericField;
  beats_churn_pct: NumericField;
  repair_delta_mean: NumericField;
  repair_pixel_change_pct: NumericField;

  // C: runtime counters (NULL on backfilled rows)
  counters: Record<string, number> | null;

  // D: judge scores (NULL until judges ship)
  title_score: NumericField;
  text_score: NumericField;

  detail: Record<string, unknown> | null;
}
