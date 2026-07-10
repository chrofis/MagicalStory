/**
 * Canonical client-side reader for an image version's effective score.
 *
 * Mirrors the server's computeFinalScore (server/lib/scoring.js) fallback
 * chain: canonical `finalScore` (written by applyScore — the single writer)
 * → legacy `evalScore − entityPenalty` → legacy `qualityScore − entityPenalty`.
 * Clamped to ≥ 0 for display.
 *
 * Use THIS everywhere a component needs "the score of a version" — the four
 * previous inline copies in ImageHistoryModal disagreed with each other
 * (three ignored the entity penalty, one subtracted it), so the version-card
 * badge and the detail-panel "Endwert" could show different numbers for the
 * same legacy version.
 */
export interface ScoredVersionLike {
  finalScore?: number | null;
  evalScore?: number | null;
  qualityScore?: number | null;
  entityPenalty?: number | null;
}

export function versionScore(v: ScoredVersionLike | null | undefined): number | null {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.finalScore === 'number') return Math.max(0, v.finalScore);
  const penalty = typeof v.entityPenalty === 'number' ? v.entityPenalty : 0;
  if (typeof v.evalScore === 'number') return Math.max(0, v.evalScore - penalty);
  if (typeof v.qualityScore === 'number') return Math.max(0, v.qualityScore - penalty);
  return null;
}
