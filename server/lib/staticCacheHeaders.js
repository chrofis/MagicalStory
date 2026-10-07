const path = require('path');

/**
 * Cache-Control for a file express.static serves out of dist/.
 *
 * express.static defaults to max-age=0, so every file is re-validated on every
 * visit. Vite content-hashes everything under /assets/ — safe to cache forever;
 * /fonts/ are stable. /images/ (the city-page book photos, ~300 kB each, and
 * the /try step illustrations) are unhashed but only ever ADDED under new names
 * (CityPage.tsx: "drop new .jpg files into client/public/images/cities/"), so a
 * day at the browser and the CDN costs nothing and saves a round-trip per image
 * on every repeat visit. HTML and everything else keep the default
 * (revalidate) so deploys show up at once.
 *
 * Returns null when the default should stay.
 */
function cacheControlFor(filePath) {
  const sep = path.sep;
  if (filePath.includes(`${sep}assets${sep}`)) return 'public, max-age=31536000, immutable';
  if (filePath.includes(`${sep}fonts${sep}`)) return 'public, max-age=2592000';
  if (filePath.includes(`${sep}images${sep}`)) return 'public, max-age=86400';
  return null;
}

module.exports = { cacheControlFor };
