// Detect and remove a stray uniform-colour frame the image model sometimes
// paints around a page despite the generation prompt forbidding it (observed
// ~20% of pages: a blue keyline, a black band framing the art on all sides).
//
// Deterministic and conservative — it fires ONLY for a genuine four-sided,
// thin, uniform frame with a sharp transition to the art. A large uniform
// region that merely touches one edge (sky, a wall, a shadow) does not match:
// the four corners must agree on one colour, every side must have a frame, and
// no side may run past MAX_FRAC of the dimension without hitting real art.
//
// The eval's D-01 border rule already SHOULD catch this but the vision judge
// misses it unreliably; this pixel pass is the deterministic backstop. Cropping
// is lossless-in-spirit (the art bleeds under the frame), so we crop and rescale
// back to the original dimensions rather than paying for a full regenerate.
const sharp = require('sharp');

async function stripUniformBorder(imageBuffer, opts = {}) {
  const TOL_UNIFORM = opts.tolUniform ?? 20;   // max per-channel spread to count as "the frame colour"
  const LINE_FRAC = opts.lineFrac ?? 0.95;      // a frame row/col is ≥95% frame-colour — NOT 100%: JPEG
                                                // noise leaves a few stray pixels, and a small inset touching
                                                // one edge shouldn't veto cropping the frame on that side.
  const BLEND_FRAC = opts.blendFrac ?? 0.30;    // extend the crop through the anti-aliased edge (part frame,
                                                // part art) so no coloured residue survives the rescale.
  const SAFETY_PX = opts.safetyPx ?? 2;         // eat the last sub-pixel fringe the rescale would smear.
  const MAX_FRAC = opts.maxFrac ?? 0.12;        // a real frame is thin: a side running past this is not a frame
  const MIN_PX = opts.minPx ?? 2;               // ignore 1px JPEG fringe

  let data, info;
  try {
    ({ data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true }));
  } catch {
    return { buffer: imageBuffer, cropped: false, reason: 'decode-failed' };
  }
  const { width: W, height: H, channels: C } = info;
  if (W < 40 || H < 40 || C < 3) return { buffer: imageBuffer, cropped: false, reason: 'too-small' };

  const px = (x, y) => { const i = (y * W + x) * C; return [data[i], data[i + 1], data[i + 2]]; };
  const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

  // A frame is ONE colour on all four sides — the four corners must agree.
  const corners = [px(0, 0), px(W - 1, 0), px(0, H - 1), px(W - 1, H - 1)];
  for (let i = 1; i < 4; i++) if (dist(corners[0], corners[i]) > TOL_UNIFORM) {
    return { buffer: imageBuffer, cropped: false, reason: 'corners-disagree' };
  }
  const frame = [0, 1, 2].map(k => Math.round((corners[0][k] + corners[1][k] + corners[2][k] + corners[3][k]) / 4));

  const rowFrac = (y) => { let n = 0; for (let x = 0; x < W; x++) if (dist(px(x, y), frame) <= TOL_UNIFORM) n++; return n / W; };
  const colFrac = (x) => { let n = 0; for (let y = 0; y < H; y++) if (dist(px(x, y), frame) <= TOL_UNIFORM) n++; return n / H; };

  const capH = Math.floor(H * MAX_FRAC), capW = Math.floor(W * MAX_FRAC);
  // `solid` = consecutive lines that are ≥ LINE_FRAC frame-colour (used to DECIDE
  // a frame is present). `crop` = how far to cut: extend past the solid band
  // through the anti-aliased blend (≥ BLEND_FRAC), then a small safety margin,
  // so the rescale can't smear a leftover coloured fringe back into view.
  const scan = (fracFn, from, step, cap) => {
    let solid = 0;
    while (solid < cap && fracFn(from + step * solid) >= LINE_FRAC) solid++;
    if (solid >= cap) return { solid, crop: solid, capped: true };
    let crop = solid;
    while (crop < cap && fracFn(from + step * crop) >= BLEND_FRAC) crop++;
    return { solid, crop: Math.min(cap, crop + SAFETY_PX), capped: false };
  };
  const top = scan(rowFrac, 0, 1, capH);
  const bottom = scan(rowFrac, H - 1, -1, capH);
  const left = scan(colFrac, 0, 1, capW);
  const right = scan(colFrac, W - 1, -1, capW);

  // A side that ran to the cap without hitting art is a large uniform region,
  // not a frame — refuse (never crop a real sky/wall).
  if (top.capped || bottom.capped || left.capped || right.capped) {
    return { buffer: imageBuffer, cropped: false, reason: 'side-capped (uniform region, not a frame)' };
  }
  // A frame exists on ALL four sides (judged on the solid band).
  if (top.solid < MIN_PX || bottom.solid < MIN_PX || left.solid < MIN_PX || right.solid < MIN_PX) {
    return { buffer: imageBuffer, cropped: false, reason: 'not-four-sided' };
  }

  const cw = W - left.crop - right.crop, ch = H - top.crop - bottom.crop;
  if (cw < W * 0.5 || ch < H * 0.5) return { buffer: imageBuffer, cropped: false, reason: 'crop-too-large' };

  const out = await sharp(imageBuffer)
    .extract({ left: left.crop, top: top.crop, width: cw, height: ch })
    .resize(W, H, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { buffer: out, cropped: true, sides: { top: top.crop, bottom: bottom.crop, left: left.crop, right: right.crop }, frameColor: frame };
}

module.exports = { stripUniformBorder };
