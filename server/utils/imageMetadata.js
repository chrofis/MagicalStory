/**
 * Shared image-metadata helpers for logging without storing full image data.
 */

/**
 * Create a short identifier for an image (first 12 chars of base64 data after header)
 * Used for logging without storing full image data
 */
function getImageIdentifier(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return base64.substring(0, 12) + '...';
}

/**
 * Get the size of an image in KB from base64
 */
function getImageSizeKB(imageData) {
  if (!imageData || typeof imageData !== 'string') return 0;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return Math.round((base64.length * 3 / 4) / 1024);
}

module.exports = { getImageIdentifier, getImageSizeKB };
