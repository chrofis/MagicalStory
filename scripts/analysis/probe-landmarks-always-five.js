// Read-only proof (staging DB) that every landmark resolver returns >= 5 real places.
// Prints, per town, the list BEFORE (getIndexedLandmarks = the town's own list, what the
// resolvers returned until 2026-10-09) and AFTER (resolveAvailableLandmarks as the story
// calls it, and with placesOnly as the idea routes call it). discoverOnMiss is false:
// the paid auto-indexer is never triggered.
//   node scripts/analysis/probe-landmarks-always-five.js [Town ...]
//   node scripts/analysis/probe-landmarks-always-five.js --find-small   (3 towns with < 5 own real entries)
require('dotenv').config(); process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
const { initializePool, getPool } = require('../../server/services/database');
initializePool();
const L = require('../../server/lib/landmarkPhotos');
const JS = require('../../server/lib/jevSelection');

const real = r => !['City', 'Village', 'Event', 'Organisation', 'Other'].includes(r.type || 'x');
const fmt = rows => rows.map(r => `${r.name}${real(r) ? '' : ' [aerial]'}`).join(' | ');

async function describe(city) {
  const loc = { city, country: 'Switzerland' };
  const before = await L.getIndexedLandmarks(loc, JS.STORY_LANDMARK_LIMIT);
  const story = await L.resolveAvailableLandmarks(loc, { limit: JS.STORY_LANDMARK_LIMIT, discoverOnMiss: false, language: 'de' });
  const idea = await JS.resolveTrialIdeaLandmarks(loc, 'de');
  console.log(`\n=== ${city} ===`);
  console.log(`BEFORE  (${before.length} rows, ${before.filter(real).length} real): ${fmt(before)}`);
  console.log(`AFTER story   (${story.length} entries, ${story.filter(real).length} real): ${story.map(l => l.name).join(' | ')}`);
  console.log(`AFTER ideas   (${idea.length} entries, ${idea.filter(real).length} real; trial-idea + wizard-idea resolvers): ${idea.map(l => l.name).join(' | ')}`);
  return { city, before: before.filter(real).length, story: story.filter(real).length, idea: idea.length };
}

(async () => {
  const args = process.argv.slice(2);
  let towns = args.filter(a => !a.startsWith('--'));
  if (args.includes('--find-small')) {
    const { rows } = await getPool().query(`
      SELECT nearest_city, count(*) n FROM landmark_index
       WHERE country ILIKE 'switzerland' AND nearest_city IS NOT NULL AND latitude IS NOT NULL
       GROUP BY 1 HAVING count(*) BETWEEN 2 AND 3 ORDER BY md5(nearest_city) LIMIT 40`);
    const found = [];
    for (const r of rows) {
      const own = await L.getIndexedLandmarks({ city: r.nearest_city, country: 'Switzerland' }, 20);
      // genuinely small: the own-name lookup, not the 20 km proximity fallback, supplied < 5 real rows
      if (own.filter(real).length < 5 && own.some(o => String(o.nearest_city || '').toLowerCase() === r.nearest_city.toLowerCase())) found.push(r.nearest_city);
      if (found.length === 3) break;
    }
    console.log('small towns:', found.join(', '));
    towns = found;
  }
  const summary = [];
  for (const t of towns) summary.push(await describe(t));
  console.log('\nSUMMARY (real own -> real after story / entries for ideas):');
  for (const s of summary) console.log(`  ${s.city.padEnd(16)} ${s.before} -> ${s.story} / ${s.idea}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
