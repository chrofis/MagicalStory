'use strict';

// The one decision "does this run start paid avatar styling while the writer is
// still going?". Styling is Grok/Gemini image work: a trial styles through its
// own path (runTrialEarlyStyling) and a text-only run (skipImages, the admin
// `rerun-text` harness) draws no picture at all, so neither starts it here.
// Kept as a function, not an inline `if`, so a test can prove a text-only run
// never reaches the paid call (docs/decisions.md 2026-11-07).

/**
 * @param {{trialMode: boolean, skipImages: boolean, run: () => Promise<void>}} p
 * @returns {Promise<void>|null} the running styling promise, or null when this run styles no avatar here
 */
function startEarlyAvatarStyling({ trialMode, skipImages, run }) {
  if (trialMode || skipImages) return null;
  return run();
}

module.exports = { startEarlyAvatarStyling };
