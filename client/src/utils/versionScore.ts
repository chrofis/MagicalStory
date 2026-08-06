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
  /**
   * Un-clamped `100 − Σ deductions` from applyScore. NOTE: the name is
   * overloaded in this codebase — the re-eval endpoints
   * (`/routes/regeneration.js`) return a `rawScore` that is the evaluator's
   * 0–10 VISUAL score instead. Only ever pass image-VERSION objects to these
   * helpers, never an eval-result payload. (The helpers below only consult
   * `rawScore` when it is negative, which a 0–10 score never is, so a
   * mistaken call degrades to the clamped score rather than printing nonsense.)
   */
  rawScore?: number | null;
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

/**
 * Un-clamped score (`100 − Σ deductions`, can go below 0), written server-side
 * by applyScore. Only meaningful to surface when the clamped `versionScore` has
 * floored at 0 — it distinguishes several 0-scored versions (e.g. −30 vs −140)
 * and hints at eval over-penalization. Returns null for legacy versions that
 * predate the field.
 */
export function versionRawScore(v: ScoredVersionLike | null | undefined): number | null {
  if (!v || typeof v !== 'object') return null;
  return typeof v.rawScore === 'number' ? v.rawScore : null;
}

/**
 * Score to PRINT. Readers (and the picker) get the clamped `versionScore`;
 * developer/admin surfaces pass `allowNegative` and get the true un-clamped
 * value whenever deductions passed 100.
 *
 * Clamping is what makes a heavily-penalised page unreadable: a version with
 * seven nitpicks and one that is genuinely broken both print "0", so there is
 * no way to see which repairs helped or how far over the line the evaluator
 * went. −10 and −140 are different facts and admins need both.
 *
 * Falls back to the clamped score for legacy versions with no `rawScore`.
 */
export function versionDisplayScore(
  v: ScoredVersionLike | null | undefined,
  allowNegative = false,
): number | null {
  const clamped = versionScore(v);
  if (!allowNegative) return clamped;
  const raw = versionRawScore(v);
  return raw != null && raw < 0 ? raw : clamped;
}
