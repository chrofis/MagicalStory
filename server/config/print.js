/**
 * print.js — Physical print geometry. Single source of truth for book trim
 * sizes, shared by the PDF writer (server/lib/pdf.js) and the text-overlay
 * renderer (server/lib/textOverlayRenderer.js).
 *
 * It lives in config/ rather than in pdf.js because textOverlayRenderer needs
 * the trim height to convert the story font's POINT size into canvas pixels,
 * and pdf.js already requires textOverlayRenderer — importing the other way
 * would close a require cycle.
 */

// Convert millimeters to PDF points (1pt = 1/72 inch)
const mmToPoints = (mm) => mm * 2.83465;

// Gelato cover spread layout: Back Cover (left) + Spine (center) + Front Cover (right)
const BOOK_FORMATS = {
  // 20x20cm square format (original)
  'square': {
    pageWidth: mmToPoints(200),
    pageHeight: mmToPoints(200),
    coverWidth: mmToPoints(416),   // back + spine + front with bleed
    coverHeight: mmToPoints(206),
    bleed: mmToPoints(3),          // 3mm bleed
    spineWidth: mmToPoints(10),    // 10mm spine (adjusts based on page count in practice)
  },
  // A4-based format: 21x28cm (more text space)
  'A4': {
    pageWidth: mmToPoints(210),
    pageHeight: mmToPoints(280),
    coverWidth: mmToPoints(436),   // back + spine + front with bleed (210*2 + spine + bleed)
    coverHeight: mmToPoints(286),
    bleed: mmToPoints(3),          // 3mm bleed
    spineWidth: mmToPoints(10),    // 10mm spine
  }
};

// Default to A4 (21×28cm portrait). 'square' (20×20cm) is legacy and only
// used for orders that explicitly request it via bookFormat: 'square'.
const DEFAULT_FORMAT = 'A4';

/**
 * Height in PDF points of a printed interior page INCLUDING bleed — i.e. the
 * box the page illustration is scaled to fill. This is the denominator that
 * turns a point size into canvas pixels:
 *
 *   px = pt × imageHeightPx / interiorPageHeightPt(format)
 *
 * @param {string} [bookFormat] - 'A4' (default) or 'square'
 * @returns {number} height in points
 */
function interiorPageHeightPt(bookFormat = DEFAULT_FORMAT) {
  const format = BOOK_FORMATS[bookFormat] || BOOK_FORMATS[DEFAULT_FORMAT];
  return format.pageHeight + 2 * format.bleed;
}

module.exports = {
  mmToPoints,
  BOOK_FORMATS,
  DEFAULT_FORMAT,
  interiorPageHeightPt,
};
