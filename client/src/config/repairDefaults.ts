// Must match server/config/models.js REPAIR_DEFAULTS
// (server recalibrated scoreThreshold 80 → 60 when finalScore started
// subtracting three penalties; this copy lagged behind, so the manual
// workflow repaired pages the pipeline considered fine.)
export const REPAIR_DEFAULTS = {
  scoreThreshold: 60,       // Pages scoring below this need redo (0-100)
  issueThreshold: 5,        // Pages with this many fixable issues need redo
  maxPasses: 3,             // Global passes over all pages
  maxCharRepairPages: 20,   // Max pages to character-repair per run
  semanticThresholdForIterate: 30,  // Below this semantic score -> iterate (scene fundamentally wrong)
  qualityThresholdForIterate: 20,   // Below this quality score -> iterate immediately
  inpaintMaxPasses: 1,              // Inpaint attempts per page per round
} as const;
