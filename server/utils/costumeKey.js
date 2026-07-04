/**
 * Shared costume cache-key slugify. The slug IS a cache key — its output must
 * stay byte-identical across the reader (compositeCastBuilder) and writer
 * (styledAvatars) or costumed sheets desync (regenerate / wrong clothing).
 */

/**
 * Slugify a costume string into a stable cache key.
 * @param {string} s
 * @returns {string}
 */
function slugifyCostume(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = { slugifyCostume };
