'use strict';

/**
 * WHICH EDIT A PAGE NEEDS FROM ITS VANTAGE'S BASE PLATE.
 *
 * A page shares the base plate when the base was painted in the page's own
 * plate class and light. It needs a camera move only when its class differs from
 * the class the base was ACTUALLY painted in, and a re-light only when its
 * declared light differs from the base's.
 *
 * The derive loop used to compare the page's class with PLATE_BASE_CLASS
 * ('eye-level') alone. A vantage with no eye-level page paints its base from its
 * angled page, so that page was then "derived" into the camera it already had:
 * staging job_1790277448294_5herh01j7 p10 (an ultra-wide base re-derived as
 * ultra-wide) and p14 (high-angle from a high-angle base) each got a second,
 * needless camera move (owner, 2026-09-25).
 */
const { plateClass } = require('./shotVocabulary');
const { lightKey } = require('./sceneLight');

/**
 * @param {Object} a
 * @param {string} a.pageShot  - the page's declared shot
 * @param {string} a.baseShot  - the shot the base plate was painted with
 * @param {Object} [a.pageLight] - sceneLight.declaredLight of the page
 * @param {Object} [a.baseLight] - the light the base plate was painted in
 * @returns {{cls: string, camera: boolean, relit: boolean, key: string}}
 *   `key` names the distinct plate image the page is drawn on; pages with equal
 *   keys share it, and the base plate's own key is `${baseClass}|`.
 */
function plateEditForPage({ pageShot, baseShot, pageLight = null, baseLight = null }) {
  const cls = plateClass(pageShot);
  const camera = cls !== plateClass(baseShot);
  const k = lightKey(pageLight);
  // A page that declares no light keeps the base plate's (stored stories).
  const relit = !!k && k !== lightKey(baseLight);
  return { cls, camera, relit, key: `${cls}|${relit ? k : ''}` };
}

module.exports = { plateEditForPage };
