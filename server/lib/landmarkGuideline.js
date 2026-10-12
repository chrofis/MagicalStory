'use strict';
// The landmark guideline in one place (owner rulings 2026-09-04 / 2026-09-05,
// docs/decisions.md "Landmark retry re-asks only the Visual Bible"). When the
// reader's location is the BINDING setting and real landmarks were offered, the
// story should stage at least two of them. A strong guideline, never a gate.

const LANDMARK_MINIMUM = 2;

/** Is the guideline in force for this story? */
function landmarkGuidelineActive(inputData) {
  return inputData?.premiseNamedWorld === false && (inputData?.availableLandmarks?.length || 0) > 0;
}

/** Real landmarks a Visual Bible stages on at least one page. */
function stagedRealLandmarks(vb) {
  return ((vb || {}).locations || []).filter(l => l.isRealLandmark && (l.appearsInPages || []).length > 0);
}

function describeStagedLandmarks(staged) {
  return staged.length ? staged.map(l => `"${l.landmarkQuery || l.name}"`).join(', ') : 'none';
}

/**
 * Feedback for the Visual Bible re-ask; rides into the REAL LANDMARKS section of
 * the bible prompt (buildAvailableLandmarksSection). Generic wording only.
 */
function landmarkRetryNote(staged) {
  return `A previous Visual Bible staged ${staged.length === 0 ? 'none' : `only ${staged.length} (${describeStagedLandmarks(staged)})`} of the listed landmarks. Stage at least ${LANDMARK_MINIMUM} of this list: wherever a plan line's place is, or stands beside, a listed landmark, mark that location as the landmark and give it the pages of those plan lines.`;
}

module.exports = { LANDMARK_MINIMUM, landmarkGuidelineActive, stagedRealLandmarks, describeStagedLandmarks, landmarkRetryNote };
