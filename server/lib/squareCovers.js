/**
 * Square versions of the three portrait covers, for SQUARE books (the mini book and the facing-pages
 * exception, `bookFormatForLayout` in gelato.js). A4 books print the covers as generated.
 *
 * Why: drawing a portrait cover into a square page with `drawImageCovering` crops it, which cut titles,
 * knees, the watermark and the baked-in dedication. Owner 2026-10-28: make a square version with ONE Grok
 * edit per cover (about USD 0.02 each), show it to the customer before payment, print it.
 * Method and measurements: docs/decisions.md 2026-10-28 "Square covers"; eval line in evals/results/results.jsonl.
 *
 * Storage: R2 only, one object per (story, cover, SOURCE picture), named by the source's content hash
 * (`r2.contentKey`). A regenerated cover has different bytes, so it gets a new key and the old square
 * is simply never looked up again. No database row, no JSONB field, no schema change: "does a square for
 * this exact cover exist" is one HEAD request. The PDF functions receive the URLs on
 * `storyData.squareCovers` (set by `attachSquareCovers`, never persisted) and stay free of Grok calls.
 *
 * No fallback: a failed edit or a result with padding bars throws; nothing ever prints the crop.
 */

const sharp = require('sharp');
const r2 = require('./r2');
const { PROMPT_TEMPLATES } = require('../services/prompts');
const { MODEL_PRICING } = require('../config/models');
const { log } = require('../utils/logger');

const COVER_KEYS = ['frontCover', 'backCover', 'initialPage'];
const SQUARE_COVER_MODEL = 'grok-imagine-image';
const EDGE_BAND_SHARE = 0.06;        // width of the edge band that is inspected
const MAX_WHITE_SHARE = 0.20;        // near-white share of an edge band that fails it
const MAX_MAGENTA_SHARE = 0.05;      // magenta share of an edge band that fails it (a stray pink pixel is art, a bar is not)
const SQUARE_TOLERANCE = 0.01;
const ANALYSIS_SIZE = 300;

/**
 * Pure check of a finished square cover. Returns {ok, reason, metrics}; never throws.
 * Fails when the picture is not square, or when any 6%-wide edge band is more than 20% near-white
 * (r,g,b > 235) or holds magenta (r>180, b>180, g<90) - the two kinds of padding bar the method can leave.
 */
async function measureSquareCover(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return { ok: false, reason: 'unreadable image', metrics: {} };
  if (Math.abs(meta.width - meta.height) / Math.max(meta.width, meta.height) > SQUARE_TOLERANCE) {
    return { ok: false, reason: `not square (${meta.width}x${meta.height})`, metrics: {} };
  }
  const n = ANALYSIS_SIZE;
  const raw = await sharp(buffer).removeAlpha().resize(n, n, { fit: 'fill' }).raw().toBuffer();
  const band = Math.max(1, Math.round(n * EDGE_BAND_SHARE));
  const bands = {
    left: [0, band, 0, n], right: [n - band, n, 0, n],
    top: [0, n, 0, band], bottom: [0, n, n - band, n],
  };
  const metrics = {};
  let reason = null;
  for (const [name, [x0, x1, y0, y1]] of Object.entries(bands)) {
    let white = 0, magenta = 0, total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * n + x) * 3;
        const r = raw[i], g = raw[i + 1], b = raw[i + 2];
        if (r > 235 && g > 235 && b > 235) white++;
        if (r > 180 && b > 180 && g < 90) magenta++;
        total++;
      }
    }
    metrics[name] = { white: white / total, magenta: magenta / total };
    if (!reason && metrics[name].white > MAX_WHITE_SHARE) reason = `${name} edge band is ${(metrics[name].white * 100).toFixed(0)}% white`;
    if (!reason && metrics[name].magenta > MAX_MAGENTA_SHARE) reason = `${name} edge band holds magenta (${(metrics[name].magenta * 100).toFixed(0)}%)`;
  }
  return { ok: !reason, reason, metrics };
}

/** Throws when the square cover has padding bars or is not square. */
async function assertSquareCoverClean(buffer, label) {
  const m = await measureSquareCover(buffer);
  if (!m.ok) throw new Error(`[SQUARE COVER] ${label}: rejected, ${m.reason}`);
  return m;
}

// One call per (story, source picture) even when the customer double-clicks or two requests overlap.
const inflight = new Map();

/**
 * Make (or reuse) the square version of one cover.
 * @returns {Promise<{url:string, reused:boolean, cost:number}>}
 */
async function ensureOneSquareCover({ storyId, coverKey, coverValue, deps }) {
  const { resolveImageBuffer, getCoverImageData } = require('./pdf');
  const source = await resolveImageBuffer(getCoverImageData(coverValue));
  if (!source) throw new Error(`[SQUARE COVER] ${storyId} ${coverKey}: source cover could not be read`);
  const key = r2.contentKey(`stories/${storyId}/squareCover`, coverKey, source);
  const url = r2.publicUrlForKey(key);
  if (!url) throw new Error('[SQUARE COVER] R2 is not configured, a square cover has nowhere to live');
  if (await r2.objectExists(key)) return { url, reused: true, cost: 0 };

  const flightKey = key;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  const work = (async () => {
    const prompt = PROMPT_TEMPLATES.squareCover;
    if (!prompt) throw new Error('[SQUARE COVER] prompt template squareCover is not loaded');
    const sourceUri = `data:image/jpeg;base64,${source.toString('base64')}`;
    const edit = deps.editWithGrok;
    // Magenta extension, never plain white padding: white padding kept its white bars in 10 of 16 stored
    // back/dedication covers, magenta in 0 of 24 (docs/decisions.md 2026-10-28).
    const result = await edit(prompt, [sourceUri], {
      model: deps.model, aspectRatio: '1:1', padInputWithExtension: true,
    });
    if (!result?.imageData) throw new Error(`[SQUARE COVER] ${storyId} ${coverKey}: Grok returned no image`);
    const out = Buffer.from(r2.stripDataUriPrefix(result.imageData), 'base64');
    const cost = result.usage?.cost ?? MODEL_PRICING[SQUARE_COVER_MODEL]?.perImage ?? 0;
    try {
      await assertSquareCoverClean(out, `${storyId} ${coverKey}`);
    } catch (err) {
      log.error(`❌ ${err.message} (paid USD ${cost}, not stored)`);
      throw err;
    }
    const stored = await r2.uploadImage(out, key);
    if (!stored) throw new Error(`[SQUARE COVER] ${storyId} ${coverKey}: upload to R2 failed`);
    log.info(`🟦 [SQUARE COVER] ${storyId} ${coverKey} made. Cost: $${cost}`);
    return { url, reused: false, cost };
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, work);
  return work;
}

/**
 * Square versions of every cover the story has. Reuses a stored square whose source is unchanged; makes
 * the missing ones (in parallel). Throws if ANY cover cannot be made: a half-square book must not exist.
 *
 * @param {string} storyId
 * @param {Object} coverImages  storyData.coverImages (rehydrated: imageData is a data URI or an R2 URL)
 * @param {Object} [deps]       test seam: { editWithGrok, model }
 * @returns {Promise<{urls: Object<string,string>, cost: number, made: number, reused: number}>}
 */
async function ensureSquareCovers(storyId, coverImages, deps = {}) {
  const d = {
    editWithGrok: deps.editWithGrok || require('./grok').editWithGrok,
    model: deps.model || require('./grok').GROK_MODELS.STANDARD,
  };
  const keys = COVER_KEYS.filter(k => coverImages && coverImages[k]);
  const results = await Promise.all(keys.map(coverKey =>
    ensureOneSquareCover({ storyId, coverKey, coverValue: coverImages[coverKey], deps: d })));
  const urls = {};
  let cost = 0, made = 0, reused = 0;
  keys.forEach((k, i) => {
    urls[k] = results[i].url;
    cost += results[i].cost;
    if (results[i].reused) reused++; else made++;
  });
  if (made) log.info(`🟦 [SQUARE COVER] story ${storyId}: ${made} made, ${reused} reused, USD ${cost.toFixed(2)}`);
  return { urls, cost, made, reused };
}

/**
 * Put the square cover URLs on `storyData.squareCovers` (in memory, for the PDF functions). Call it for
 * every story of a SQUARE book before generating its PDF; A4 books never call it.
 */
async function attachSquareCovers(storyId, storyData, deps) {
  const { urls } = await ensureSquareCovers(storyId, storyData.coverImages, deps);
  storyData.squareCovers = urls;
  return storyData;
}

module.exports = {
  COVER_KEYS,
  SQUARE_COVER_MODEL,
  measureSquareCover,
  assertSquareCoverClean,
  ensureSquareCovers,
  attachSquareCovers,
};
