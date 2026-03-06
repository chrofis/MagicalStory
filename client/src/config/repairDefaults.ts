// Must match server/config/models.js REPAIR_DEFAULTS
export const REPAIR_DEFAULTS = {
  scoreThreshold: 60,       // Pages scoring below this need redo (0-100)
  issueThreshold: 5,        // Pages with this many fixable issues need redo
  maxPasses: 3,             // Global passes over all pages
  maxCharRepairPages: 3,    // Max pages to character-repair per run
} as const;
