// Must match server/config/models.js REPAIR_DEFAULTS
// (server recalibrated scoreThreshold 80 → 60 when finalScore started
// subtracting three penalties; this copy lagged behind, so the manual
// workflow repaired pages the pipeline considered fine.)
// 2026-09-09: the server sat at 50 from 2026-08-09 to 2026-09-09 while this copy
// stayed at 60 — a whole month out of step. The server floor is back to 60, so the
// two agree again; keep them in step, and re-check this file whenever the server
// value moves. The per-round repair cap is a PIPELINE gate only (the manual
// workflow is operator-driven and paced by hand), so it is deliberately absent here.
export const REPAIR_DEFAULTS = {
  scoreThreshold: 60,       // Pages scoring below this need redo (0-100)
  issueThreshold: 5,        // Pages with this many fixable issues need redo
  maxPasses: 3,             // Global passes over all pages
  maxCharRepairPages: 20,   // Max pages to character-repair per run
  semanticThresholdForIterate: 30,  // Below this semantic score -> iterate (scene fundamentally wrong)
  qualityThresholdForIterate: 20,   // Below this quality score -> iterate immediately
  inpaintMaxPasses: 1,              // Inpaint attempts per page per round
} as const;
