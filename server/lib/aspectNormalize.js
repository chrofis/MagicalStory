/**
 * Normalize a stored book image to exact A4 aspect (210/297 = 0.7071).
 *
 * Grok's "3:4" preset natively returns 896×1280 (ratio 0.700), 1% off A4.
 * Normalizing once at write time means:
 *   - every serve path (shared viewer, owner view, PDF) reads A4 from DB
 *   - no per-request CPU for repeat normalization
 *   - preview matches the printed A4 book 1:1
 *
 * Accepts either a base64 string or a `data:image/*;base64,...` URI and
 * returns the same shape. Returns input unchanged if already within 0.5%
 * of A4 or if sharp fails (safe fallback).
 */

const A4_RATIO = 210 / 297;
const TOLERANCE = 0.005; // 0.5% — tight enough to catch Grok's 1% drift

async function normalizeImageToA4(imageData) {
  if (!imageData || typeof imageData !== 'string') return imageData;

  try {
    const sharp = require('sharp');

    const isDataUri = imageData.startsWith('data:image/');
    const base64 = isDataUri ? imageData.replace(/^data:image\/\w+;base64,/, '') : imageData;
    const mime = isDataUri ? (imageData.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg') : 'image/jpeg';

    const buf = Buffer.from(base64, 'base64');
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return imageData;

    const currentRatio = meta.width / meta.height;
    if (Math.abs(currentRatio - A4_RATIO) / A4_RATIO < TOLERANCE) {
      return imageData; // already A4
    }

    const targetHeight = Math.max(meta.height, Math.round(meta.width / A4_RATIO));
    const targetWidth = Math.round(targetHeight * A4_RATIO);

    let pipeline = sharp(buf).resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre' });
    pipeline = mime === 'image/png' ? pipeline.png() : pipeline.jpeg({ quality: 92 });
    const normalized = await pipeline.toBuffer();

    const newB64 = normalized.toString('base64');
    return isDataUri ? `data:${mime};base64,${newB64}` : newB64;
  } catch (err) {
    console.warn(`⚠️ [NORMALIZE-A4] Skipped: ${err.message}`);
    return imageData;
  }
}

module.exports = { normalizeImageToA4, A4_RATIO };
