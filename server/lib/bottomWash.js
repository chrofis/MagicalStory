/**
 * Bottom-edge watercolor wash extension.
 *
 * For the text-below layout: instead of a stark white text strip under the
 * image, we extend the image's bottom edge as a blurred wash that flows into
 * the text area. Text sits on the wash (subtle painterly background) rather
 * than on hard white.
 *
 * Algorithm:
 *   1. Take the bottom strip of the image (default: bottom 6%).
 *   2. Blur it heavily (blurRadius scales with how far we're stretching).
 *   3. Stretch the blurred strip vertically to washHeightPx.
 *   4. Optionally lighten toward paper-white so dark text stays readable —
 *      controlled by `lightenAmount` (0..1, default 0.55).
 *   5. Return the wash strip as a Buffer (PNG) ready to composite below the
 *      image in PDF/HTML rendering.
 *
 * Caller composes:
 *   [ original image ]
 *   [ wash strip     ]   ← this output
 *   [ text on wash   ]   ← caller draws text on top of the wash
 *
 * @param {string|Buffer} imageInput - data: URL, base64, or Buffer
 * @param {number} washHeightPx - height in pixels of the wash strip to produce
 * @param {Object} [opts]
 * @param {number} [opts.sourceStripFraction=0.06] - fraction of image height to sample (0..0.2)
 * @param {number} [opts.blurRadius=24] - sharp blur sigma applied before stretch
 * @param {number} [opts.lightenAmount=0.55] - 0 = no lightening, 1 = pure white
 * @returns {Promise<Buffer>} PNG buffer of the wash strip, width=image width, height=washHeightPx
 */
async function generateBottomWash(imageInput, washHeightPx, opts = {}) {
  const sharp = require('sharp');
  const { log } = require('../utils/logger');

  const sourceStripFraction = Math.max(0.02, Math.min(0.2, opts.sourceStripFraction ?? 0.06));
  const blurRadius = Math.max(1, Math.min(60, opts.blurRadius ?? 24));
  const lightenAmount = Math.max(0, Math.min(1, opts.lightenAmount ?? 0.55));

  const buf = await toBuffer(imageInput);
  const meta = await sharp(buf).metadata();
  const w = meta.width;
  const h = meta.height;
  const stripPx = Math.max(8, Math.round(h * sourceStripFraction));

  // Step 1+2: extract bottom strip + blur.
  const blurredStrip = await sharp(buf)
    .extract({ left: 0, top: h - stripPx, width: w, height: stripPx })
    .blur(blurRadius)
    .toBuffer();

  // Step 3: stretch vertically to the requested wash height.
  let wash = await sharp(blurredStrip)
    .resize({ width: w, height: washHeightPx, fit: 'fill' })
    .toBuffer();

  // Step 4: lighten by compositing a semi-transparent white layer on top.
  if (lightenAmount > 0) {
    const whiteAlpha = Math.round(lightenAmount * 255);
    const whiteOverlay = await sharp({
      create: {
        width: w,
        height: washHeightPx,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: whiteAlpha / 255 },
      },
    }).png().toBuffer();
    wash = await sharp(wash).composite([{ input: whiteOverlay }]).png().toBuffer();
  }

  log.debug(`🎨 [BOTTOM-WASH] wash ${w}x${washHeightPx} from ${stripPx}px source strip (blur=${blurRadius}, lighten=${lightenAmount})`);
  return wash;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return Promise.resolve(input);
  if (typeof input !== 'string') throw new Error('bottomWash: expected Buffer or string input');
  const m = input.match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
  const base64 = m ? m[1] : input;
  return Promise.resolve(Buffer.from(base64, 'base64'));
}

module.exports = { generateBottomWash };
