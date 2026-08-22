'use strict';

/**
 * ArcFace identity scoring — an objective second opinion on avatar likeness.
 *
 * WHY: the Gemini face-match judge grades its own output and, measured across
 * 102 real avatars, sits at 7-9/10 across the ENTIRE quality range. It cannot
 * separate "barely recognisable" from "near-identical", and it passed an avatar
 * that renders a teenager as a ~30-year-old man at 7/10. Avatars are reused on
 * every page of a book, so one bad sheet costs a whole story's illustrations.
 *
 * ArcFace cosine is independent of the generator, costs no API money (it runs in
 * the local Python service), and disagrees with the judge exactly where it
 * matters: that same avatar scores 0.089, the worst of 102.
 *
 * Full evidence and the calibration: docs/decisions.md, 2026-08-22.
 */

const { log } = require('../utils/logger');

const BASE = () => process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

/**
 * Gate threshold (owner's call, 2026-08-22). On the measured corpus this flags
 * 6 of 102 avatars — 5 of 37 real users.
 *
 * KNOWN FALSE POSITIVE: extreme expressions. A child photographed mid-shout
 * scores 0.384 with a perfectly good avatar. Regenerating cannot fix that,
 * because the fault is in the SOURCE photo, so anything acting on this score
 * must cap its retries and ship the best attempt regardless.
 */
const ARCFACE_MIN = Number(process.env.ARCFACE_MIN_SCORE || 0.45);

// Only the two HEAD cells of the 2x2 sheet are comparable. The bottom row is
// full-body: the head is a small part of a 360x640 crop, and one cell is a pure
// profile that a frontal-biased model cannot embed at all (measured 0.028 on a
// sheet whose head cells scored 0.79 and 0.70).
const HEAD_QUADRANTS = ['top-left', 'top-right'];

async function analyzerPost(endpoint, body, timeoutMs = 60000) {
  const res = await fetch(`${BASE()}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${json?.error || 'no body'}`);
  return json;
}

const asDataUri = (img) => (String(img).startsWith('data:') ? img : `data:image/jpeg;base64,${img}`);

/**
 * Embed a face. The embedder does its own detection AND 5-point alignment, so
 * callers must NOT pre-crop: ArcFace compares faces warped to a canonical
 * 112x112, and a pre-crop that clips the mouth removes two of the five
 * landmarks the warp needs (measured: a good likeness fell to 0.027 unaligned
 * and to 0.205 when pre-cropped; 0.613 when left alone).
 * Returns null when no face is found — never a score.
 */
async function embed(image, quadrant) {
  const r = await analyzerPost('/face-embedding', {
    image: asDataUri(image),
    ...(quadrant ? { quadrant } : {}),
    extract_face: true,
  });
  if (!Array.isArray(r.embedding) || r.faceDetected === false) return null;
  return r.embedding;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/**
 * Score an avatar sheet against the source photo.
 *
 * @param {string} photo       source face photo (data URI or bare base64)
 * @param {string} sheetImage  the generated 2x2 avatar sheet
 * @returns {Promise<{score:number|null, cells:object, unavailable?:string}>}
 *
 * FAILS OPEN. If the Python service is down, or no face can be found, `score`
 * is null and the caller must treat that as "no opinion" — never as a failure.
 * Avatar creation must not break because a quality probe is unavailable.
 */
async function scoreAvatarLikeness(photo, sheetImage) {
  try {
    const photoEmb = await embed(photo);
    if (!photoEmb) return { score: null, cells: {}, unavailable: 'no face in source photo' };

    const cells = {};
    let best = null;
    for (const q of HEAD_QUADRANTS) {
      try {
        const e = await embed(sheetImage, q);
        if (!e) { cells[q] = null; continue; }
        const sim = cosine(photoEmb, e);
        cells[q] = Number(sim.toFixed(4));
        if (best === null || sim > best) best = sim;
      } catch (err) {
        cells[q] = null;
        log.debug(`[ARCFACE] cell ${q} failed: ${err.message}`);
      }
    }
    if (best === null) return { score: null, cells, unavailable: 'no face in any head cell' };
    // BEST across the head views, not min: the two cells are different views
    // (front, 3/4), and a min would punish the harder angle rather than measure
    // identity. The LLM judge uses a min and is right to, because it understands
    // what a 3/4 view is meant to look like; ArcFace does not.
    return { score: Number(best.toFixed(4)), cells };
  } catch (err) {
    log.warn(`[ARCFACE] likeness scoring unavailable: ${err.message}`);
    return { score: null, cells: {}, unavailable: err.message };
  }
}

/** True only when we have a real score AND it is below the gate. */
const failsArcFaceGate = (score) => typeof score === 'number' && score < ARCFACE_MIN;

/**
 * Ask the analyzer to preload ArcFace because an avatar is coming.
 *
 * ArcFace is opt-in on /warmup precisely so a page view or a story run never
 * pays TensorFlow's ~350MB. Calling this at the START of avatar generation
 * means the model loads while Grok is busy, instead of adding ~15s inside the
 * scoring step. Fire-and-forget; failure is not an error.
 */
function warmArcFace() {
  analyzerPost('/warmup', { arcface: true }, 5000)
    .then(() => log.debug('[ARCFACE] warmup requested'))
    .catch((err) => log.debug(`[ARCFACE] warmup skipped: ${err.message}`));
}

module.exports = { scoreAvatarLikeness, failsArcFaceGate, warmArcFace, ARCFACE_MIN };
