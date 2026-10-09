#!/usr/bin/env node
/**
 * Landmark selection for ideas, measured on the REAL resolver (staging DB) + the REAL scoreLandmarks/drawFromTop
 * (server/lib/jevSelection.js). Variety across setups, top-5 stability, per-landmark offer rate.
 *   node scripts/analysis/eval-jev-idea-landmarks.js run [--reps=2]
 * Output: evals/runs/2026-10-09_jev-idea-review/landmarks.json  (see docs/decisions.md entry in the run report)
 */
const path = require('path'); const fs = require('fs');
require('dotenv').config();
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
const OUT = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review');
const JS = require('../../server/lib/jevSelection');
const reps = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=2').split('=')[1]);
const CITIES = [['Baden', 'Aargau'], ['Zurich', 'Zurich'], ['Luzern', 'Luzern'], ['Fislisbach', 'Aargau']];
const SETUPS = [
  { category: 'life-challenge', theme: null, topic: 'telling-truth', ages: [5] },
  { category: 'life-challenge', theme: null, topic: 'going-outside', ages: [3] },
  { category: 'life-challenge', theme: 'superhero', topic: 'sharing', ages: [8, 5] },
  { category: 'adventure', theme: 'pirate', topic: null, ages: [4] },
  { category: 'adventure', theme: 'knight', topic: null, ages: [6] },
  { category: 'adventure', theme: 'space', topic: null, ages: [7, 9] },
  { category: 'adventure', theme: 'dinosaur', topic: null, ages: [3, 5] },
  { category: 'life-challenge', theme: null, topic: 'making-friends', ages: [12] },
  { category: 'life-challenge', theme: null, topic: 'bedtime', ages: [2] },
  { category: 'adventure', theme: 'fairy', topic: null, ages: [5] },
];
(async () => {
  require('../../server/services/database').initializePool();
  const { resolveAvailableLandmarks } = require('../../server/lib/landmarkPhotos');
  const res = {};
  for (const [city, region] of CITIES) {
    const loc = { city, region, country: 'Switzerland' };
    const lms = await resolveAvailableLandmarks(loc, { limit: JS.STORY_LANDMARK_LIMIT, discoverOnMiss: false, language: 'de' });
    const rows = { pool: lms.map(l => l.name), setups: [] };
    if (lms.length) for (const s of SETUPS) {
      const setup = JS.selectionSetup({ characters: s.ages.map(a => ({ age: a, gender: 'female' })), storyCategory: s.category, storyTheme: s.theme, storyTopic: s.topic, userLocation: loc });
      const runs = [];
      for (let r = 0; r < reps; r++) {
        const { scores } = await JS.scoreLandmarks(JS.setupState(setup), lms);
        runs.push(scores);
      }
      rows.setups.push({ s, runs });
    }
    res[city] = rows;
    console.log(city, 'pool', lms.length, lms.map(l => l.name).join(' | '));
  }
  fs.writeFileSync(path.join(OUT, 'landmarks.json'), JSON.stringify(res, null, 1));
  try { await require('../../server/services/database').getPool()?.end(); } catch (_) {}
})().catch(e => { console.error('ERR', e); process.exit(1); });
