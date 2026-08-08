/**
 * Canonical client-side reader for an image version's score.
 *
 * THERE IS ONE SCORE. `finalScore = 100 − Σ penalties`, written server-side by
 * applyScore (server/lib/scoring.js). It has no floor: negative means the
 * evaluators charged more than 100 points of penalty, and −10 vs −140 is a
 * real difference the UI must show.
 *
 * This file used to carry three functions and a clamp because the server kept
 * a clamped `finalScore` alongside an un-clamped `rawScore`. Both server
 * fields are gone (2026-08-08) — do not reintroduce a second scale here.
 *
 * The legacy fallbacks below are for versions written before applyScore
 * existed; they are read-only history, not a second model.
 */
export interface ScoredVersionLike {
  finalScore?: number | null;
  evalScore?: number | null;
  qualityScore?: number | null;
  entityPenalty?: number | null;
}

export function versionScore(v: ScoredVersionLike | null | undefined): number | null {
  if (!v || typeof v !== 'object') return null;
  if (typeof v.finalScore === 'number') return v.finalScore;
  // Legacy versions only: reconstruct from the pre-applyScore field names.
  const penalty = typeof v.entityPenalty === 'number' ? v.entityPenalty : 0;
  if (typeof v.evalScore === 'number') return v.evalScore - penalty;
  if (typeof v.qualityScore === 'number') return v.qualityScore - penalty;
  return null;
}
