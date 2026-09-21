/**
 * The repair half of the IRON RULE, pinned: `offloadJsonbColumn` moves image
 * bytes out of ANY json/jsonb column and must never lose one.
 *
 * Every guarantee here was earned. The verify-before-replace rule exists
 * because the bytes in `users.trial_data` are the only copy of a real
 * customer's uploaded photograph. The "row changed under us" check exists
 * because the uploads take seconds and the app keeps writing during them — and
 * it caught a real bug on its first production run: the pre-write snapshot was
 * the SAME object the walker mutates in place, so the check compared the row
 * against its own post-offload state and refused every row. The snapshot is the
 * stored `::text` for that reason, and this test is why it stays that way.
 *
 * No network, no database: r2 is stubbed and the pool is a fake.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const crypto = require_('crypto');
const r2 = require_('../../server/lib/r2');
const { offloadJsonbColumn, findInlineImages } = require_('../../server/lib/dbHousekeeping');

const log = { info: () => {}, warn: () => {}, error: () => {} };
const uri = (seed: string) => `data:image/jpeg;base64,${Buffer.from(seed.repeat(900)).toString('base64')}`;
const bytesOf = (s: string) => Buffer.from(s.replace(/^data:image\/\w+;base64,/, ''), 'base64');

/** A one-table fake pool: the two SELECTs the offload makes, plus a transaction. */
function fakePool(rows: Record<string, any>, { mutateDuringUpload = null as null | (() => void) } = {}) {
  const stored: Record<string, string> = {};
  for (const [id, v] of Object.entries(rows)) stored[id] = JSON.stringify(v);
  const query = async (sql: string, params: any[] = []) => {
    if (/^\s*SELECT\s+"id"::text AS id/i.test(sql)) {
      return { rows: Object.keys(stored).map(id => ({ id })) };
    }
    if (/FOR UPDATE/i.test(sql)) return { rows: [{ t: stored[params[0]] }] };
    if (/^\s*SELECT/i.test(sql)) {
      // The read the walker works from — and the moment a concurrent writer
      // would slip in.
      const row = { v: stored[params[0]], owner: 'u1' };
      if (mutateDuringUpload) mutateDuringUpload();
      return { rows: [row] };
    }
    if (/^\s*UPDATE/i.test(sql)) { stored[params[0]] = params[1]; return { rows: [] }; }
    return { rows: [] };
  };
  const client = { query: async (sql: string, p?: any[]) => query(sql, p), release: () => {} };
  return { query, connect: async () => client, stored, bump: (id: string, v: any) => { stored[id] = JSON.stringify(v); } };
}

const SPEC = { table: 'widgets', column: 'blob', idColumn: 'id', ownerColumn: 'owner' };

let bucket: Map<string, Buffer>;
const real = { isConfigured: r2.isConfigured, uploadImage: r2.uploadImage, objectExists: r2.objectExists, fetchImageBytes: r2.fetchImageBytes, publicUrlForKey: r2.publicUrlForKey };

beforeEach(() => {
  bucket = new Map();
  r2.isConfigured = vi.fn(() => true);
  r2.publicUrlForKey = vi.fn((key: string) => `https://r2.example/${key}`);
  r2.uploadImage = vi.fn(async (input: any, key: string) => {
    bucket.set(key, Buffer.isBuffer(input) ? input : bytesOf(input));
    return `https://r2.example/${key}`;
  });
  r2.objectExists = vi.fn(async (key: string) => bucket.has(key));
  r2.fetchImageBytes = vi.fn(async (url: string) => bucket.get(String(url).replace('https://r2.example/', '')) || null);
});
afterEach(() => { Object.assign(r2, real); });

describe('offloadJsonbColumn', () => {
  it('replaces bytes with a URL that reads back byte-identical', async () => {
    const pool: any = fakePool({ w1: { photos: { face: uri('a'), body: uri('b') } } });
    const before = bytesOf(JSON.parse(pool.stored.w1).photos.face);

    const out = await offloadJsonbColumn(pool, log, SPEC);

    expect(out.rows).toBe(1);
    expect(out.images).toBe(2);
    const after = JSON.parse(pool.stored.w1);
    expect(findInlineImages(after)).toEqual([]);
    expect(after.photos.face).toMatch(/^https:\/\/r2\.example\//);
    const fetched = await r2.fetchImageBytes(after.photos.face);
    expect(crypto.createHash('md5').update(fetched).digest('hex'))
      .toBe(crypto.createHash('md5').update(before).digest('hex'));
  });

  it('is a no-op the second time (content-addressed keys, existing object reused)', async () => {
    const pool: any = fakePool({ w1: { photos: { face: uri('a') } } });
    await offloadJsonbColumn(pool, log, SPEC);
    const afterFirst = pool.stored.w1;
    const uploads = (r2.uploadImage as any).mock.calls.length;

    const second = await offloadJsonbColumn(pool, log, SPEC);
    expect(second.rows).toBe(0);                       // nothing left to collect
    expect(pool.stored.w1).toBe(afterFirst);
    expect((r2.uploadImage as any).mock.calls.length).toBe(uploads);
  });

  it('reuses a sibling column that already holds the identical image, without uploading', async () => {
    const image = uri('a');
    const pool: any = fakePool({ w1: { photos: { face: image } } });
    // The sibling column's value, as `characters.data` looked after the
    // 2026-09-01 migration while `.metadata` still held the base64.
    const key = 'already/there.jpg';
    bucket.set(key, bytesOf(image));
    (pool as any).query = (async (sql: string, params: any[] = []) => {
      if (/^\s*SELECT\s+"id"::text AS id/i.test(sql)) return { rows: [{ id: 'w1' }] };
      if (/FOR UPDATE/i.test(sql)) return { rows: [{ t: pool.stored.w1 }] };
      if (/^\s*SELECT/i.test(sql)) {
        return { rows: [{ v: pool.stored.w1, owner: 'u1', reuse: JSON.stringify({ photos: { face: `https://r2.example/${key}` } }) }] };
      }
      if (/^\s*UPDATE/i.test(sql)) { pool.stored[params[0]] = params[1]; return { rows: [] }; }
      return { rows: [] };
    }) as any;

    const out = await offloadJsonbColumn(pool, log, { ...SPEC, reuseColumn: 'sibling' });

    expect(out.reused).toBe(1);
    expect(r2.uploadImage).not.toHaveBeenCalled();
    expect(JSON.parse(pool.stored.w1).photos.face).toBe(`https://r2.example/${key}`);
  });

  it('leaves the row ALONE when an upload cannot be verified — never a half-migrated row', async () => {
    const pool: any = fakePool({ w1: { photos: { face: uri('a'), body: uri('b') } } });
    const before = pool.stored.w1;
    // The object lands in the bucket corrupted: the read-back will not match.
    r2.uploadImage = vi.fn(async (_input: any, key: string) => {
      bucket.set(key, Buffer.from('not the same bytes'));
      return `https://r2.example/${key}`;
    });

    const out = await offloadJsonbColumn(pool, log, SPEC);

    expect(out.rows).toBe(0);
    expect(out.skipped).toBe(1);
    expect(pool.stored.w1).toBe(before);               // bytes still there, nothing lost
  });

  it('skips a row that changed while the uploads were in flight', async () => {
    const pool: any = fakePool({ w1: { photos: { face: uri('a') } } });
    let fired = false;
    const original = pool.query;
    pool.query = async (sql: string, params: any[] = []) => {
      const res = await original(sql, params);
      if (/^\s*SELECT/i.test(sql) && !/FOR UPDATE|"id"::text AS id/i.test(sql) && !fired) {
        fired = true;
        pool.bump('w1', { photos: { face: uri('a') }, somebodyElseWrote: true });
      }
      return res;
    };

    const out = await offloadJsonbColumn(pool, log, SPEC);

    expect(out.rows).toBe(0);
    expect(out.skipped).toBe(1);
    expect(JSON.parse(pool.stored.w1).somebodyElseWrote).toBe(true);   // their write survives
  });

  it('a dry run reports the same rows and touches nothing', async () => {
    const pool: any = fakePool({ w1: { photos: { face: uri('a') } } });
    const before = pool.stored.w1;

    const out = await offloadJsonbColumn(pool, log, SPEC, { dryRun: true });

    expect(out.rows).toBe(1);
    expect(out.details[0].action).toBe('would-offload');
    expect(r2.uploadImage).not.toHaveBeenCalled();
    expect(pool.stored.w1).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The unattended half: the DAILY routine's offload (owner, 2026-09-21).
//
// It covers every offloadable column, not the two it was born with; it is
// bounded so one night cannot rewrite the database; it resumes where the budget
// stopped it; and it refuses outright when the configured bucket does not belong
// to the database being cleaned — which is the whole reason staging could not be
// cleaned from a developer machine.
// ─────────────────────────────────────────────────────────────────────────────

const {
  offloadInlineImages,
  OFFLOADABLE_COLUMNS,
  DAILY_OFFLOAD_BUDGET,
} = require_('../../server/lib/dbHousekeeping');

/**
 * A fake pool that answers for EVERY offloadable table, keyed by the table name
 * in the SQL. `rows` is { 'table.column': { id: value } }.
 */
function multiPool(rows: Record<string, Record<string, any>>, { imageUrlHost = 'r2.example' } = {}) {
  const stored: Record<string, Record<string, string>> = {};
  for (const [col, byId] of Object.entries(rows)) {
    stored[col] = {};
    for (const [id, v] of Object.entries(byId)) stored[col][id] = JSON.stringify(v);
  }
  const of = (sql: string) => {
    const m = sql.match(/FROM\s+"([a-z_]+)"/i) || sql.match(/UPDATE\s+"([a-z_]+)"/i);
    const c = sql.match(/"([a-z_]+)"(?:::text)?\s+AS\s+[vt]\b/i) || sql.match(/SET\s+"([a-z_]+)"/i);
    return `${m ? m[1] : ''}.${c ? c[1] : ''}`;
  };
  const query = async (sql: string, params: any[] = []) => {
    if (/FROM story_images/i.test(sql)) {
      return { rows: imageUrlHost ? [{ image_url: `https://${imageUrlHost}/x.jpg` }] : [] };
    }
    if (/AS id\s*$|AS id\s*\n/i.test(sql) || /::text AS id/i.test(sql)) {
      const table = (sql.match(/FROM\s+"([a-z_]+)"/i) || [])[1];
      const column = (sql.match(/WHERE\s+"([a-z_]+)" IS NOT NULL/i) || [])[1];
      const bag = stored[`${table}.${column}`] || {};
      let ids = Object.keys(bag);
      const lim = sql.match(/LIMIT (\d+)/);
      if (lim) ids = ids.slice(0, parseInt(lim[1], 10));
      return { rows: ids.map(id => ({ id })) };
    }
    if (/FOR UPDATE/i.test(sql)) {
      const k = of(sql);
      return { rows: stored[k]?.[params[0]] !== undefined ? [{ t: stored[k][params[0]] }] : [] };
    }
    if (/^\s*UPDATE/i.test(sql)) { stored[of(sql)][params[0]] = params[1]; return { rows: [] }; }
    if (/^\s*SELECT/i.test(sql)) {
      const k = of(sql);
      if (stored[k]?.[params[0]] === undefined) return { rows: [] };
      return { rows: [{ v: stored[k][params[0]], owner: 'u1' }] };
    }
    return { rows: [] };
  };
  const client = { query: async (s: string, p?: any[]) => query(s, p), release: () => {} };
  return { query, connect: async () => client, stored };
}

describe('the daily routine offload', () => {
  const prevPublic = process.env.R2_PUBLIC_URL;
  beforeEach(() => { process.env.R2_PUBLIC_URL = 'https://r2.example'; });
  afterEach(() => { process.env.R2_PUBLIC_URL = prevPublic; });

  it('covers EVERY offloadable column, not just characters.data and stories.data', async () => {
    const rows: Record<string, Record<string, any>> = {};
    for (const s of OFFLOADABLE_COLUMNS) rows[`${s.table}.${s.column}`] = { [`${s.table}-1`]: { p: { face: uri(s.column) } } };
    const pool: any = multiPool(rows);

    const out = await offloadInlineImages(pool, log);

    expect(out.refused).toBe(null);
    expect(Object.keys(out.byColumn).sort())
      .toEqual(OFFLOADABLE_COLUMNS.map((s: any) => `${s.table}.${s.column}`).sort());
    expect(out.rows).toBe(OFFLOADABLE_COLUMNS.length);
    for (const bag of Object.values(pool.stored) as any[]) {
      for (const text of Object.values(bag) as string[]) {
        expect(findInlineImages(JSON.parse(text))).toEqual([]);
      }
    }
  });

  it('never touches story_job_checkpoints.step_data — the declared exception', () => {
    expect(OFFLOADABLE_COLUMNS.some((s: any) => s.table === 'story_job_checkpoints')).toBe(false);
  });

  it('stops at the per-run budget and leaves the rest for the next run', async () => {
    const pool: any = multiPool({
      'characters.data': { c1: { p: { a: uri('a') } }, c2: { p: { a: uri('b') } }, c3: { p: { a: uri('c') } } },
      'stories.data': { s1: { p: { a: uri('d') } } },
    });

    const out = await offloadInlineImages(pool, log, { budget: { rows: 2, bytes: 1e9 } });

    expect(out.rows).toBe(2);
    expect(out.budgetExhausted).toBe(true);
    expect(out.nextCursor).toBe('characters.data');
    // The untouched rows still hold their bytes — nothing was lost, just deferred.
    const left = Object.values(pool.stored['characters.data'] as Record<string, string>)
      .filter(t => findInlineImages(JSON.parse(t)).length);
    expect(left.length).toBe(1);
    expect(findInlineImages(JSON.parse(pool.stored['stories.data'].s1)).length).toBe(1);
  });

  it('resumes at the cursor the previous run handed back', async () => {
    const pool: any = multiPool({
      'characters.data': { c1: { p: { a: uri('a') } } },
      'users.trial_data': { u1: { p: { a: uri('u') } } },
    });

    const out = await offloadInlineImages(pool, log, { cursor: 'users.trial_data', budget: { rows: 1, bytes: 1e9 } });

    // It started at the cursor, not back at the top of the list.
    expect(Object.keys(out.byColumn)).toEqual(['users.trial_data']);
    expect(findInlineImages(JSON.parse(pool.stored['users.trial_data'].u1))).toEqual([]);
    expect(findInlineImages(JSON.parse(pool.stored['characters.data'].c1)).length).toBe(1);
  });

  it('a row whose upload cannot be verified is skipped and keeps its bytes', async () => {
    const pool: any = multiPool({ 'characters.data': { c1: { p: { a: uri('a') } } } });
    const before = pool.stored['characters.data'].c1;
    r2.uploadImage = vi.fn(async (_i: any, key: string) => { bucket.set(key, Buffer.from('wrong')); return `https://r2.example/${key}`; });

    const out = await offloadInlineImages(pool, log);

    expect(out.rows).toBe(0);
    expect(out.skipped).toBe(1);
    expect(pool.stored['characters.data'].c1).toBe(before);
  });

  it('REFUSES when the configured bucket is not this database\'s bucket', async () => {
    const pool: any = multiPool({ 'characters.data': { c1: { p: { a: uri('a') } } } },
      { imageUrlHost: 'images-staging.magicalstory.ch' });   // staging DB, production R2 configured
    const before = pool.stored['characters.data'].c1;

    const out = await offloadInlineImages(pool, log);

    expect(out.refused).toBe('bucket-mismatch');
    expect(out.rows).toBe(0);
    expect(r2.uploadImage).not.toHaveBeenCalled();
    expect(pool.stored['characters.data'].c1).toBe(before);
  });

  it('REFUSES when R2 is not configured at all', async () => {
    r2.isConfigured = vi.fn(() => false);
    const pool: any = multiPool({ 'characters.data': { c1: { p: { a: uri('a') } } } });

    const out = await offloadInlineImages(pool, log);

    expect(out.refused).toBe('r2-not-configured');
    expect(r2.uploadImage).not.toHaveBeenCalled();
  });

  it('has a budget that is a real bound, not a formality', () => {
    expect(DAILY_OFFLOAD_BUDGET.rows).toBeGreaterThan(0);
    expect(DAILY_OFFLOAD_BUDGET.bytes).toBeGreaterThan(0);
    expect(DAILY_OFFLOAD_BUDGET.rows).toBeLessThanOrEqual(1000);
  });
});
