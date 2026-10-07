/**
 * Visit linkage after an email claim (server/routes/trial.js recordTrialEvent).
 *
 * The visit id lives in localStorage. The email verification link is opened
 * wherever the mail client opens it — usually NOT the browser context that ran
 * the trial — so EmailVerified.tsx minted a fresh visit id there and the
 * terminal `account_created` landed on a one-row visit with no landing, while
 * the real trail never converted (BACKLOG, seen 2026-09-03 / 09-07).
 *
 * Rule: an event that carries a verified user token is written to the EARLIEST
 * visit that already carries that user (user_id is attached server-side at
 * character_saved and back-filled); a user with no row yet keeps the client's
 * visit id. The client's visit id is never trusted over the user's own trail.
 */
import { describe, it, expect, beforeEach } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-visit-linkage';

const db = require('../../server/services/database');
const { signToken } = require('../../server/middleware/auth');

type Call = { sql: string; params: any[] };
let calls: Call[] = [];
let ownedVisitRows: any[] = [];
let insertCount = 1;

const fakePool = {
  query: async (sql: string, params: any[]) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/^SELECT visit_id FROM trial_events WHERE user_id/.test(sql)) return { rows: ownedVisitRows, rowCount: ownedVisitRows.length };
    if (/^INSERT INTO trial_events/.test(sql)) return { rows: [], rowCount: insertCount };
    return { rows: [], rowCount: 0 };
  },
};
// The route module does `const { getPool } = require('../services/database')`
// at call time, so swapping the export is enough — no DB in this test.
db.getPool = () => fakePool;

const trial = require('../../server/routes/trial.js');
const { recordTrialEvent } = trial;

const CLIENT_VISIT = '11111111-1111-4111-8111-111111111111';
const OWNED_VISIT = '22222222-2222-4222-8222-222222222222';

const inserted = () => calls.find((c) => c.sql.startsWith('INSERT INTO trial_events'));
const backfill = () => calls.find((c) => c.sql.startsWith('UPDATE trial_events SET user_id'));
const lookup = () => calls.find((c) => c.sql.startsWith('SELECT visit_id FROM trial_events WHERE user_id'));

beforeEach(() => {
  calls = [];
  ownedVisitRows = [];
  insertCount = 1;
});

describe('recordTrialEvent — which visit an event lands on', () => {
  it('anonymous event: the client visit id, no lookup', async () => {
    await recordTrialEvent({ visitId: CLIENT_VISIT, step: 'landing' });
    expect(lookup()).toBeUndefined();
    expect(inserted()!.params[0]).toBe(CLIENT_VISIT);
    expect(inserted()!.params[10]).toBeNull();
    expect(backfill()).toBeUndefined();
  });

  it('authenticated event from a fresh browser context: attached to the visit that carries the user', async () => {
    ownedVisitRows = [{ visit_id: OWNED_VISIT }];
    await recordTrialEvent({ visitId: CLIENT_VISIT, step: 'account_created', userId: 'u1', meta: { method: 'email' } });
    expect(lookup()!.params).toEqual(['u1']);
    expect(lookup()!.sql).toContain('ORDER BY created_at ASC LIMIT 1');
    expect(inserted()!.params[0]).toBe(OWNED_VISIT);
    expect(inserted()!.params[10]).toBe('u1');
    // The back-fill targets the owned visit too, never the throwaway one.
    expect(backfill()!.params).toEqual(['u1', OWNED_VISIT]);
  });

  it('authenticated event from the original context: same visit, nothing re-pointed', async () => {
    ownedVisitRows = [{ visit_id: CLIENT_VISIT }];
    await recordTrialEvent({ visitId: CLIENT_VISIT, step: 'generation_completed', userId: 'u1' });
    expect(inserted()!.params[0]).toBe(CLIENT_VISIT);
    expect(backfill()!.params).toEqual(['u1', CLIENT_VISIT]);
  });

  it('first authenticated event of a user (character_saved): no owned visit yet, the client visit id stands', async () => {
    ownedVisitRows = [];
    await recordTrialEvent({ visitId: CLIENT_VISIT, step: 'character_saved', userId: 'u1' });
    expect(lookup()).toBeDefined();
    expect(inserted()!.params[0]).toBe(CLIENT_VISIT);
    expect(backfill()!.params).toEqual(['u1', CLIENT_VISIT]);
  });

  it('a duplicate step on the owned visit is absorbed by the unique index, not written twice', async () => {
    ownedVisitRows = [{ visit_id: OWNED_VISIT }];
    insertCount = 0;
    const written = await recordTrialEvent({ visitId: CLIENT_VISIT, step: 'account_created', userId: 'u1' });
    expect(written).toBe(false);
    expect(inserted()!.sql).toContain('ON CONFLICT (visit_id, step) DO NOTHING');
  });
});

describe('POST /api/trial/event — the token decides the user, the user decides the visit', () => {
  const layer = trial.stack.find((l: any) => l.route?.path === '/event' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { status() { return this; }, end() {} };
  const call = (body: any, headers: Record<string, string> = {}) =>
    handler({ body, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', ...headers } }, res);

  it('a full account token (the verification context) lands the event on the owned visit', async () => {
    ownedVisitRows = [{ visit_id: OWNED_VISIT }];
    const token = signToken({ id: 'u1', userId: 'u1', tv: 0 });
    await call({ visitId: CLIENT_VISIT, step: 'account_created', meta: { method: 'email' } }, { authorization: `Bearer ${token}` });
    expect(inserted()!.params[0]).toBe(OWNED_VISIT);
    expect(inserted()!.params[10]).toBe('u1');
    expect(inserted()!.params[11]).toBe(JSON.stringify({ method: 'email' }));
  });

  it('a body-supplied user id is never trusted: without a token the event is anonymous on the client visit', async () => {
    ownedVisitRows = [{ visit_id: OWNED_VISIT }];
    await call({ visitId: CLIENT_VISIT, step: 'account_created', userId: 'u1' });
    expect(lookup()).toBeUndefined();
    expect(inserted()!.params[0]).toBe(CLIENT_VISIT);
    expect(inserted()!.params[10]).toBeNull();
  });

  it('a garbage token stays anonymous rather than failing the event', async () => {
    await call({ visitId: CLIENT_VISIT, step: 'landing' }, { authorization: 'Bearer not-a-jwt' });
    expect(inserted()!.params[0]).toBe(CLIENT_VISIT);
    expect(inserted()!.params[10]).toBeNull();
  });
});
