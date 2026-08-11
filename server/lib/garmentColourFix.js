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
 * The GroundingDINO query for a garment, plus the key that identifies it.
 *
 * NO TRANSLATION TABLE (owner, 2026-08-09). This used to map the entity
 * channel's word onto one of six canned prompts with an unconditional `'top'`
 * at the end of the chain — and `top` selected the avatar's TORSO, so an
 * unrecognised word did not merely pick a wrong prompt, it aimed the repair at
 * the wrong part of the body. Both failure modes hit one page of
 * job_1786287569165_7f75jspcz: "breeches" became `top` and legwear was matched
 * to the chest; "sash" became `top` as well, colliding with breeches on the
 * caller's dedupe key, so the sash vanished with NO outcome recorded at all.
 *
 * The table is deleted rather than extended. GroundingDINO is open-vocabulary,
 * so "the breeches worn by the person" is already a valid query — mapping it to
 * "the trousers or shorts worn by the person" was not just unnecessary, it threw
 * away the specific word the entity check handed us and substituted a wrong one.
 * Breeches never failed because DINO cannot find breeches; they failed because
 * we replaced the word "breeches" with the word "shirt".
 *
 * (The deleted table also carried a latent defect: a stray 0x08 byte had been
 * written into the headwear pattern where `\b` was intended, so "hood" never
 * matched headwear either and fell through to `top` like the rest.)
 *
 * Passing the word through also makes the two sides symmetric by construction:
 * page and avatar are asked the SAME question, the property the SAM change
 * established for segmentation.
 *
 * `key` is the normalised word and is what the caller dedupes on, so two
 * distinct garments can never collapse into one entry and disappear.
 *
 * @returns {{key: string|null, prompt: string|null}} key is null when there is
 *   no garment word at all; the caller records that refusal.
 */
function garmentQueryFor(garment) {
  const key = String(garment == null ? '' : garment)
    .toLowerCase().replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return { key: null, prompt: null };
  return { key, prompt: `the ${key} worn by the person` };
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
async function segmentGarment(cropUri, box, w, h) {
  const res = await fetch(`${_photoAnalyzerUrl()}/figure-mask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: cropUri, box }),
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
function medianSkinL(raw, W, H, box01) {
  if (!Array.isArray(box01) || box01.length !== 4) return null;
  const y0 = Math.max(0, Math.round(box01[0] * H)), x0 = Math.max(0, Math.round(box01[1] * W));
  const y1 = Math.min(H, Math.round(box01[2] * H)), x1 = Math.min(W, Math.round(box01[3] * W));
  const Ls = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    const r = raw[i * 3], g = raw[i * 3 + 1], b = raw[i * 3 + 2];
    // Skin is exactly what isGarmentPixel REJECTS in the warm band — invert it.
    if (isGarmentPixel(r, g, b)) continue;
    const l = _rgbToLab(r, g, b);
    if (l[0] < 15 || l[0] > 96) continue; // crushed black / blown white carry no signal
    Ls.push(l[0]);
  }
  if (Ls.length < 50) return null;
  Ls.sort((p, q) => p - q);
  return Ls[Math.floor(Ls.length / 2)];
}

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

  let det = null, seg = null;
  try {
    det = await detectGarmentBox(cropUri, { ...cfg, prompt });
    if (!det) { report.reason = `DINO found no "${garmentKey}" on the page`; return { changed: false, imageData: pageImageData, report, steps }; }
    seg = await segmentGarment(cropUri, det.box, cw, ch);
  } catch (e) {
    report.reason = `segmentation failed: ${e.message}`;
    return { changed: false, imageData: pageImageData, report, steps };
  }
  report.dinoScore = +Number(det.score).toFixed(2);

  const { data: cropRaw } = await sharp(cropBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let cur = meanLabMasked(cropRaw, seg.alpha);
  // Grow the mask onto the rim SAM left behind, then re-measure from the full
  // garment so the target offset is computed against every pixel it will touch.
  if (cur && cur.count >= cfg.minMaskPx && cfg.dilateRadius > 0) {
    const grown = dilateMaskByColour(seg.alpha, cropRaw, cw, ch, cur, cfg);
    if (grown.added) {
      seg.alpha = grown.alpha;
      report.maskDilated = grown.added;
      cur = meanLabMasked(cropRaw, seg.alpha) || cur;
    }
  }
  if (!cur || cur.count < cfg.minMaskPx) { report.reason = `garment mask too small (${cur?.count || 0}px)`; return { changed: false, imageData: pageImageData, report, steps }; }
  report.current = { L: +cur.L.toFixed(1), hueDeg: +(Math.atan2(cur.b, cur.a) * DEG).toFixed(1), chroma: +Math.hypot(cur.a, cur.b).toFixed(1), px: cur.count };

  // Lighting factor from skin: page face vs avatar face, same material.
  let lighting = 1, lightingSource = 'default';
  try {
    const { data: pageRaw } = await sharp(pageBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pageSkinL = medianSkinL(pageRaw, W, H, figure.faceBox);
    const abuf = bytesOf(avatarUri);
    const am = await sharp(abuf).metadata();
    const { data: avRaw } = await sharp(abuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Avatar head cells occupy the top band of the sheet.
    const avSkinL = medianSkinL(avRaw, am.width, am.height, [0, 0, 0.45, 1]);
    if (pageSkinL && avSkinL) {
      const f = pageSkinL / avSkinL;
      if (f >= cfg.lightingMin && f <= cfg.lightingMax) { lighting = f; lightingSource = 'skin'; }
      else { lightingSource = `skin out of range (${f.toFixed(2)})`; }
      report.skin = { page: +pageSkinL.toFixed(1), avatar: +avSkinL.toFixed(1) };
    }
  } catch { /* lighting probe is advisory; 1.0 is a safe default */ }
  report.lighting = +lighting.toFixed(2);
  report.lightingSource = lightingSource;

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
  avatarGarmentLab,
  detectGarmentBox,
  detectGarmentBoxes,
  selectDistinctBoxes,
  pickAgreeingPanels,
  boxIoU,
  labDeltaE,
  segmentGarment,
  medianSkinL,
  meanLabMasked,
  dilateMaskByColour,
  DEFAULTS,
};
