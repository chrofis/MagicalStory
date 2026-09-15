import { describe, it, expect, beforeEach } from 'vitest';

// The gap this file locks down: `getIndexedLandmarks` ran its 20/50/100km
// proximity ladder ONLY on coordinates the caller supplied. A village whose
// single indexed row is its own class-0 aerial ("<Town> (Stadt)") therefore
// name-matched, was recognised as unusable (`weakOnly`), and then fell straight
// through to `return weakRows` because no coordinates had come in — even though
// the matched row itself carries latitude/longitude and real landmarks sat a
// few km away. Fislisbach: its only row is the village overview; from that
// row's own coordinates the 20km rung reaches the Holzbrücke and the Zeitturm
// in Mellingen, ~3km out.
//
// Contract pinned here:
//   1. no caller coords + a matched-but-unusable row WITH coords -> proximity
//      runs, centred on that row.
//   2. caller coords present -> unchanged; the row's coords never override.

// landmarkPhotos.js destructures getPool from the database module at load time
// (CJS require), and that require chain runs in Node's native CJS registry —
// vi.mock and vitest's ESM imports don't reach it. Load both through
// createRequire (same native cache), replace getPool on database's
// module.exports FIRST, then load landmarkPhotos so its destructure picks up
// the fake pool.
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const queries: Array<{ text: string; values: any[] }> = [];
let nameRows: any[] = [];
let proximityRows: any[] = [];

const isProximityQuery = (sql: string) => sql.includes('distance_km');

const db: any = nodeRequire('../../server/services/database.js');
db.getPool = () => ({
  query: async (text: string, values: any[]) => {
    queries.push({ text, values });
    return { rows: isProximityQuery(text) ? proximityRows : nameRows };
  },
});

const { getIndexedLandmarks } = nodeRequire('../../server/lib/landmarkPhotos.js');

// The town's own aerial: class 0 (a municipality, not a place you can draw),
// so `weakOnly` fires — but it is a real point on the map. DECIMAL columns come
// back from node-pg as STRINGS, which is the shape used here on purpose.
const aerialRow = (over: Record<string, any> = {}) => ({
  name: 'Fislisbach (Stadt)',
  type: 'City',
  photo_url: 'https://x/aerial.jpg',
  latitude: '47.4283000',
  longitude: '8.2857000',
  ...over,
});

const realLandmark = {
  name: 'Holzbrücke Mellingen',
  type: 'Bridge',
  photo_url: 'https://x/bridge.jpg',
  latitude: '47.4186000',
  longitude: '8.2731000',
};

const proximityCalls = () => queries.filter(q => isProximityQuery(q.text));

beforeEach(() => {
  queries.length = 0;
  nameRows = [];
  proximityRows = [];
});

describe('getIndexedLandmarks — proximity centre', () => {
  it('no caller coords + matched row with coords: proximity runs, centred on that row', async () => {
    nameRows = [aerialRow()];
    proximityRows = [realLandmark];

    const rows = await getIndexedLandmarks('Fislisbach', 30);

    const prox = proximityCalls();
    expect(prox.length).toBeGreaterThan(0);
    expect(Number(prox[0].values[0])).toBeCloseTo(47.4283, 4);
    expect(Number(prox[0].values[1])).toBeCloseTo(8.2857, 4);
    expect(rows.map((r: any) => r.name)).toEqual(['Holzbrücke Mellingen']);
  });

  it('accepts the location-object form with no coordinates the same way', async () => {
    nameRows = [aerialRow()];
    proximityRows = [realLandmark];

    const rows = await getIndexedLandmarks({ city: 'Fislisbach' }, 30);

    expect(proximityCalls().length).toBeGreaterThan(0);
    expect(rows[0].name).toBe('Holzbrücke Mellingen');
  });

  it('caller coords present: unchanged — the matched row never overrides them', async () => {
    nameRows = [aerialRow()];
    proximityRows = [realLandmark];

    await getIndexedLandmarks({ city: 'Fislisbach', latitude: 46.9481, longitude: 7.4474 }, 30);

    const prox = proximityCalls();
    expect(prox.length).toBeGreaterThan(0);
    expect(prox[0].values[0]).toBe(46.9481);
    expect(prox[0].values[1]).toBe(7.4474);
  });

  it('a usable name match still wins outright — no proximity query at all', async () => {
    nameRows = [realLandmark];

    const rows = await getIndexedLandmarks('Mellingen', 30);

    expect(proximityCalls()).toHaveLength(0);
    expect(rows[0].name).toBe('Holzbrücke Mellingen');
  });

  it('nothing nearby: still falls back to the town own weak rows', async () => {
    nameRows = [aerialRow()];
    proximityRows = [];

    const rows = await getIndexedLandmarks('Fislisbach', 30);

    expect(proximityCalls().length).toBe(3); // 20 / 50 / 100 km, all empty
    expect(rows[0].name).toBe('Fislisbach (Stadt)');
  });

  it('a matched row with no coordinates cannot anchor anything', async () => {
    nameRows = [aerialRow({ latitude: null, longitude: null })];
    proximityRows = [realLandmark];

    const rows = await getIndexedLandmarks('Fislisbach', 30);

    expect(proximityCalls()).toHaveLength(0);
    expect(rows[0].name).toBe('Fislisbach (Stadt)');
  });
});
