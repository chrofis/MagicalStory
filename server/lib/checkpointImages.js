/**
 * Progressive-display images (partial_page / partial_cover checkpoints) live in R2, never in the
 * checkpoint row or the job-status poll (docs/decisions.md 2026-10-09 "Poll carries URLs"): the
 * checkpoint stores `imageUrl`, so a poll is a few KB however many pictures exist. Before, every
 * 3 s poll of a trial shipped each rendered page and the cover as base64 (about 0.55 MB each, up to
 * 4.4 MB per poll), and the swap to the stored URLs at completion made a phone decode them all again.
 * The object sits under the story's own prefix (stories/<jobId>/), which the story row anchors, so it
 * is erased with the story. The name carries a content hash: a re-render is a new URL, never a stale one.
 */
const crypto = require('crypto');
const r2 = require('./r2');

function sniff(imageData) {
  const head = String(imageData).slice(0, 40);
  if (head.startsWith('data:image/png') || head.includes('iVBORw0KGgo')) return { ext: 'png', type: 'image/png' };
  return { ext: 'jpg', type: 'image/jpeg' };
}

/**
 * Upload one rendered image and return its public URL. Throws when R2 cannot take it: the caller
 * logs and skips THAT checkpoint (the render itself is unaffected); no base64 is ever stored instead.
 */
async function uploadCheckpointImage(jobId, slug, imageData) {
  if (!imageData) throw new Error(`checkpoint image ${slug}: no image data`);
  const { ext, type } = sniff(imageData);
  const buf = Buffer.from(r2.stripDataUriPrefix(String(imageData)), 'base64');
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const url = await r2.uploadImage(buf, `stories/${jobId}/preview/${slug}-${hash}.${ext}`, type);
  if (!url) throw new Error(`checkpoint image ${slug}: R2 upload failed or R2 is not configured`);
  return url;
}

/**
 * The full-story poll keeps its field name: the checkpoint's `imageUrl` is served as `imageData`
 * (a URL there, like every R2-era story the client already loads). Rows are not mutated.
 */
function previewImageField(stepData) {
  if (!stepData || !stepData.imageUrl) return stepData;
  const { imageUrl, ...rest } = stepData;
  return { ...rest, imageData: imageUrl };
}

module.exports = { uploadCheckpointImage, previewImageField };
