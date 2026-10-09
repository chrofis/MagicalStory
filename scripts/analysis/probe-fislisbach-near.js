// Would a 5 km proximity top-up (landmark_index, staging) give Fislisbach real variety? Scores the topped-up pool with the real LB1 (jevSelection.scoreLandmarks).
require('dotenv').config(); process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
require('../../server/services/database').initializePool();
const L = require('../../server/lib/landmarkPhotos'); const JS = require('../../server/lib/jevSelection');
const SETUPS = [
  { category: 'life-challenge', theme: null, topic: 'telling-truth', ages: [5] }, { category: 'life-challenge', theme: null, topic: 'going-outside', ages: [3] },
  { category: 'life-challenge', theme: 'superhero', topic: 'sharing', ages: [8, 5] }, { category: 'adventure', theme: 'pirate', topic: null, ages: [4] },
  { category: 'adventure', theme: 'knight', topic: null, ages: [6] }, { category: 'adventure', theme: 'space', topic: null, ages: [7, 9] },
  { category: 'adventure', theme: 'dinosaur', topic: null, ages: [3, 5] }, { category: 'life-challenge', theme: null, topic: 'making-friends', ages: [12] },
  { category: 'life-challenge', theme: null, topic: 'bedtime', ages: [2] }, { category: 'adventure', theme: 'fairy', topic: null, ages: [5] },
];
(async () => {
  const own = await L.resolveAvailableLandmarks({ city: 'Fislisbach', region: 'Aargau', country: 'Switzerland' }, { limit: 20, discoverOnMiss: false, language: 'de' });
  const near = await L.getIndexedLandmarksNearLocation(47.4333, 8.2833, 5, 20, 'Fislisbach');
  const seen = new Set(own.map(l => l.name)); const pool = [...own.filter(l => !/\(Stadt\)/.test(l.name)), ...near.filter(l => !seen.has(l.name))].slice(0, 20);
  console.log('pool', pool.length, pool.map(l => l.name).join(' | '));
  const top = {}; const offer = {};
  for (const s of SETUPS) {
    const setup = JS.selectionSetup({ characters: s.ages.map(a => ({ age: a, gender: 'female' })), storyCategory: s.category, storyTheme: s.theme, storyTopic: s.topic, userLocation: { city: 'Fislisbach' } });
    const { scores } = await JS.scoreLandmarks(JS.setupState(setup), pool);
    const order = pool.map((l, i) => [l.name, scores[i]]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
    top[order[0]] = (top[order[0]] || 0) + 1; for (const n of order) offer[n] = (offer[n] || 0) + 1;
    console.log((s.theme || s.topic).padEnd(14), order.join(' | '));
  }
  console.log('top-1:', JSON.stringify(top)); console.log('distinct in some top-5:', Object.keys(offer).length, 'of', pool.length, '; max share of setups any one place is in top-5:', Math.max(...Object.values(offer)) / SETUPS.length);
  process.exit(0);
})();
