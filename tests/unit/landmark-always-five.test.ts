import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

// Owner, 2026-10-09: "Ensure we always get 5 landmarks." Fislisbach's own list
// is its "(Stadt)" aerial plus one church, so 12 of 12 stored trials picked the
// church. Every resolver (resolveAvailableLandmarks: story full/trial, wizard
// idea, trial idea) now tops a short list up from the nearby index.
//
// landmarkPhotos.js destructures getPool at load time, so the fake pool is
// installed on database's module.exports BEFORE it is required (see
// landmark-proximity-centre.test.ts).
const nodeRequire = createRequire(import.meta.url);

const queries: Array<{ text: string; values: any[] }> = [];
let nameRows: any[] = [];
let nearRows: Array<{ maxKm: number; row: any }> = []; // a row is returned for every radius >= maxKm
let nextId = 100;

const isNear = (sql: string) => sql.includes('distance_km');

const db: any = nodeRequire('../../server/services/database.js');
db.getPool = () => ({
  query: async (text: string, values: any[]) => {
    queries.push({ text, values });
    if (isNear(text)) {
      const radius = values[5];
      return { rows: nearRows.filter(n => n.maxKm <= radius).map(n => n.row) };
    }
    if (text.includes('landmark_photo_scores')) return { rows: [] };
    return { rows: nameRows };
  },
});

const L = nodeRequire('../../server/lib/landmarkPhotos.js');
const runMetrics = nodeRequire('../../server/lib/runMetrics.js');

const aerial = () => ({ id: 1, name: 'Fislisbach (Stadt)', type: 'City', photo_url: 'https://x/a.jpg', latitude: '47.4283', longitude: '8.2857' });
const church = () => ({ id: 2, name: 'Kirche Rohrdorf', type: 'Church', photo_url: 'https://x/c.jpg', latitude: '47.43', longitude: '8.30' });
const place = (name: string, km: number) => ({
  id: nextId++, name, type: 'Church', photo_url: 'https://x/p.jpg', latitude: '47.42', longitude: '8.27', distance_km: km,
});
const nearCalls = () => queries.filter(q => isNear(q.text));
const names = (rows: any[]) => rows.map(r => r.name);

beforeEach(() => {
  queries.length = 0;
  nameRows = [];
  nearRows = [];
  nextId = 100;
});

describe('topUpToMinimum', () => {
  it('Fislisbach: aerial + 1 church tops up to 5+ real places, nearest first', async () => {
    nearRows = [
      { maxKm: 0, row: place('Far church', 4.8) },
      { maxKm: 0, row: place('Near church', 1.2) },
      { maxKm: 0, row: place('Mid church', 3.1) },
      { maxKm: 0, row: place('Mid2 church', 3.3) },
    ];
    const out = await L.topUpToMinimum([aerial(), church()], { city: 'Fislisbach' }, { limit: 20 });
    expect(names(out).slice(0, 2)).toEqual(['Fislisbach (Stadt)', 'Kirche Rohrdorf']);
    expect(names(out).slice(2)).toEqual(['Near church', 'Mid church', 'Mid2 church', 'Far church']);
    // the aerial never counts: 1 real + 4 added = 5
    expect(out.filter((r: any) => r.type !== 'City').length).toBe(5);
    // centred on the aerial's own coordinates (the caller gave none)
    expect(Number(nearCalls()[0].values[0])).toBeCloseTo(47.4283, 4);
  });

  it('widens the radius stepwise and stops at the first radius that yields enough', async () => {
    nearRows = [
      { maxKm: 5, row: place('A', 2) },
      { maxKm: 10, row: place('B', 7) },
      { maxKm: 10, row: place('C', 8) },
      { maxKm: 20, row: place('D', 15) },
      { maxKm: 20, row: place('E', 16) },
    ];
    const out = await L.topUpToMinimum([church()], { city: 'X' }, { limit: 20 });
    expect(nearCalls().map(q => q.values[5])).toEqual([5, 10, 20]); // 5 and 10 are too few, 20 reaches 5 real
    expect(names(out)).toEqual(['Kirche Rohrdorf', 'A', 'B', 'C', 'D', 'E']);
  });

  it('caller coordinates win over the matched row', async () => {
    nearRows = [1, 2, 3, 4].map(i => ({ maxKm: 0, row: place(`P${i}`, i) }));
    await L.topUpToMinimum([aerial()], { city: 'X', latitude: 46.9, longitude: 7.4 }, { limit: 20 });
    expect(nearCalls()[0].values.slice(0, 2)).toEqual([46.9, 7.4]);
  });

  it('already 5 real places: no extra query, list untouched', async () => {
    const rows = [1, 2, 3, 4, 5].map(i => ({ ...church(), id: 50 + i, name: `C${i}` }));
    const out = await L.topUpToMinimum(rows, { city: 'X' }, { limit: 20 });
    expect(out).toBe(rows);
    expect(nearCalls()).toHaveLength(0);
  });

  it('the index cannot supply 5: returns what exists, never invents, counts the shortfall', async () => {
    nearRows = [{ maxKm: 0, row: place('Only one', 3) }];
    runMetrics.forJob('job-short');
    const out = await L.topUpToMinimum([aerial()], { city: 'Lonely' }, { limit: 20, jobId: 'job-short' });
    expect(names(out)).toEqual(['Fislisbach (Stadt)', 'Only one']);
    expect(runMetrics.getSnapshot('job-short').landmarks_under_min).toBe(1);
    expect(runMetrics.getSnapshot('job-short').landmarks_topped_up).toBe(1);
    runMetrics.release('job-short');
  });

  it('no coordinates anywhere: shortfall is counted, rows returned as they are', async () => {
    runMetrics.forJob('job-nocoord');
    const rows = [{ ...church(), latitude: null, longitude: null }];
    const out = await L.topUpToMinimum(rows, { city: 'X' }, { limit: 20, jobId: 'job-nocoord' });
    expect(out).toBe(rows);
    expect(nearCalls()).toHaveLength(0);
    expect(runMetrics.getSnapshot('job-nocoord').landmarks_under_min).toBe(1);
    runMetrics.release('job-nocoord');
  });
});

describe('resolveAvailableLandmarks', () => {
  const setup = () => {
    nameRows = [aerial(), church()];
    nearRows = [1, 2, 3, 4, 5].map(i => ({ maxKm: 0, row: place(`Nearby ${i}`, i) }));
  };

  it('story (default): at least 5 real places, the aerial stays in the list', async () => {
    setup();
    const out = await L.resolveAvailableLandmarks({ city: 'Fislisbach' }, { limit: 20, discoverOnMiss: false });
    expect(out.filter((l: any) => l.type !== 'City').length).toBeGreaterThanOrEqual(5);
    expect(names(out)).toContain('Fislisbach (Stadt)');
  });

  it('idea (placesOnly): at least 5 real places and no aerial', async () => {
    setup();
    const out = await L.resolveAvailableLandmarks({ city: 'Fislisbach' }, { limit: 20, discoverOnMiss: false, placesOnly: true });
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(names(out)).not.toContain('Fislisbach (Stadt)');
  });
});

describe('every idea resolver asks for placesOnly', () => {
  it('resolveTrialIdeaLandmarks (trial idea) drops the aerial and reaches 5', async () => {
    nameRows = [aerial(), church()];
    nearRows = [1, 2, 3, 4, 5].map(i => ({ maxKm: 0, row: place(`Nearby ${i}`, i) }));
    const JS = nodeRequire('../../server/lib/jevSelection.js');
    const out = await JS.resolveTrialIdeaLandmarks({ city: 'Fislisbach' }, 'de');
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(names(out)).not.toContain('Fislisbach (Stadt)');
  });

  it('the wizard idea resolver passes placesOnly (source check)', () => {
    const src = require('node:fs').readFileSync(new URL('../../server/routes/storyIdeas.js', import.meta.url), 'utf8');
    expect(src).toMatch(/discoverOnMiss: true, language, placesOnly: true/);
  });
});
