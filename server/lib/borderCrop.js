// Detect and remove a stray uniform-colour frame the image model sometimes
// paints around a page despite the generation prompt forbidding it (observed
// ~20% of pages: a blue keyline, a black band framing the art on all sides).
//
// Deterministic and conservative — it fires ONLY for a genuine four-sided,
// thin frame with a sharp transition to the art. A large uniform region that
// merely touches one edge (sky, a wall, a shadow) does not match: every side
// must have a frame, the four sides must be one colour family, and no side may
// run past MAX_FRAC of the dimension without hitting real art.
//
// The eval's D-01 border rule already SHOULD catch this but the vision judge
// misses it unreliably; this pixel pass is the deterministic backstop. Cropping
// is lossless-in-spirit (the art bleeds under the frame), so we crop and rescale
// back to the original dimensions rather than paying for a full regenerate.
//
// ── 2026-08-22: rewritten after measuring that it was finding NOTHING ─────────
// Swept over 150 full-size production pages, the previous version found 0
// borders while 4 genuine ones were present. Two independent causes, both from
// identifying a border by COUNTING MATCHING PIXELS against a single global
// reference colour:
//
//   1. The reference was the average of the four CORNERS. A painted border's
//      tone drifts across the page — on pg71z58ba9 p12 the top-left is
//      [250,247,238] and the bottom-right [236,232,221] — so one colour cannot
//      describe it and the middle of each edge fell outside tolerance. Raising
//      the tolerance did not rescue it: 30 and 40 both still found only 1 of 4.
//
//   2. A line had to be >= 95% frame-colour. Anything TOUCHING an edge stops the
//      scan dead: on job_1787262655143 p8 two boxed reference miniatures cover
//      ~15% of the right column, so that side measured 4px of border against
//      40px on the other three.
//
// So the reference is now per-side and robust (median over the outermost 3
// lines — a median is unmoved by an inset covering a minority of an edge), and
// a border ends where the match rate COLLAPSES rather than where it dips below
// a purity bar. Measured on the same 150 pages: 4 found, 0 false positives, and
// every negative still refuses — a one-sided panel, a >12% letterbox band, and
// ordinary full-bleed pages.
const sharp = require('sharp');

async function stripUniformBorder(imageBuffer, opts = {}) {
  const TOL_UNIFORM = opts.tolUniform ?? 20;   // max per-channel spread to count as "the frame colour"
  const KEEP_FRAC = opts.keepFrac ?? 0.55;      // a line still counts as frame while this fraction matches.
                                                // NOT a purity bar: the border ends at the CLIFF, where the
                                                // match rate collapses to near zero as the art begins. 0.55
                                                // tolerates an inset covering nearly half of one edge.
  const SAFETY_PX = opts.safetyPx ?? 2;         // eat the last sub-pixel fringe the rescale would smear.
  const MAX_FRAC = opts.maxFrac ?? 0.12;        // a real frame is thin: a side running past this is not a frame
  const MIN_PX = opts.minPx ?? 2;               // ignore 1px JPEG fringe
  const FAMILY_TOL = opts.familyTol ?? 45;      // the four sides must be one colour family, or sky-over-grass
                                                // would read as a "frame" and get cropped.
  const REF_LINES = 3;                          // lines sampled per side to build its reference colour

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
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

  // Sample every other pixel: 2x faster and makes no measurable difference to a
  // median over hundreds of samples.
  const rowPts = (y) => { const o = []; for (let x = 0; x < W; x += 2) o.push(px(x, y)); return o; };
  const colPts = (x) => { const o = []; for (let y = 0; y < H; y += 2) o.push(px(x, y)); return o; };

  // One side: its own reference colour, then walk inward to the cliff.
  const scanSide = (ptsFn, from, step, cap) => {
    const sample = [];
    for (let i = 0; i < REF_LINES; i++) sample.push(...ptsFn(from + step * i));
    const ref = [0, 1, 2].map(k => median(sample.map(p => p[k])));
    const frac = (i) => {
      const pts = ptsFn(from + step * i);
      return pts.filter(p => dist(p, ref) <= TOL_UNIFORM).length / pts.length;
    };
    if (frac(0) < KEEP_FRAC) return { depth: 0, ref, capped: false }; // no frame on this side at all
    let d = 0;
    while (d < cap && frac(d) >= KEEP_FRAC) d++;
    return { depth: Math.min(cap, d + SAFETY_PX), ref, capped: d >= cap };
  };

  const capH = Math.floor(H * MAX_FRAC), capW = Math.floor(W * MAX_FRAC);
  const top = scanSide(rowPts, 0, 1, capH);
  const bottom = scanSide(rowPts, H - 1, -1, capH);
  const left = scanSide(colPts, 0, 1, capW);
  const right = scanSide(colPts, W - 1, -1, capW);

  // A side that ran to the cap without hitting art is a large uniform region,
  // not a frame — refuse (never crop a real sky/wall).
  if (top.capped || bottom.capped || left.capped || right.capped) {
    return { buffer: imageBuffer, cropped: false, reason: 'side-capped (uniform region, not a frame)' };
  }
  // A frame exists on ALL four sides.
  if (top.depth < MIN_PX || bottom.depth < MIN_PX || left.depth < MIN_PX || right.depth < MIN_PX) {
    return { buffer: imageBuffer, cropped: false, reason: 'not-four-sided' };
  }
  // ...and it is ONE frame, not four unrelated edges (sky above, grass below).
  const fam = [top.ref, bottom.ref, left.ref, right.ref];
  for (let i = 1; i < 4; i++) {
    if (dist(fam[0], fam[i]) > FAMILY_TOL) {
      return { buffer: imageBuffer, cropped: false, reason: 'sides-differ (not one frame)' };
    }
  }

  const cw = W - left.depth - right.depth, ch = H - top.depth - bottom.depth;
  if (cw < W * 0.5 || ch < H * 0.5) return { buffer: imageBuffer, cropped: false, reason: 'crop-too-large' };

  const out = await sharp(imageBuffer)
    .extract({ left: left.depth, top: top.depth, width: cw, height: ch })
    .resize(W, H, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    buffer: out,
    cropped: true,
    sides: { top: top.depth, bottom: bottom.depth, left: left.depth, right: right.depth },
    frameColor: fam[0],
  };
}

module.exports = { stripUniformBorder };
