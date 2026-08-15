// Mechanical garment-colour repair — the CONSUMER of the entity check's
// `garmentColourMismatches` channel.
//
// The entity consistency grid already tells us, for free, which page shows a
// character's garment in the wrong colour (see decisions.md 2026-08-06). That
// finding deliberately carries no severity points and never triggers a redraw,
// because a garment of the right shape in the wrong colour is fixable
// deterministically. This module is that fix.
//
// Why it does NOT reuse garmentHueNormalize's approach:
//   1. That pass never identifies the garment — it takes the modal hue of a box
//      and hopes the garment dominates. On a red-haired character the modal hue
//      WAS her hair, and an orange shirt matched it at 3.8 deg and was blessed.
//      Here the garment comes from GroundingDINO (text -> box) + MobileSAM
//      (box -> silhouette), so the mask is the garment and nothing else.
//   2. That pass rotates hue only, preserving L*. That cannot reach yellow: with
//      a yellow's a*/b*, L=45 is olive and L=75 is yellow. The measured case
//      landed on the exact target hue (102.9 vs 103.2) and still looked wrong.
//      Here the whole L*a*b* vector moves.
//
// The move is a mean OFFSET, not a replacement — every pixel keeps its own
// deviation from the garment mean, so folds, seams and highlights survive.
//
// Lighting: the target is the character's canonical garment colour from the
// STYLED AVATAR, scaled by a per-figure lighting factor probed from SKIN. Skin
// is the same material on both images, so a lightness difference between the
// page face and the avatar face is illumination, not drift. Without that scale
// a night scene would be dragged to studio brightness.

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { _rgbToLab, _labToRgb } = require('./imageCompositing');
const { isGarmentPixel } = require('./garmentHueNormalize');

const DEG = 180 / Math.PI;

const DEFAULTS = {
  // Queries are colour-agnostic on purpose: naming the colour we EXPECT would
  // bias the detector toward finding it, and naming the colour we SEE requires
  // knowing it first. The garment WORD comes from the entity channel and is
  // passed through verbatim — see garmentQueryFor.
  boxThreshold: 0.18,
  textThreshold: 0.14,
  // Crop padding around the figure box before asking for the garment.
  cropPad: 0.02,
  // Lighting factor bounds. Outside these the skin probe is not believable
  // (blown highlights, a face in deep shadow) and we fall back to 1.
  lightingMin: 0.55,
  lightingMax: 1.35,
  // Hard caps on the L*a*b* move, so a mis-detected mask can never repaint a
  // garment into an arbitrary colour.
  maxDeltaL: 40,
  maxDeltaAB: 60,
  // Colour-gated mask growth — see dilateMaskByColour. Radius is the hard
  // bound (hair can sit ~6 deltaE from an orange shirt, so the colour gate
  // alone is not enough); deltaE keeps the growth on-garment.
  dilateRadius: 3,
  dilateDeltaE: 12,
  // Apply-side colour gate. The SAM mask is trusted for WHERE the garment is,
  // not for WHAT every pixel inside it is: on a figure with folded arms the
  // silhouette picked up a speckle of forearm, and without this gate those skin
  // pixels took the full garment offset. Measured on that page: 88% of masked
  // pixels sit within deltaE 30 of the garment mean (the shirt and its own
  // shading) while skin sits at ~41. Full weight below `applyDeltaESoft`, ramped
  // to zero at `applyDeltaEHard`, so folds survive and skin fades out.
  applyDeltaESoft: 26,
  applyDeltaEHard: 40,
  // VERIFICATION GATE + COLOUR POINTS, both keyed on the evaluator's
  // `observedColour` (see maskMatchesObservedColour / deriveColourPoints).
  // Hue tolerance is generous: it must pass a purple hat measured at -28.6°
  // against a purple reference at -49° (21° apart, art-style shading) while
  // rejecting the cream map at +82° (131° apart).
  observedMaxHueDeg: 50,
  observedMinChroma: 12,      // a chromatic garment cannot read as neutral
  achromaticChroma: 10,       // reference below this has no usable hue
  observedMaxChromaForNeutral: 22,
  observedMaxDeltaL: 32,
  observedLightnessMargin: 10,
  // MASK MODE — how the page-side pixels are chosen. Compared head-to-head in
  // the Lab; see decisions.md 2026-08-13.
  //   'dino-sam'        text->box->silhouette (the original)
  //   'dino-sam-points' the same, steered by colour point prompts
  //   'colour'          pixels that ARE the reported bad colour, no detector
  //   'intersect'       dino-sam AND colour
  //   'highlight-dino'  paint the bad-colour pixels pink, ask DINO to box THAT,
  //                     then run SAM on the ORIGINAL pixels in that box
  //   'colour-box-sam'  bounding box of the bad-colour pixels -> SAM on the original
  // DEFAULT (owner, 2026-08-13, Lab 583-586): the DINO box IS the preferred
  // method when it works, so the default keeps it and fixes it two ways —
  // multi-phrase queries with a size guard find a usable box, and colour point
  // prompts stop SAM choosing the wrong object inside it. Measured on all four
  // known-bad cases; every one lands on the garment.
  maskMode: 'dino-sam-points',
  // Connected components — a garment is one connected thing (shoes are two).
  // Colour matching alone also picks up eye glints and specks on an arm.
  connectedOnly: true,
  minComponentPx: 150,
  keepComponents: 2,
  // The colour the bad pixels are painted for 'highlight-dino'. Magenta because
  // no garment in a children's illustration is naturally this saturated, so the
  // highlight cannot be confused with the art.
  highlightRGB: [255, 0, 255],
  highlightPadPx: 6,
  // Multi-phrase garment queries (see detectGarmentBoxMulti). 'single' asks one
  // phrasing, 'multi' asks the enum's alternatives and keeps the most plausible.
  queryMode: 'multi',
  // A garment is PART of a figure. A box above this share of the figure crop is
  // the figure itself — measured: "skirt" returned 82% (the whole mermaid),
  // "shoes" 94% (the whole picture), while real garment boxes ran 2-62%.
  maxBoxFrac: 0.75,
  // Colour selection (see selectBadColourPixels).
  selectHueDeg: 40,
  selectMinChroma: 10,
  selectSkinMargin: 18,
  headGrowSide: 0.45,
  headGrowUp: 0.55,
  // Ask a vision model whether the marked pixels really are that garment.
  // 'off' | 'model'. A paid call (~$0.0005), so it is opt-in.
  verifyMask: 'off',
  verifyModel: 'gemini-2.5-flash',
  pointGrid: 9,               // 81 samples inside the box
  pointFgDeltaE: 28,
  pointBgDeltaE: 45,
  maxFgPoints: 8,
  maxBgPoints: 8,
  // Below this the garment is already right; skip rather than churn bytes.
  minDeltaE: 6,
  minMaskPx: 200,
  // Same floor for the avatar-side mask. Lower than the page's: on a 2x4 sheet
  // one panel's hat or shoe is a small silhouette, and it is still a valid
  // sample as long as it is genuinely that garment's pixels.
  minAvatarMaskPx: 400,
  // CROSS-PANEL AGREEMENT on the avatar side (see avatarGarmentLab). The styled
  // sheet shows the SAME character up to 8 times, so the same garment is present
  // several times over — measure it in more than one panel and require the
  // readings to match before believing any of them.
  avatarPanels: 3,
  avatarAgreeDeltaE: 10,
  // Two DINO candidates that overlap this much are the same panel, not a second
  // opinion — a duplicate box would "agree" with itself and prove nothing.
  avatarPanelIoU: 0.3,
};

/**
 * SUPERSEDES "NO TRANSLATION TABLE" (2026-08-09 → 2026-08-12). That rule deleted
 * a word→prompt table and passed the entity channel's word through verbatim,
 * because the table mapped unrecognised words onto an unconditional `'top'` —
 * and `top` selected the TORSO, so "breeches" aimed a legwear repair at the
 * chest and "sash" collided with it on the dedupe key and vanished
 * (job_1786287569165_7f75jspcz).
 *
 * What that rule got right is kept: there is still no fallback, and no code
 * guesses what an unknown word means. What it got wrong was the premise that an
 * open vocabulary is safe because GroundingDINO accepts any phrase. It accepts
 * any phrase and always answers — it cannot say "not visible" — so an
 * ungroundable word yields a confident, wrong box rather than a refusal
 * (evidence in GARMENT_ENUM below).
 *
 * The fix is therefore at the SOURCE, not in a translation layer: the evaluator
 * now fills `garment` from a closed set, so there is no arbitrary word left to
 * translate. Each value carries its own query and off-enum is dropped loudly by
 * the caller — never folded onto a neighbour, which is the mistake that made the
 * old table dangerous.
 *
 * @returns {{key: string|null, prompt: string|null, offEnum: boolean, raw: string}}
 *   key is null both when there is no garment word and when the word is off-enum;
 *   `offEnum` distinguishes them so the caller can log the right refusal.
 */

/**
 * The CLOSED garment vocabulary (owner, 2026-08-12). The evaluator fills
 * `garment` from these values only, and this object is rendered into
 * entity-consistency-check.txt so the prompt and the detector cannot drift.
 *
 * WHY A CLOSED SET. The word is handed to an open-vocabulary detector, which
 * cannot answer "that is not visible" — it always returns its best box. A word
 * naming a SUB-PART therefore returns the parent, and a word naming something
 * occluded returns whatever is biggest. Measured on staging
 * job_1786484554633_crojok432 p3 (Lab 533-537), replayed against v0:
 *   - "hatband" → box [177,2,615,270], the HAT box to within one pixel
 *     ([176,3,614,270]) — the hat was repainted twice;
 *   - "robe"    → box covering 62% of the crop, i.e. the map the child holds;
 *   - "shoes"   → box covering 94% of the crop, i.e. the whole picture.
 * In every case SAM's mask was a strict subset of the box it was given, so the
 * detector is the failure, not the segmenter. A closed vocabulary of whole
 * garments removes the class of queries that cannot be grounded.
 *
 * The value maps to the phrase the detector is asked, so the eval's label and
 * the detector's query are chosen independently: `pants` reads well in a
 * finding, "the trousers worn by the person" grounds better in an image.
 *
 * NO `belt`/`sash` (owner's call): a waist item is small and frequently
 * occluded. A wrong-coloured sash is therefore left wrong rather than repainted
 * from a guess — the same trade as the no-default clothing category.
 */
const GARMENT_ENUM = Object.freeze({
  // QUERIES: one bare noun, one "worn by the person", one anchored to a BODY
  // PART. Measured on job_1786571353564_0sgrd0f4g p4 (Lab 578): "the shirt worn
  // by the person" gave 82% of the crop and "the upper body clothing worn by the
  // person" 83% — both the whole figure — while "the top worn on the chest" gave
  // 3% and was the shell top. Broader CATEGORY wording made it worse; anatomical
  // anchoring made it work. The bare noun is included because short prompts and
  // long prompts fail differently and this is cheap to ask.
  // ANATOMICAL PHRASING FIRST, and the list is an ESCALATION LADDER, not a fan-out
  // (owner, 2026-08-14). A phrase naming a garment TYPE has no referent when that
  // type is not in the picture — a mermaid has no shirt, so the detector returns
  // the most person-like region it can find (82% of the crop). A phrase naming a
  // BODY LOCATION always has a referent: every figure has a chest, a waist, legs,
  // feet, a head, whatever it happens to be wearing. Measured on the same crop,
  // one word changed: "the shirt worn by the person" 82%, "the top worn on the
  // chest" 3%. The anatomical form passed the size guard on all four measured
  // cases (3%, 32%, 58%, 13%), so it is asked FIRST and the rest are reached only
  // when it fails — ONE detector pass in the common case instead of three.
  // NOTE: an anatomical phrase must describe the garment's FULL EXTENT, not a
  // sub-region of it. "the fabric covering the torso" returned a 58% box that
  // held only the upper robe — 48,329px against the 72,170px the plain form
  // reached — so the lower robe would have kept its old colour while the top
  // changed. Small garments (hat, top, shoes) are unaffected because their
  // anatomical phrase already spans the whole item.
  hat: { query: 'the hat worn by the person', covers: 'any headwear — hat, cap, hood, headscarf, and its band or trim',
    queries: ['the hat on the head', 'the hat worn by the person', 'hat'] },
  top: { query: 'the shirt worn by the person', covers: 'shirt, blouse, t-shirt, sweater, tunic, and its collar or cuffs',
    queries: ['the top worn on the chest', 'the shirt worn by the person', 'shirt'] },
  jacket: { query: 'the jacket worn by the person', covers: 'jacket, coat, cardigan, cloak, cape',
    queries: ['the jacket over the chest and arms', 'the jacket worn by the person', 'jacket'] },
  dress: { query: 'the dress worn by the person', covers: 'dress, robe, gown — a single garment covering torso and legs',
    queries: ['the dress worn by the person', 'the fabric covering the body from shoulders to ankles', 'dress'] },
  pants: { query: 'the trousers worn by the person', covers: 'trousers, jeans, shorts, leggings',
    queries: ['the fabric covering the legs', 'the trousers worn by the person', 'trousers'] },
  skirt: { query: 'the skirt worn by the person', covers: 'skirt',
    queries: ['the fabric below the waist', 'the skirt worn by the person', 'skirt'] },
  shoes: { query: 'the shoes worn by the person', covers: 'shoes, boots, sandals, slippers',
    queries: ['the shoes on the feet', 'the shoes worn by the person', 'shoes'] },
});
const GARMENT_VALUES = Object.freeze(Object.keys(GARMENT_ENUM));

/** The enum as prompt text — the only place the evaluator learns the vocabulary. */
function garmentEnumForPrompt() {
  return GARMENT_VALUES.map(v => `- \`${v}\` — ${GARMENT_ENUM[v].covers}`).join('\n');
}

function garmentQueryFor(garment) {
  const key = String(garment == null ? '' : garment)
    .toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return { key: null, prompt: null, offEnum: false, raw: '' };
  // NO SYNONYM TABLE. Folding an unknown word onto a "nearest" enum value would
  // be code deciding what a description means, which is exactly what the eval
  // rules forbid. Off-enum is reported and dropped; the prompt is where the
  // vocabulary is taught.
  if (!GARMENT_ENUM[key]) return { key: null, prompt: null, offEnum: true, raw: key };
  return { key, prompt: GARMENT_ENUM[key].query, offEnum: false, raw: key };
}

/**
 * Colour NAMES → reference sRGB. The entity check already emits `observedColour`
 * ("purple") and `expectedColour` ("blue") alongside every garment_colour
 * finding, so the colour the garment currently IS is known before any pixel is
 * touched. That is the missing input: the repair knew where it was going and
 * never checked where it was starting from.
 *
 * This is a lookup of colour words to colour values — objective, unlike reading
 * meaning out of a description, which the eval rules forbid. It never decides
 * what a finding means; it only turns a colour word into a colour.
 */
const COLOUR_REFS = Object.freeze({
  black: [26, 26, 26], white: [245, 245, 245], grey: [128, 128, 128], gray: [128, 128, 128],
  silver: [176, 176, 176], cream: [238, 226, 198], beige: [222, 205, 172], ivory: [240, 234, 214],
  red: [190, 40, 40], maroon: [110, 30, 40], crimson: [180, 30, 60], pink: [225, 130, 165],
  orange: [225, 125, 40], gold: [200, 160, 60], yellow: [225, 200, 60], olive: [120, 115, 50],
  green: [60, 130, 70], teal: [50, 130, 130], turquoise: [70, 175, 175], mint: [150, 205, 175],
  blue: [55, 90, 165], navy: [35, 50, 95], cyan: [90, 180, 200], indigo: [70, 60, 140],
  purple: [110, 70, 150], violet: [130, 85, 165], lavender: [180, 160, 205], magenta: [180, 60, 150],
  brown: [110, 75, 50], tan: [190, 160, 120], khaki: [175, 165, 120], rust: [160, 80, 45],
});

// Modifiers carry no hue of their own; they qualify the colour word after them.
const COLOUR_MODIFIERS = new Set(['dark', 'light', 'deep', 'pale', 'bright', 'medium',
  'muted', 'dull', 'soft', 'rich', 'faded', 'washed', 'off', 'very']);

/**
 * Resolve a colour word to a reference L*a*b*, tolerantly.
 *
 * The evaluator writes compounds — "dark brown/black", "yellow/gold" — so split
 * on separators and take the first term that names a colour we know. REFUSES
 * (null) when nothing resolves: a repair that cannot tell what colour it is
 * starting from must not proceed, exactly as it refuses without a target.
 *
 * @returns {{name:string, lab:number[], chroma:number, hueDeg:number}|null}
 */
function resolveColourName(word) {
  const terms = String(word == null ? '' : word)
    .toLowerCase().replace(/[^a-z/ -]/g, ' ').split(/[/,\s-]+/).filter(Boolean);
  for (const term of terms) {
    if (COLOUR_MODIFIERS.has(term)) continue;
    const rgb = COLOUR_REFS[term];
    if (!rgb) continue;
    const lab = _rgbToLab(rgb[0], rgb[1], rgb[2]);
    return {
      name: term, lab,
      chroma: Math.hypot(lab[1], lab[2]),
      hueDeg: Math.atan2(lab[2], lab[1]) * DEG,
    };
  }
  return null;
}

/**
 * Does a measured mask colour actually look like the colour the evaluator said
 * the garment is? THE VERIFICATION GATE (owner, 2026-08-12).
 *
 * The per-pixel gate inside the apply loop cannot answer this: it scores every
 * pixel against the MASK'S OWN MEAN, so once the wrong object dominates the mask
 * that object defines the mean and the gate defends it. On
 * job_1786484554633_crojok432 p3 the `shoes` mask was 68% of the crop and the
 * child's actual black shoes were gated OUT while the cream map was repainted.
 *
 * This gate asks a question the mask cannot answer about itself: the evaluator
 * said the robe is PURPLE, the mask measures L 77 / chroma 16 / hue +82° — pale
 * cream. That is not purple, so the mask is not the robe, and nothing is
 * repainted. It catches a bad mask whatever produced it — a wrong DINO box, or
 * SAM choosing the wrong object inside a fair one.
 *
 * Achromatic references (black, white, grey) carry no meaningful hue, so they
 * are judged on lightness and on the mask being unsaturated; chromatic ones are
 * judged on hue, which is what survives scene lighting.
 *
 * @returns {{ok:boolean, reason:string|null, hueDelta:number|null}}
 */
function maskMatchesObservedColour(cur, ref, cfg) {
  if (!ref) return { ok: true, reason: null, hueDelta: null };   // nothing to check against
  const chroma = Math.hypot(cur.a, cur.b);
  if (ref.chroma < cfg.achromaticChroma) {
    if (chroma > cfg.observedMaxChromaForNeutral) {
      return {
        ok: false, hueDelta: null,
        reason: `mask is saturated (chroma ${chroma.toFixed(1)}) but the garment was reported as ${ref.name}`,
      };
    }
    const dL = Math.abs(cur.L - ref.lab[0]);
    if (dL > cfg.observedMaxDeltaL) {
      return {
        ok: false, hueDelta: null,
        reason: `mask lightness L ${cur.L.toFixed(1)} is ${dL.toFixed(0)} from ${ref.name} (L ${ref.lab[0].toFixed(0)})`,
      };
    }
    return { ok: true, reason: null, hueDelta: null };
  }
  // Chromatic reference: a near-neutral mask is not that colour at all.
  if (chroma < cfg.observedMinChroma) {
    return {
      ok: false, hueDelta: null,
      reason: `mask is near-neutral (chroma ${chroma.toFixed(1)}) but the garment was reported as ${ref.name}`,
    };
  }
  const hue = Math.atan2(cur.b, cur.a) * DEG;
  let d = Math.abs(hue - ref.hueDeg) % 360;
  if (d > 180) d = 360 - d;
  if (d > cfg.observedMaxHueDeg) {
    return {
      ok: false, hueDelta: +d.toFixed(1),
      reason: `mask hue ${hue.toFixed(1)}° is ${d.toFixed(0)}° from ${ref.name} (${ref.hueDeg.toFixed(0)}°) — this is not the garment`,
    };
  }
  // HUE IS NOT ENOUGH on its own. Cream and brown share a hue — they differ in
  // LIGHTNESS — so the p3 `shoes` mask (the cream map, L 66.6, hue +68°) sits
  // 9° from brown and would pass a hue-only test. Lightness cannot be a fixed
  // threshold either, because scene lighting legitimately moves it; but it
  // cannot move it arbitrarily far, so lightingMin/lightingMax bound the widest
  // range any illumination could plausibly produce. Anything outside even that
  // is a different colour, not a lit version of this one. (These two constants
  // are ONLY this gate's bounds — the lighting factor that once scaled the
  // target was removed; see the note at the repaint step.)
  const loL = ref.lab[0] * cfg.lightingMin - cfg.observedLightnessMargin;
  const hiL = ref.lab[0] * cfg.lightingMax + cfg.observedLightnessMargin;
  if (cur.L < loL || cur.L > hiL) {
    return {
      ok: false, hueDelta: +d.toFixed(1),
      reason: `mask lightness L ${cur.L.toFixed(1)} is outside anything lighting could make ${ref.name} `
        + `(L ${ref.lab[0].toFixed(0)} → ${loL.toFixed(0)}–${hiL.toFixed(0)})`,
    };
  }
  return { ok: true, reason: null, hueDelta: +d.toFixed(1) };
}

/**
 * Foreground/background POINT PROMPTS for SAM, derived from the colour the
 * evaluator says the garment is.
 *
 * A box alone cannot express "the robe, not the map": on p3 the robe is occluded
 * by a map the child holds across his chest, so EVERY box containing the robe
 * also contains the map, and SAM picks the larger, more salient object. DINO
 * cannot help — it emits boxes, not points. But /figure-mask already accepts
 * `points` + `point_labels` (1 = foreground, 0 = background) nested to share the
 * box's batch dimension; the garment path simply never used them.
 *
 * Points are sampled on a grid inside the box: those close to the observed
 * colour become foreground, those far from it become background. Spreading them
 * over the grid rather than taking the N best avoids stacking every point on one
 * bright fold.
 */
function deriveColourPoints(cropRaw, cw, ch, box, ref, cfg) {
  if (!ref || !Array.isArray(box)) return { points: null, labels: null, fg: 0, bg: 0 };
  const [x0, y0, x1, y1] = box.map(Number);
  const bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 8 && bh > 8)) return { points: null, labels: null, fg: 0, bg: 0 };
  const N = cfg.pointGrid;
  const fg = [], bg = [];
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const px = Math.round(x0 + bw * (gx + 0.5) / N);
      const py = Math.round(y0 + bh * (gy + 0.5) / N);
      if (px < 0 || py < 0 || px >= cw || py >= ch) continue;
      const i = (py * cw + px) * 3;
      const lab = _rgbToLab(cropRaw[i], cropRaw[i + 1], cropRaw[i + 2]);
      const d = labDeltaE({ L: lab[0], a: lab[1], b: lab[2] },
        { L: ref.lab[0], a: ref.lab[1], b: ref.lab[2] });
      if (d <= cfg.pointFgDeltaE) fg.push({ p: [px, py], d });
      else if (d >= cfg.pointBgDeltaE) bg.push({ p: [px, py], d });
    }
  }
  // No foreground anywhere in the box means the garment colour simply is not
  // there — say nothing rather than steering SAM with background points alone.
  if (fg.length === 0) return { points: null, labels: null, fg: 0, bg: 0 };
  const take = (arr, n, best) => arr
    .slice().sort((u, v) => (best ? u.d - v.d : v.d - u.d))
    .slice(0, n).map(o => o.p);
  const fgPts = take(fg, cfg.maxFgPoints, true);
  const bgPts = take(bg, cfg.maxBgPoints, false);
  return {
    points: [...fgPts, ...bgPts],
    labels: [...fgPts.map(() => 1), ...bgPts.map(() => 0)],
    fg: fgPts.length, bg: bgPts.length,
  };
}

/**
 * Body region each enum value occupies, as a fraction of the FIGURE crop's
 * height. This is what the enum buys on the page side: a garment word no
 * detector can ground still tells us roughly WHERE on a body to look.
 * Deliberately generous — it is a prior, not a mask.
 */
const GARMENT_REGION = Object.freeze({
  hat: [0, 0.30], top: [0.05, 0.75], jacket: [0.05, 0.80], dress: [0.05, 1.0],
  pants: [0.40, 1.0], skirt: [0.35, 1.0], shoes: [0.78, 1.0],
});

/**
 * Median L*a*b* of THIS figure's skin, sampled from the middle of its own face
 * box. A global skin rule cannot do this job: `isGarmentPixel` rejects HSL hue
 * 7-50 as skin, which also rejects tan, gold and cream GARMENTS — measured on
 * job_1786571353564_0sgrd0f4g p4, where the golden scales of a mermaid tail
 * were discarded as skin. A per-figure sample separates that character's skin
 * from a garment that merely looks warm.
 */
function figureSkinLab(cropRaw, cw, ch, faceBoxCrop) {
  if (!faceBoxCrop) return null;
  const [fx0, fy0, fx1, fy1] = faceBoxCrop;
  const Ls = [], as = [], bs = [];
  const y0 = Math.max(0, Math.round(fy0 + (fy1 - fy0) * 0.45));
  const y1 = Math.min(ch, Math.round(fy0 + (fy1 - fy0) * 0.80));
  const x0 = Math.max(0, Math.round(fx0 + (fx1 - fx0) * 0.30));
  const x1 = Math.min(cw, Math.round(fx0 + (fx1 - fx0) * 0.70));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * cw + x) * 3;
      const l = _rgbToLab(cropRaw[i], cropRaw[i + 1], cropRaw[i + 2]);
      Ls.push(l[0]); as.push(l[1]); bs.push(l[2]);
    }
  }
  if (Ls.length < 40) return null;
  const med = arr => arr.slice().sort((u, v) => u - v)[arr.length >> 1];
  return { L: med(Ls), a: med(as), b: med(bs), samples: Ls.length };
}

/**
 * Keep only CONNECTED regions of a mask (owner, 2026-08-13).
 *
 * Colour matching alone is scattershot: on the mermaid page it selected the
 * tail, the shell top, a few specks on an arm and a glint in each eye. A
 * garment is one connected thing (or a small number of them — a pair of shoes
 * is two), so components below `minComponentPx` are speckle and are dropped,
 * and at most `keepComponents` of the largest survive.
 *
 * Iterative flood fill, not recursion: a 900x1000 crop overflows the stack.
 *
 * @returns {{alpha:Buffer, count:number, components:number, kept:number, sizes:number[]}}
 */
function keepConnectedComponents(alpha, cw, ch, cfg) {
  const labels = new Int32Array(cw * ch).fill(-1);
  const sizes = [];
  const stack = new Int32Array(cw * ch);
  let next = 0;
  for (let i = 0; i < cw * ch; i++) {
    if (!alpha[i] || labels[i] !== -1) continue;
    let sp = 0, size = 0;
    stack[sp++] = i;
    labels[i] = next;
    while (sp > 0) {
      const cur = stack[--sp];
      size++;
      const x = cur % cw, y = (cur - x) / cw;
      // 8-connected: a diagonal seam of scales is still one garment.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (!alpha[ni] || labels[ni] !== -1) continue;
          labels[ni] = next;
          stack[sp++] = ni;
        }
      }
    }
    sizes.push(size);
    next++;
  }
  const ranked = sizes.map((n, id) => ({ id, n }))
    .filter(c => c.n >= cfg.minComponentPx)
    .sort((a, b) => b.n - a.n)
    .slice(0, cfg.keepComponents);
  const keep = new Set(ranked.map(c => c.id));
  const out = Buffer.alloc(cw * ch);
  let count = 0;
  for (let i = 0; i < cw * ch; i++) {
    if (alpha[i] && keep.has(labels[i])) { out[i] = 255; count++; }
  }
  return { alpha: out, count, components: next, kept: keep.size, sizes: ranked.map(c => c.n) };
}

/** Tight bounding box of a mask, in crop pixel coords, or null when empty. */
function maskBoundingBox(alpha, cw, ch, padPx = 0) {
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (!alpha[y * cw + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return [
    Math.max(0, x0 - padPx), Math.max(0, y0 - padPx),
    Math.min(cw, x1 + 1 + padPx), Math.min(ch, y1 + 1 + padPx),
  ];
}

/**
 * Select the pixels that ARE the reported bad colour — the alternative to
 * asking a detector where the garment is (owner, 2026-08-13).
 *
 * Five conditions, each answering a specific failure measured on
 * job_1786571353564_0sgrd0f4g p4:
 *   - inside the enum's body region  → a `top` query cannot repaint a tail;
 *   - outside the HEAD zone          → sunlit hair is yellow-hued and was being
 *                                      selected. The zone grows up and sideways
 *                                      but NEVER below the chin, which is what
 *                                      swallowed a shell top when it did;
 *   - chroma above a floor           → excludes water, shadow, white;
 *   - hue near the reported colour   → the actual selection criterion;
 *   - far from THIS figure's skin    → per-figure, so a gold garment survives.
 *
 * @returns {{alpha:Buffer, count:number, skin:object|null, reason:string|null}}
 */
function selectBadColourPixels(cropRaw, cw, ch, opts) {
  const { ref, cfg, garmentKey, faceBoxCrop } = opts;
  const alpha = Buffer.alloc(cw * ch);
  if (!ref) return { alpha, count: 0, skin: null, reason: 'no resolvable observed colour to select on' };
  const skin = figureSkinLab(cropRaw, cw, ch, faceBoxCrop);
  const region = GARMENT_REGION[garmentKey] || [0, 1];
  const ry0 = Math.round(region[0] * ch), ry1 = Math.round(region[1] * ch);
  let head = null;
  if (faceBoxCrop) {
    const [fx0, fy0, fx1, fy1] = faceBoxCrop;
    const hw = fx1 - fx0, hh = fy1 - fy0;
    head = {
      x0: fx0 - hw * cfg.headGrowSide, x1: fx1 + hw * cfg.headGrowSide,
      y0: fy0 - hh * cfg.headGrowUp, y1: fy1,
    };
  }
  const isHat = garmentKey === 'hat';
  let count = 0;
  for (let y = 0; y < ch; y++) {
    if (y < ry0 || y >= ry1) continue;
    for (let x = 0; x < cw; x++) {
      if (head) {
        const inHead = x >= head.x0 && x < head.x1 && y >= head.y0 && y < head.y1;
        // Headwear lives IN the head zone; everything else never does.
        if (isHat ? !inHead : inHead) continue;
      } else if (isHat) {
        continue;   // no face box → no way to find the head → select nothing
      }
      const i = (y * cw + x) * 3;
      const lab = _rgbToLab(cropRaw[i], cropRaw[i + 1], cropRaw[i + 2]);
      const chroma = Math.hypot(lab[1], lab[2]);
      if (chroma < cfg.selectMinChroma) continue;
      let d = Math.abs(Math.atan2(lab[2], lab[1]) * DEG - ref.hueDeg) % 360;
      if (d > 180) d = 360 - d;
      if (d > cfg.selectHueDeg) continue;
      if (skin && Math.hypot(lab[0] - skin.L, lab[1] - skin.a, lab[2] - skin.b) < cfg.selectSkinMargin) continue;
      alpha[y * cw + x] = 255;
      count++;
    }
  }
  return { alpha, count, skin, reason: null };
}

/**
 * Ask a vision model whether the marked pixels are actually that garment
 * (owner's idea, 2026-08-13). Every other check reasons about colour or
 * geometry and can be fooled by a mask that is self-consistently wrong — the
 * per-pixel gate defends whatever dominates the mask, and the colour gate
 * passes when the evaluator misread the same figure. A model looking at the
 * marked pixels answers a question none of them can: is this a hat, or is it
 * a map?
 *
 * The overlay tints selected pixels rather than cutting them out, so the model
 * still sees the surrounding body and can judge the region in context.
 */
async function askIsThisTheGarment(cropBuf, alpha, cw, ch, garmentKey, cfg) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { asked: false, reason: 'no GEMINI_API_KEY' };
  const { data: raw } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(raw);
  for (let i = 0; i < cw * ch; i++) {
    if (!alpha[i]) continue;
    out[i * 3] = Math.round(out[i * 3] * 0.35 + 255 * 0.65);
    out[i * 3 + 1] = Math.round(out[i * 3 + 1] * 0.35);
    out[i * 3 + 2] = Math.round(out[i * 3 + 2] * 0.35 + 255 * 0.65);
  }
  const overlay = await sharp(out, { raw: { width: cw, height: ch, channels: 3 } })
    .jpeg({ quality: 88 }).toBuffer();
  const prompt = `The magenta highlight marks a region of this illustration.
Answer only about the highlighted region.
Is the highlighted region the ${garmentKey} worn by the person?
Reply as JSON: {"isGarment": true|false, "whatItIs": "<what the highlighted region actually is, 5 words max>"}`;
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/jpeg', data: overlay.toString('base64') } },
      { text: prompt },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } },
  };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${cfg.verifyModel}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { asked: false, reason: `HTTP ${res.status}`, overlay };
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { asked: false, reason: `unparseable: ${text.slice(0, 80)}`, overlay };
    const parsed = JSON.parse(m[0]);
    return { asked: true, isGarment: parsed.isGarment === true, whatItIs: parsed.whatItIs || null, overlay };
  } catch (e) {
    return { asked: false, reason: e.message, overlay };
  }
}

/**
 * HIGHLIGHT-THEN-DETECT (owner's idea, 2026-08-13).
 *
 * The detector's whole problem is salience: asked for "the shirt" on a mermaid
 * it returns the biggest person-shaped thing, because no shirt is there to be
 * salient. So make the candidate salient FIRST — paint every bad-colour pixel
 * magenta — and ask the detector to box that. The box then comes back around
 * the garment, and SAM runs on the ORIGINAL pixels inside it, so the mask is
 * built from real image content and never from the paint.
 *
 * Both a bare and a colour-anchored phrasing are asked, because the highlight
 * changes what the right question is.
 */
async function detectOnHighlighted(cropBuf, alpha, cw, ch, garmentKey, cfg) {
  const { data: raw } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const painted = Buffer.from(raw);
  const [hr, hg, hb] = cfg.highlightRGB;
  for (let i = 0; i < cw * ch; i++) {
    if (!alpha[i]) continue;
    painted[i * 3] = hr; painted[i * 3 + 1] = hg; painted[i * 3 + 2] = hb;
  }
  const paintedBuf = await sharp(painted, { raw: { width: cw, height: ch, channels: 3 } })
    .jpeg({ quality: 92 }).toBuffer();
  const paintedUri = toDataUri(paintedBuf);
  const queries = [
    `the magenta ${garmentKey} worn by the person`,
    `the magenta region`,
    ...(GARMENT_ENUM[garmentKey]?.queries || []),
  ];
  const multi = await detectGarmentBoxMulti(paintedUri, { ...cfg, queries, cropW: cw, cropH: ch });
  return { pick: multi.pick, tried: multi.tried, paintedBuf };
}

const { photoAnalyzerUrl: _photoAnalyzerUrl } = require('./photoAnalyzerClient');
const bytesOf = (input) => {
  if (Buffer.isBuffer(input)) return input;
  const m = String(input).match(/^data:[^;]+;base64,(.*)$/);
  return Buffer.from(m ? m[1] : String(input), 'base64');
};
const toDataUri = (buf) => 'data:image/jpeg;base64,' + buf.toString('base64');

/** Intersection-over-union of two pixel boxes [x1,y1,x2,y2]. */
function boxIoU(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const uni = areaA + areaB - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * Highest-scoring candidates that are NOT the same region.
 *
 * GroundingDINO happily returns several boxes over one object. Taking the top-N
 * raw would hand the agreement check two views of the same panel, which always
 * agree and therefore verify nothing. Overlapping candidates are suppressed so
 * the boxes that survive are, as far as geometry can tell, different panels.
 *
 * Pure — no I/O, unit-testable.
 * @param {Array<{box:number[],score:number}>} candidates any order
 * @returns {Array<{box:number[],score:number}>} highest score first
 */
function selectDistinctBoxes(candidates, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const maxBoxes = Math.max(1, cfg.avatarPanels | 0);
  const sorted = (Array.isArray(candidates) ? candidates : [])
    .filter(c => Array.isArray(c?.box) && c.box.length === 4)
    .slice()
    .sort((p, q) => (q.score ?? 0) - (p.score ?? 0));
  const out = [];
  for (const c of sorted) {
    if (out.length >= maxBoxes) break;
    if (out.some(o => boxIoU(o.box, c.box) > cfg.avatarPanelIoU)) continue;
    out.push({ box: c.box, score: c.score == null ? null : Number(c.score) });
  }
  return out;
}

/**
 * GroundingDINO: garment boxes inside a crop, pixel coords, best score first.
 *
 * The endpoint already returns every candidate for the query (photo_analyzer.py
 * /detect-figures-text -> figures[0].candidates, sorted by score); this used to
 * read only the best one and throw the rest away. No extra detector call is made
 * to get more than one box.
 */
async function detectGarmentBoxes(cropUri, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const res = await fetch(`${_photoAnalyzerUrl()}/detect-figures-text`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: cropUri,
      prompts: [{ name: 'garment', text: opts.prompt }],
      box_threshold: cfg.boxThreshold, text_threshold: cfg.textThreshold,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`detect-figures-text HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.success) throw new Error(`detect-figures-text: ${j?.error}`);
  const g = (j.figures || [])[0];
  if (!g?.box) return [];
  // Older analyzer builds answer without `candidates`; the best box is still there.
  const cands = Array.isArray(g.candidates) && g.candidates.length
    ? g.candidates : [{ box: g.box, score: g.score }];
  return selectDistinctBoxes(cands, cfg);
}

/** The single best garment box, or null — the page side's contract, unchanged. */
/**
 * Ask SEVERAL phrasings for the same garment and keep the most plausible box
 * (owner's idea, 2026-08-13).
 *
 * ONE PROMPT PER PASS, never one concatenated string. photo_analyzer.py runs a
 * separate forward pass per prompt entry, and its own comment records that
 * batching phrasings into a single text was tried and REVERTED — "multi-phrase
 * attention dilution collapsed scores and missed figures on non-photographic
 * styles". So `skirt / pants / lower body clothing` as one phrase is a known
 * failure; as three prompts it is three independent opinions.
 *
 * Selection is NOT by score. On job_1786571353564_0sgrd0f4g p4 the phrase
 * "the skirt worn by the person" returned the ENTIRE mermaid at score 0.51 —
 * a confident box around the wrong thing. A garment is a PART of a figure, so
 * any box covering more than `maxBoxFrac` of the figure crop is the figure
 * itself; those are discarded first, and the best score among what remains
 * wins. If every phrasing returns a figure-sized box, the detector has nothing
 * to say and the caller is told so.
 */
async function detectGarmentBoxMulti(cropUri, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const queries = opts.queries && opts.queries.length ? opts.queries : [opts.prompt];
  const cropArea = Math.max(1, (opts.cropW || 0) * (opts.cropH || 0));
  const askOne = async (text) => {
    const res = await fetch(`${_photoAnalyzerUrl()}/detect-figures-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: cropUri,
        prompts: [{ name: 'q', text }],
        box_threshold: cfg.boxThreshold, text_threshold: cfg.textThreshold,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`detect-figures-text HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.success) throw new Error(`detect-figures-text: ${j?.error}`);
    const f = (j.figures || [])[0];
    const box = f?.box || null;
    const area = box ? Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]) : null;
    return {
      query: text, box, score: f?.score == null ? null : +Number(f.score).toFixed(2),
      frac: area ? +(area / cropArea).toFixed(2) : null,
    };
  };
  // ESCALATION, not fan-out: ask one phrasing at a time and stop at the first box
  // that is plausibly a garment rather than the whole figure. Ordered
  // anatomical-first, so the common path costs ONE detector pass — the same as
  // the old single-phrase code — while keeping the recovery of asking three.
  const tried = [];
  for (const text of queries) {
    const t = await askOne(text);
    tried.push(t);
    if (t.box && t.frac != null && t.frac <= cfg.maxBoxFrac) {
      return { pick: t, tried, escalations: tried.length - 1 };
    }
  }
  return { pick: null, tried, escalations: tried.length - 1 };
}

async function detectGarmentBox(cropUri, opts = {}) {
  const boxes = await detectGarmentBoxes(cropUri, { ...opts, avatarPanels: 1 });
  return boxes[0] || null;
}

/** Straight L*a*b* distance between two measurements. */
function labDeltaE(p, q) {
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/**
 * The agreement decision for the avatar side — pure, so it is testable without
 * a detector, a segmenter or a network.
 *
 * Given the mean L*a*b* read off several panels of ONE styled sheet, return the
 * largest set of panels that all agree with each other within
 * `avatarAgreeDeltaE`, and their mean. Nothing else on this module can tell a
 * confidently WRONG measurement from a right one: exp 489 asked for a hat, the
 * box landed on brown boots, and a 0.35-confidence reading repainted a cream hat
 * brown without a single objection. A second panel would have said cream.
 *
 * A confidence floor is deliberately NOT the mechanism (decisions.md 2026-08-11):
 * a shoe or a hat is legitimately a small mask and DINO scores small objects
 * lower, so a floor refuses footwear and headwear disproportionately; the garment
 * "kind" table that could have made a floor size-aware was deleted on purpose;
 * and confidence has been measured unreliable here — every wrong figure naming on
 * staging page 14 was marked `high`.
 *
 * ONE panel is accepted and merely MARKED (`agreement: 'single'`), not refused.
 * This is deliberately provisional: refusing would regress every page where the
 * garment really is visible in one panel only, and we have no measurement of how
 * often that happens. The marker is what makes it measurable — tighten once the
 * runs say how common it is.
 *
 * The agreeing panels are averaged UNWEIGHTED: each panel is one vote on the
 * character's canonical colour, and a panel whose silhouette happens to be large
 * is not a better witness to the pigment.
 *
 * @param {Array<{L:number,a:number,b:number,count?:number}>} means one per panel
 * @returns {{mean:object|null, panelsMeasured:number, panelsAgreed:number,
 *            maxPairDeltaE:number|null, agreement:'none'|'single'|'agreed'|'disagree',
 *            reason:string|null}}
 */
function pickAgreeingPanels(means, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const T = cfg.avatarAgreeDeltaE;
  const list = (Array.isArray(means) ? means : [])
    .filter(m => m && Number.isFinite(m.L) && Number.isFinite(m.a) && Number.isFinite(m.b))
    // Subset enumeration below is 2^n; the caller never asks for more than
    // `avatarPanels` anyway, so this bound is a guard, not a policy.
    .slice(0, 10);
  const n = list.length;
  const describe = (m) => `L ${m.L.toFixed(0)}/hue ${(Math.atan2(m.b, m.a) * DEG).toFixed(0)}deg`;

  if (!n) {
    return {
      mean: null, panelsMeasured: 0, panelsAgreed: 0, maxPairDeltaE: null,
      agreement: 'none', reason: 'no avatar garment sample — no panel yielded a usable mask',
    };
  }
  if (n === 1) {
    return {
      mean: { ...list[0] }, panelsMeasured: 1, panelsAgreed: 1, maxPairDeltaE: null,
      agreement: 'single', reason: null,
    };
  }

  let best = null, worst = 0;
  for (let mask = 1; mask < (1 << n); mask++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    if (idx.length < 2) continue;
    let mx = 0, ok = true;
    for (let i = 0; i < idx.length && ok; i++) {
      for (let j = i + 1; j < idx.length; j++) {
        const d = labDeltaE(list[idx[i]], list[idx[j]]);
        if (idx.length === 2) worst = Math.max(worst, d);
        if (d > T) { ok = false; break; }
        if (d > mx) mx = d;
      }
    }
    if (!ok) continue;
    if (!best || idx.length > best.idx.length || (idx.length === best.idx.length && mx < best.mx)) {
      best = { idx, mx };
    }
  }

  if (!best) {
    return {
      mean: null, panelsMeasured: n, panelsAgreed: 0, maxPairDeltaE: +worst.toFixed(1),
      agreement: 'disagree',
      reason: `avatar panels disagree (max pair deltaE ${worst.toFixed(1)} > ${T}): ${list.map(describe).join(' vs ')}`,
    };
  }

  const k = best.idx.length;
  // `score` is carried through as the best of the AGREEING panels — reporting
  // the top candidate's score would credit the target to a panel that may have
  // been the one voted out.
  const scores = best.idx.map(i => list[i].score).filter(Number.isFinite);
  const mean = {
    L: best.idx.reduce((s, i) => s + list[i].L, 0) / k,
    a: best.idx.reduce((s, i) => s + list[i].a, 0) / k,
    b: best.idx.reduce((s, i) => s + list[i].b, 0) / k,
    count: best.idx.reduce((s, i) => s + (list[i].count || 0), 0),
    score: scores.length ? Math.max(...scores) : null,
  };
  return {
    mean, panelsMeasured: n, panelsAgreed: k, maxPairDeltaE: +best.mx.toFixed(1),
    agreement: 'agreed', reason: null,
  };
}

/** MobileSAM: box -> silhouette, as a 0/255 mask at the crop's size. */
async function segmentGarment(cropUri, box, w, h, prompts = null) {
  // `prompts` carries colour-derived point hints (1 = foreground, 0 =
  // background). A box alone cannot say "the robe, not the map it is behind";
  // points can. The endpoint has always accepted them — the garment path just
  // never sent any.
  const body = { image: cropUri, box };
  if (prompts?.points?.length) { body.points = prompts.points; body.point_labels = prompts.labels; }
  const res = await fetch(`${_photoAnalyzerUrl()}/figure-mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  if (!res.ok) throw new Error(`figure-mask HTTP ${res.status}`);
  const j = await res.json();
  if (!j?.success) throw new Error(`figure-mask: ${j?.error}`);
  const png = Buffer.from(String(j.image).replace(/^data:[^;]+;base64,/, ''), 'base64');
  const { data, info } = await sharp(png).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * info.channels + 3];
  return { alpha, pngBuf: png };
}

/**
 * Grow the garment mask outward into pixels that are still the GARMENT.
 *
 * SAM's silhouette tends to sit a pixel or two inside the true edge. When the
 * correction is large that leftover rim reads as an outline in the ORIGINAL
 * colour — an orange fringe around a shirt repainted yellow. Plain morphological
 * dilation would swallow skin and hair; gating each candidate on its distance to
 * the measured garment mean keeps the growth on-garment.
 *
 * The radius is deliberately small. On a red-haired character the hair sits ~6
 * ΔE from an orange shirt, so the colour gate ALONE cannot separate them — the
 * bound on how far the mask may travel is what does. Two guards, not one.
 *
 * Newly added pixels get full weight: they are garment, and a partial weight is
 * exactly what leaves a fringe. The soft edge now falls on the true boundary,
 * where neighbours are skin or background and the gate rejects them.
 *
 * @returns {{alpha: Buffer, added: number}}
 */
function dilateMaskByColour(alpha, raw, w, h, meanLab, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const out = Buffer.from(alpha);
  let added = 0;
  const dE2 = cfg.dilateDeltaE * cfg.dilateDeltaE;
  for (let ring = 0; ring < cfg.dilateRadius; ring++) {
    const frontier = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (out[i] > 8) continue;
      let touches = false;
      if (x > 0 && out[i - 1] > 8) touches = true;
      else if (x < w - 1 && out[i + 1] > 8) touches = true;
      else if (y > 0 && out[i - w] > 8) touches = true;
      else if (y < h - 1 && out[i + w] > 8) touches = true;
      if (!touches) continue;
      const l = _rgbToLab(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
      const d2 = (l[0] - meanLab.L) ** 2 + (l[1] - meanLab.a) ** 2 + (l[2] - meanLab.b) ** 2;
      if (d2 <= dE2) frontier.push(i);
    }
    if (!frontier.length) break;
    for (const i of frontier) { out[i] = 255; added++; }
  }
  return { alpha: out, added };
}

/** Mean L*a*b* over pixels whose mask alpha is above `thr`. */
function meanLabMasked(raw, alpha, thr = 128) {
  let sL = 0, sa = 0, sb = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] <= thr) continue;
    const l = _rgbToLab(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    sL += l[0]; sa += l[1]; sb += l[2]; n++;
  }
  return n ? { L: sL / n, a: sa / n, b: sb / n, count: n } : null;
}

/** Median L* of skin-looking pixels in a box — the illumination probe. */

/**
 * The canonical colour of ONE garment for a character, measured off the styled
 * avatar: DINO boxes -> SAM silhouettes -> mean L*a*b* of the masked pixels,
 * SEVERAL panels of the sheet, cross-checked against each other.
 * @returns {{target: object|null, reason: string|null}} target is null when the
 *   garment could not be located on the sheet, or when the panels that were
 *   located contradict each other — never a guessed region, never one
 *   unverifiable reading when the sheet offered a second opinion.
 */
async function avatarGarmentLab(avatarUri, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const buf = bytesOf(avatarUri);
  const meta = await sharp(buf).metadata();

  // SAME MACHINERY ON BOTH SIDES (owner, 2026-08-09). The page measures its
  // garment as DINO box -> SAM silhouette -> plain mean. The reference used to
  // measure it as DINO box -> RAW RECTANGLE -> chroma-weighted clustering, and
  // that asymmetry was the bug: a rectangle around a wide-brimmed hat also
  // contains background, white hair and skin, so the sample had to be rescued by
  // `sampleGarmentClusters`, which rejects near-grey pixels as "not garment".
  // A cream hat IS near-grey. Its own pixels were discarded and the dominant
  // saturated cluster left in the rectangle — brown — was returned as the
  // target, turning a correct cream hat brown (job_1786287569165, Lab exp 485).
  //
  // Any low-chroma garment hits this: white, cream, black, grey. Tops were not
  // exempt — the torso band is the same impure-crop heuristic, so Hans's cream
  // shirt would have measured as his blue sash.
  //
  // With a true silhouette the crop is pure, so the mean needs no rescuing and
  // the grey rejection can go.
  //
  // The torso band that used to catch DINO/SAM failures went with the kind
  // table. It was only ever valid for a TORSO garment, and without the table
  // there is no longer any claim that this garment is one — falling back would
  // mean measuring a shoe against a chest. It also carried the very low-chroma
  // blind spot described above. Refuse and record instead: every wrong recolour
  // seen so far came from a confident wrong target, never from a missing one.
  //
  // SELF-VERIFYING BY CROSS-PANEL AGREEMENT (owner, 2026-08-11). One box, one
  // mask, one mean is a measurement with nothing to check it against, and it can
  // be confidently wrong: exp 489 asked for the hat, the box landed on brown
  // boots, and the correct cream hat was repainted brown at DINO 0.35 with no
  // objection anywhere. The sheet is 2x4 panels of the SAME character, so the
  // garment is on it several times — take up to `avatarPanels` distinct boxes
  // from the candidates the detector ALREADY returned (no second DINO call), mask
  // each with SAM (local, free), and require the readings to agree. See
  // pickAgreeingPanels for why this is agreement and not a confidence floor.
  const prompt = opts.prompt;
  if (!prompt) return { target: null, reason: 'no garment query for the avatar side' };
  try {
    const sheetUri = toDataUri(await sharp(buf).jpeg({ quality: 95 }).toBuffer());
    const dets = await detectGarmentBoxes(sheetUri, { ...cfg, prompt });
    if (!dets.length) {
      const reason = 'DINO found no such garment on the sheet — no target';
      log.warn(`[GARMENT-COLOUR] avatar "${opts.garmentKey}": ${reason}`);
      return { target: null, reason };
    }
    // Boxes are in sheet coords and segmentGarment returns the mask at sheet
    // size, so no extract/offset juggling — same call shape as the page side.
    const { data } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const panels = [];
    let tooSmall = 0;
    for (const det of dets) {
      const seg = await segmentGarment(sheetUri, det.box, meta.width, meta.height);
      const m = meanLabMasked(data, seg.alpha);
      // minAvatarMaskPx is per panel, unchanged: a panel below it is not a
      // sample, and a bad sample must not get a vote.
      if (m && m.count >= cfg.minAvatarMaskPx) panels.push({ ...m, score: det.score });
      else tooSmall++;
    }
    const pick = pickAgreeingPanels(panels, cfg);
    if (!pick.mean) {
      const reason = pick.reason + (tooSmall ? ` (${tooSmall} panel(s) below ${cfg.minAvatarMaskPx}px)` : '');
      log.warn(`[GARMENT-COLOUR] avatar "${opts.garmentKey}": ${reason}`);
      return { target: null, reason };
    }
    const m = pick.mean;
    if (pick.agreement === 'single') {
      log.info(`[GARMENT-COLOUR] avatar "${opts.garmentKey}": only one panel located — accepted unverified (provisional)`);
    }
    return {
      target: {
        L: m.L, a: m.a, b: m.b,
        chroma: Math.hypot(m.a, m.b),
        hueDeg: +(Math.atan2(m.b, m.a) * DEG).toFixed(1),
        source: `sam:${opts.garmentKey || 'garment'}`,
        maskPx: m.count,
        dinoScore: m.score == null ? null : +Number(m.score).toFixed(2),
        panelsMeasured: pick.panelsMeasured,
        panelsAgreed: pick.panelsAgreed,
        maxPairDeltaE: pick.maxPairDeltaE,
        agreement: pick.agreement,
      },
      reason: null,
    };
  } catch (e) {
    const reason = `segmentation failed: ${e.message}`;
    log.warn(`[GARMENT-COLOUR] avatar "${opts.garmentKey}" ${reason} — no target`);
    return { target: null, reason };
  }
}


/**
 * Repair ONE figure's garment colour on a page.
 *
 * @param {string|Buffer} pageImageData
 * @param {object} figure   detection figure: { name, bodyBox, faceBox }
 * @param {string} avatarUri styled avatar for this page's clothing category
 * @param {object} options  { opts, collectSteps }
 * @returns {Promise<{changed, imageData, report, steps}>}
 */
async function fixFigureGarmentColour(pageImageData, figure, avatarUri, options = {}) {
  require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('garment_colour_fix_run');
  const cfg = { ...DEFAULTS, ...(options.opts || {}) };
  const t0 = Date.now();
  const { key: garmentKey, prompt } = garmentQueryFor(options.garment);
  // The colour the evaluator says the garment currently IS. Drives both the
  // point prompts and the verification gate below.
  const observedRef = resolveColourName(options.observedColour);
  if (options.observedColour && !observedRef) {
    log.warn(`[GARMENT-COLOUR] observedColour "${options.observedColour}" resolves to no known colour — proceeding without the colour gate`);
  }
  const report = { name: figure?.name || 'figure', garment: options.garment || null, garmentKey, applied: false, reason: null };
  if (!garmentKey) {
    report.reason = 'no garment named — refusing to guess which garment to recolour';
    return { changed: false, imageData: pageImageData, report, steps: [] };
  }
  const pageBuf = bytesOf(pageImageData);
  const meta = await sharp(pageBuf).metadata();
  const W = meta.width, H = meta.height;
  const steps = [];

  const { target, reason: targetReason } = await avatarGarmentLab(avatarUri, { ...cfg, garmentKey, prompt });
  if (!target) { report.reason = targetReason || 'no avatar garment sample'; return { changed: false, imageData: pageImageData, report, steps }; }
  // maskPx/dinoScore are the AVATAR side's own confidence. Without them a
  // mislocated target is invisible: `dinoScore` on the report is the PAGE box,
  // and exp 485 passed every page-side check while the target was measured off
  // the wrong garment entirely.
  report.target = {
    L: +target.L.toFixed(1), hueDeg: target.hueDeg, chroma: +target.chroma.toFixed(1),
    source: target.source,
    maskPx: target.maskPx ?? null,
    dinoScore: target.dinoScore ?? null,
    // How many panels of the sheet backed this target, and how far apart they
    // were. A 'single' here is an unverified reading, deliberately allowed.
    panelsMeasured: target.panelsMeasured ?? null,
    panelsAgreed: target.panelsAgreed ?? null,
    maxPairDeltaE: target.maxPairDeltaE ?? null,
    agreement: target.agreement ?? null,
  };

  // Crop to the figure so the garment query has one unambiguous referent — a
  // whole-page "shirt" query on a multi-figure page returns person-sized boxes.
  const bb = figure.bodyBox;
  if (!Array.isArray(bb)) { report.reason = 'no bodyBox'; return { changed: false, imageData: pageImageData, report, steps }; }
  const x0 = Math.max(0, Math.round((bb[1] - cfg.cropPad) * W)), y0 = Math.max(0, Math.round((bb[0] - cfg.cropPad) * H));
  const x1 = Math.min(W, Math.round((bb[3] + cfg.cropPad) * W)), y1 = Math.min(H, Math.round((bb[2] + cfg.cropPad) * H));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < 16 || ch < 16) { report.reason = 'figure box too small'; return { changed: false, imageData: pageImageData, report, steps }; }
  const cropBuf = await sharp(pageBuf).extract({ left: x0, top: y0, width: cw, height: ch }).jpeg({ quality: 95 }).toBuffer();
  const cropUri = toDataUri(cropBuf);

  // The figure's face box in CROP coordinates — the colour selector needs it to
  // find this character's own skin and to fence off the hair.
  const faceBoxCrop = Array.isArray(figure?.faceBox) ? [
    Math.round(figure.faceBox[1] * W) - x0, Math.round(figure.faceBox[0] * H) - y0,
    Math.round(figure.faceBox[3] * W) - x0, Math.round(figure.faceBox[2] * H) - y0,
  ] : null;
  const { data: cropRawEarly } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mode = cfg.maskMode;
  report.maskMode = mode;

  let det = null, seg = null, colourSel = null;
  const needsDetector = mode === 'dino-sam' || mode === 'dino-sam-points' || mode === 'intersect';
  try {
    if (needsDetector) {
      if (cfg.queryMode === 'multi') {
        const multi = await detectGarmentBoxMulti(cropUri, {
          ...cfg, prompt, queries: GARMENT_ENUM[garmentKey]?.queries, cropW: cw, cropH: ch,
        });
        report.queriesTried = multi.tried;
        report.queryEscalations = multi.escalations;
        det = multi.pick ? { box: multi.pick.box, score: multi.pick.score } : null;
        report.queryPicked = multi.pick?.query || null;
        if (!det) {
          report.reason = `every phrasing for "${garmentKey}" returned a figure-sized box `
            + `(${multi.tried.map(t => `${t.frac ?? '-'}`).join(', ')} of the crop) — the detector cannot locate this garment`;
          return { changed: false, imageData: pageImageData, report, steps };
        }
      } else {
        det = await detectGarmentBox(cropUri, { ...cfg, prompt });
      }
      if (!det) { report.reason = `DINO found no "${garmentKey}" on the page`; return { changed: false, imageData: pageImageData, report, steps }; }
      const pts = mode === 'dino-sam-points'
        ? deriveColourPoints(cropRawEarly, cw, ch, det.box, observedRef, cfg)
        : { points: null, labels: null, fg: 0, bg: 0 };
      report.colourPoints = { fg: pts.fg, bg: pts.bg, from: observedRef?.name || null };
      seg = await segmentGarment(cropUri, det.box, cw, ch, pts);
      report.dinoScore = +Number(det.score).toFixed(2);
      report.dinoBox = Array.isArray(det.box) ? det.box.map(v => Math.round(v)) : null;
      report.dinoBoxPx = report.dinoBox
        ? Math.max(0, (report.dinoBox[2] - report.dinoBox[0])) * Math.max(0, (report.dinoBox[3] - report.dinoBox[1]))
        : null;
    }
    if (mode === 'highlight-dino' || mode === 'colour-box-sam') {
      // Both start from the same colour selection, cleaned to whole connected
      // regions: a speckle of eye-glint would drag a bounding box across the
      // whole face, and a highlight made of confetti is not something a
      // detector can box.
      const sel0 = selectBadColourPixels(cropRawEarly, cw, ch,
        { ref: observedRef, cfg, garmentKey, faceBoxCrop });
      if (!sel0.count) {
        report.reason = sel0.reason || `no pixel in the ${garmentKey} region is ${observedRef?.name || 'the reported colour'}`;
        return { changed: false, imageData: pageImageData, report, steps };
      }
      const cc = cfg.connectedOnly ? keepConnectedComponents(sel0.alpha, cw, ch, cfg)
        : { alpha: sel0.alpha, count: sel0.count, components: null, kept: null, sizes: [] };
      report.colourSelect = {
        px: sel0.count, connectedPx: cc.count, components: cc.components,
        kept: cc.kept, sizes: cc.sizes, from: observedRef?.name || null,
      };
      if (!cc.count) {
        report.reason = `every bad-colour region is smaller than ${cfg.minComponentPx}px — speckle, not a garment`;
        return { changed: false, imageData: pageImageData, report, steps };
      }
      if (mode === 'colour-box-sam') {
        const box = maskBoundingBox(cc.alpha, cw, ch, cfg.highlightPadPx);
        report.dinoBox = box;
        report.dinoBoxPx = box ? (box[2] - box[0]) * (box[3] - box[1]) : null;
        report.boxFrom = 'bad-colour pixels';
        seg = await segmentGarment(cropUri, box, cw, ch);
      } else {
        const hi = await detectOnHighlighted(cropBuf, cc.alpha, cw, ch, garmentKey, cfg);
        report.queriesTried = hi.tried;
        report.queryPicked = hi.pick?.query || null;
        report.boxFrom = 'DINO on the highlighted image';
        if (options.collectSteps) {
          steps.push({ label: `${report.name} HIGHLIGHTED — bad-colour pixels painted magenta, then sent to DINO`,
            data: toDataUri(hi.paintedBuf) });
        }
        if (!hi.pick) {
          report.reason = `DINO found no boxable region even after highlighting `
            + `(${hi.tried.map(t => t.frac ?? '-').join(', ')} of the crop)`;
          return { changed: false, imageData: pageImageData, report, steps };
        }
        report.dinoBox = hi.pick.box.map(v => Math.round(v));
        report.dinoBoxPx = (hi.pick.box[2] - hi.pick.box[0]) * (hi.pick.box[3] - hi.pick.box[1]);
        report.dinoScore = hi.pick.score;
        // SAM runs on the ORIGINAL crop — the paint is only how the box was found.
        seg = await segmentGarment(cropUri, hi.pick.box, cw, ch);
      }
    } else if (mode === 'colour' || mode === 'intersect') {
      colourSel = selectBadColourPixels(cropRawEarly, cw, ch,
        { ref: observedRef, cfg, garmentKey, faceBoxCrop });
      report.colourSelect = {
        px: colourSel.count, from: observedRef?.name || null,
        skin: colourSel.skin ? {
          L: +colourSel.skin.L.toFixed(1), a: +colourSel.skin.a.toFixed(1), b: +colourSel.skin.b.toFixed(1),
        } : null,
        reason: colourSel.reason,
      };
      if (!colourSel.count) {
        report.reason = colourSel.reason || `no pixel in the ${garmentKey} region is ${observedRef?.name || 'the reported colour'}`;
        return { changed: false, imageData: pageImageData, report, steps };
      }
      if (mode === 'colour') {
        const cc = cfg.connectedOnly ? keepConnectedComponents(colourSel.alpha, cw, ch, cfg)
          : { alpha: colourSel.alpha, count: colourSel.count, components: null, kept: null, sizes: [] };
        report.colourSelect.connectedPx = cc.count;
        report.colourSelect.components = cc.components;
        report.colourSelect.sizes = cc.sizes;
        if (!cc.count) {
          report.reason = `every bad-colour region is smaller than ${cfg.minComponentPx}px — speckle, not a garment`;
          return { changed: false, imageData: pageImageData, report, steps };
        }
        seg = { alpha: cc.alpha };
      } else {
        // INTERSECT: the detector says where, the colour says which pixels.
        const a = Buffer.alloc(cw * ch);
        let n = 0;
        for (let i = 0; i < cw * ch; i++) {
          if (seg.alpha[i] > 8 && colourSel.alpha[i]) { a[i] = seg.alpha[i]; n++; }
        }
        report.intersectPx = n;
        if (!n) {
          report.reason = 'detector mask and bad-colour selection do not overlap';
          return { changed: false, imageData: pageImageData, report, steps };
        }
        seg = { alpha: a };
      }
    }
  } catch (e) {
    report.reason = `segmentation failed: ${e.message}`;
    return { changed: false, imageData: pageImageData, report, steps };
  }
  report.cropPx = cw * ch;

  const { data: cropRaw } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let cur = meanLabMasked(cropRaw, seg.alpha);
  // Grow the mask onto the rim SAM left behind, then re-measure from the full
  // garment so the target offset is computed against every pixel it will touch.
  if (mode !== 'colour' && cur && cur.count >= cfg.minMaskPx && cfg.dilateRadius > 0) {
    const grown = dilateMaskByColour(seg.alpha, cropRaw, cw, ch, cur, cfg);
    if (grown.added) {
      seg.alpha = grown.alpha;
      report.maskDilated = grown.added;
      cur = meanLabMasked(cropRaw, seg.alpha) || cur;
    }
  }
  if (!cur || cur.count < cfg.minMaskPx) { report.reason = `garment mask too small (${cur?.count || 0}px)`; return { changed: false, imageData: pageImageData, report, steps }; }
  report.current = { L: +cur.L.toFixed(1), hueDeg: +(Math.atan2(cur.b, cur.a) * DEG).toFixed(1), chroma: +Math.hypot(cur.a, cur.b).toFixed(1), px: cur.count };

  // VERIFICATION GATE. The evaluator said what colour this garment IS; if the
  // mask is not that colour, the mask is not the garment. Refuse before moving
  // a single pixel — this is the check that catches a mask the per-pixel gate
  // cannot, because that one scores pixels against the mask's own mean and so
  // defends whatever object dominates it.
  // OPTIONAL SECOND OPINION FROM A VISION MODEL. Every other check reasons about
  // colour or geometry and can be fooled by a self-consistently wrong mask.
  if (cfg.verifyMask === 'model') {
    const ask = await askIsThisTheGarment(cropBuf, seg.alpha, cw, ch, garmentKey, cfg);
    report.maskAsk = { asked: ask.asked, isGarment: ask.isGarment ?? null, whatItIs: ask.whatItIs || null, reason: ask.reason || null };
    if (options.collectSteps && ask.overlay) {
      steps.push({
        label: `${report.name} ASKED THE MODEL — "is the highlighted region the ${garmentKey}?" → `
          + (ask.asked ? `${ask.isGarment ? 'YES' : 'NO'}${ask.whatItIs ? ` (it is: ${ask.whatItIs})` : ''}` : `not asked (${ask.reason})`),
        data: toDataUri(ask.overlay),
      });
    }
    if (ask.asked && ask.isGarment === false) {
      report.reason = `a vision model says the marked pixels are not the ${garmentKey}`
        + (ask.whatItIs ? ` — it sees ${ask.whatItIs}` : '');
      log.warn(`⚠️ [GARMENT-COLOUR] ${report.name} ${garmentKey}: ${report.reason} — refusing to repaint`);
      return { changed: false, imageData: pageImageData, report, steps };
    }
  }

  const verdict = maskMatchesObservedColour(cur, observedRef, cfg);
  report.observedColour = options.observedColour || null;
  report.observedMatch = verdict.ok;
  report.observedHueDelta = verdict.hueDelta;
  if (!verdict.ok) {
    report.reason = `mask does not match the reported colour: ${verdict.reason}`;
    log.warn(`⚠️ [GARMENT-COLOUR] ${report.name} ${garmentKey}: ${report.reason} — refusing to repaint`);
    return { changed: false, imageData: pageImageData, report, steps };
  }

  // NO LIGHTING FACTOR (owner, 2026-08-15). This used to scale the target L* by
  // page-skin-L / avatar-skin-L, and that ratio measured at least four things
  // at once while being reported as illumination:
  //   1. actual scene lighting  — the only one intended
  //   2. the character's skin tone as rendered on that page
  //   3. hair, collar, glasses, shadow and background inside the face box —
  //      "skin" was never detected, it was every pixel the GARMENT test rejects,
  //      inside a face box that is padded down to the chest
  //   4. ART STYLE. On the watercolour pirate page (Test Lab #432) it measured
  //      0.73 from page skin L 60.9 vs avatar sheet L 83.7 — a painted page
  //      against a bright studio sheet, no illumination difference at all — and
  //      dragged Emma's top from L 73 to L 60, muddy.
  //
  // A page-level probe has the same disease in a new place: a night scene and a
  // dark watercolour both read "dark", so median page L cannot separate
  // illumination from medium either. The only signal that could is a DECLARED
  // one, and no such field exists — sceneMetadata has 25 keys and not one about
  // lighting or time of day, and the Art Director's prose mentions it only in
  // passing, if at all. Adding `timeOfDay` to the scene-expansion schema is a
  // prompt-and-schema decision, not something to bolt on here.
  //
  // So the factor is gone rather than retuned. The target already comes from the
  // character's own styled avatar, maxDeltaL still bounds how far a repaint may
  // move, and maskMatchesObservedColour still refuses outright when the mask is
  // not the colour the report claims.
  const lighting = 1;
  report.lighting = 1;
  report.lightingSource = 'none (see garmentColourFix: no lighting factor)';

  // Target scaled by lighting: only L* is illumination-dependent this way; the
  // hue and chroma of the pigment do not change with light level.
  const cap = (v, m) => Math.max(-m, Math.min(m, v));
  const targetL = target.L * lighting;
  const dL = cap(targetL - cur.L, cfg.maxDeltaL);
  const da = cap(target.a - cur.a, cfg.maxDeltaAB);
  const db = cap(target.b - cur.b, cfg.maxDeltaAB);
  const deltaE = Math.hypot(dL, da, db);
  report.delta = { L: +dL.toFixed(1), a: +da.toFixed(1), b: +db.toFixed(1), deltaE: +deltaE.toFixed(1) };
  if (deltaE < cfg.minDeltaE) {
    report.reason = `already on colour (ΔE ${deltaE.toFixed(1)} < ${cfg.minDeltaE})`;
    return { changed: false, imageData: pageImageData, report, steps };
  }

  // Apply inside the crop, weighted by the SAM alpha (free feathered edge).
  const out = Buffer.from(cropRaw);
  // Diagnostic overlay: the crop tinted by the weight each pixel ACTUALLY
  // received. A bare SAM silhouette is white-on-transparent, which composites
  // invisibly onto the summary card's white canvas AND says nothing about the
  // colour gate — so a reviewer could not tell whether a stray arm was inside
  // the mask or merely gated out. Tinting by the final weight answers both.
  const overlay = options.collectSteps ? Buffer.from(cropRaw) : null;
  const soft = cfg.applyDeltaESoft, hard = Math.max(cfg.applyDeltaESoft + 1, cfg.applyDeltaEHard);
  let gated = 0;
  for (let i = 0; i < cw * ch; i++) {
    const a8 = seg.alpha[i];
    if (a8 <= 8) continue;
    const l = _rgbToLab(cropRaw[i * 3], cropRaw[i * 3 + 1], cropRaw[i * 3 + 2]);
    // How far is THIS pixel from the garment colour we measured? Skin caught by
    // a slightly generous silhouette sits far out and must not take the offset.
    const d = Math.hypot(l[0] - cur.L, l[1] - cur.a, l[2] - cur.b);
    let wColour = 1;
    if (d >= hard) {
      gated++;
      // Inside the mask but rejected on colour — mark it CYAN so an over-eager
      // silhouette is visibly distinct from a garment that simply moved.
      if (overlay) { overlay[i * 3] = 0; overlay[i * 3 + 1] = 210; overlay[i * 3 + 2] = 210; }
      continue;
    }
    if (d > soft) wColour = (hard - d) / (hard - soft);
    const w = Math.min(1, a8 / 255) * wColour;
    const rgb = _labToRgb(l[0] + w * dL, l[1] + w * da, l[2] + w * db);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
    if (overlay) {
      // Magenta at full weight, fading to the original where the weight tails off.
      overlay[i * 3] = Math.round(cropRaw[i * 3] * (1 - w) + 255 * w);
      overlay[i * 3 + 1] = Math.round(cropRaw[i * 3 + 1] * (1 - w));
      overlay[i * 3 + 2] = Math.round(cropRaw[i * 3 + 2] * (1 - w) + 255 * w);
    }
  }
  if (gated) report.colourGated = gated;
  const fixedCrop = await sharp(out, { raw: { width: cw, height: ch, channels: 3 } }).png().toBuffer();
  const merged = await sharp(pageBuf).composite([{ input: fixedCrop, left: x0, top: y0 }]).jpeg({ quality: 95 }).toBuffer();

  if (options.collectSteps) {
    steps.push({ label: `${report.name} BEFORE (${report.current.hueDeg}°, L ${report.current.L})`, data: toDataUri(cropBuf) });
    // The DINO box SAM was prompted with, drawn on the same crop — so "wrong box"
    // and "mask escaped a good box" are distinguishable at a glance.
    if (report.dinoBox) {
      const [bx1, by1, bx2, by2] = report.dinoBox;
      const boxSvg = Buffer.from(
        `<svg width="${cw}" height="${ch}"><rect x="${bx1}" y="${by1}" width="${Math.max(1, bx2 - bx1)}" `
        + `height="${Math.max(1, by2 - by1)}" fill="none" stroke="#00e5ff" stroke-width="5"/></svg>`);
      steps.push({
        label: `${report.name} DINO BOX for "${garmentKey}" — score ${report.dinoScore}, `
          + `${Math.round(100 * report.dinoBoxPx / report.cropPx)}% of the crop`,
        data: toDataUri(await sharp(cropBuf).composite([{ input: boxSvg }]).jpeg({ quality: 92 }).toBuffer()),
      });
    }
    const overlayJpg = await sharp(overlay, { raw: { width: cw, height: ch, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    steps.push({
      label: `${report.name} MASK — magenta = moved, cyan = gated (DINO ${report.dinoScore} → SAM, ${cur.count}px${gated ? `, ${gated} gated` : ''})`,
      data: toDataUri(overlayJpg),
    });
    steps.push({ label: `${report.name} AFTER (→ ${target.hueDeg}°, L ${targetL.toFixed(0)})`, data: toDataUri(await sharp(fixedCrop).jpeg({ quality: 95 }).toBuffer()) });
  }
  report.applied = true;
  report.elapsedMs = Date.now() - t0;
  log.info(`🎨 [GARMENT-COLOUR] ${report.name}: ${report.current.hueDeg}°→${target.hueDeg}° L ${report.current.L}→${targetL.toFixed(0)} (ΔE ${deltaE.toFixed(1)}, lighting ×${lighting.toFixed(2)}, DINO ${report.dinoScore}, ${cur.count}px, ${report.elapsedMs}ms)`);
  return { changed: true, imageData: toDataUri(merged), report, steps };
}

module.exports = {
  fixFigureGarmentColour,
  garmentQueryFor,
  GARMENT_ENUM,
  GARMENT_VALUES,
  GARMENT_REGION,
  selectBadColourPixels,
  figureSkinLab,
  keepConnectedComponents,
  maskBoundingBox,
  detectOnHighlighted,
  COLOUR_REFS,
  resolveColourName,
  maskMatchesObservedColour,
  deriveColourPoints,
  DEFAULTS,
  garmentEnumForPrompt,
  avatarGarmentLab,
  detectGarmentBox,
  detectGarmentBoxMulti,
  detectGarmentBoxes,
  selectDistinctBoxes,
  pickAgreeingPanels,
  boxIoU,
  labDeltaE,
  segmentGarment,
  meanLabMasked,
  dilateMaskByColour,
  DEFAULTS,
};
