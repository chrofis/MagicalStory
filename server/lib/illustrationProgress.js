'use strict';

/**
 * Progress row for the page-illustration pass. `total` is the number of images
 * the pass renders (pages AND covers: pageDataArray.length), the same set
 * `done` counts. Dividing by the story page count alone read "17/14" and
 * overshot the bar once the three covers finished too (D1, 2026-10-07).
 */
function illustrationProgress(done, total) {
  const pct = 60 + Math.min(4, Math.floor((done / total) * 4));
  return { pct, message: `Illustration ${done}/${total} done...` };
}

module.exports = { illustrationProgress };
