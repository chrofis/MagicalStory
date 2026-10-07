import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * GDPR erasure — ONE implementation (server/lib/userErasure.js) behind the CLI
 * and the admin route. Pins:
 *   - the dry run (planErasure) issues no write;
 *   - the live run is one BEGIN…COMMIT, hits every table it claims, in FK-safe
 *     order, and never DELETEs a retained table;
 *   - an R2 failure surfaces in the result instead of being swallowed;
 *   - the story delete route and the trial cleanup call deleteStoryDerivedRows;
 *   - the admin route refuses without the typed-back email;
 *   - GUARD: every migration table with a user_id / story_id column is named in
 *     ERASURE_COVERAGE, so a new table cannot drift past the erasure again.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-user-erasure';
process.env.R2_ACCOUNT_ID = 'acc';
process.env.R2_ACCESS_KEY_ID = 'k';
process.env.R2_SECRET_ACCESS_KEY = 's';
process.env.R2_BUCKET = 'test-bucket';
process.env.R2_PUBLIC_URL = 'https://images.example.test';

const r2: any = nodeRequire('../../server/lib/r2.js');
const r2Pending: any = nodeRequire('../../server/lib/r2Pending.js');
const db: any = nodeRequire('../../server/services/database.js');
const erasure: any = nodeRequire('../../server/lib/userErasure.js');

// The route modules destructure these at load time, so they are fixed before any require.
let poolImpl: any = { query: async () => ({ rows: [], rowCount: 0 }) };
db.isDatabaseMode = () => true;
db.logActivity = async () => {};
db.getPool = () => poolImpl;

// ---- stubs -----------------------------------------------------------------------------
const r2Calls: { fn: string; arg: string }[] = [];
let leftovers: Record<string, string[]> = {};
r2.listByPrefix = async (prefix: string) => {
  r2Calls.push({ fn: 'list', arg: prefix });
  return (leftovers[prefix] || []).map((key) => ({ key, size: 10 }));
};
let pruneOk = true;
r2Pending.prunePrefix = async (prefix: string) => { r2Calls.push({ fn: 'prunePrefix', arg: prefix }); return pruneOk ? 3 : 0; };
r2Pending.pruneObject = async (key: string) => { r2Calls.push({ fn: 'pruneObject', arg: key }); return pruneOk ? 1 : 0; };
r2Pending.pruneStory = async (id: string) => { r2Calls.push({ fn: 'pruneStory', arg: id }); return 0; };
r2Pending.pruneFileRows = async () => 0;

const USER = { id: 'u1', username: 'pat', email: 'Pat@Example.ch', referral_code: 'MagicPat123', referred_by: null, created_at: new Date(), anonymous: false };

/** A pg client that records every statement and answers the module's reads. */
function fakeClient(opts: { failOn?: RegExp } = {}) {
  const sql: { text: string; params: any[] }[] = [];
  const client = {
    sql,
    async query(text: string, params: any[] = []) {
      sql.push({ text, params });
      if (opts.failOn && opts.failOn.test(text)) throw new Error('boom');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM users WHERE (id|LOWER\(email\)) = /.test(text) && /SELECT id, username/.test(text)) return { rows: [USER], rowCount: 1 };
      if (/SELECT 1 FROM users WHERE id = \$1/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM story_jobs WHERE user_id = \$1 AND status IN/.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM stripe_webhook_retry WHERE processed_at IS NULL/.test(text)) return { rows: [], rowCount: 0 };
      if (/^SELECT id FROM stories WHERE user_id/.test(text)) return { rows: [{ id: 's1' }, { id: 's2' }], rowCount: 2 };
      if (/^SELECT id FROM story_jobs WHERE user_id/.test(text)) return { rows: [{ id: 's1' }, { id: 'job_failed_early' }], rowCount: 2 };
      if (/^SELECT id, file_url FROM files/.test(text)) return { rows: [{ id: 'f1', file_url: 'https://images.example.test/orders/f1.pdf' }], rowCount: 1 };
      if (/FROM orders WHERE user_id = \$1 ORDER BY/.test(text)) return { rows: [{ id: 7, stripe_session_id: 'cs_7', gelato_order_id: 'g7', amount_total: 4900, currency: 'CHF', payment_status: 'paid', created_at: new Date() }], rowCount: 1 };
      if (/SELECT image_url FROM story_images/.test(text)) return { rows: [{ image_url: 'https://images.example.test/stories/s1/scene/p1/v0.jpg' }], rowCount: 1 };
      if (/SELECT id FROM users WHERE LOWER\(referred_by\)/.test(text)) return { rows: [{ id: 'other' }], rowCount: 1 };
      if (/COUNT\(\*\)/.test(text) || /SUM\(/.test(text)) return { rows: [{ n: 2 }], rowCount: 1 };
      if (/^INSERT INTO users/.test(text)) return { rows: [], rowCount: 1 };
      if (/^(DELETE|UPDATE|INSERT)/.test(text)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

const writes = (sql: { text: string }[]) => sql.filter((s) => /^(BEGIN|COMMIT|ROLLBACK|DELETE|UPDATE|INSERT)/i.test(s.text));
const idx = (sql: { text: string }[], re: RegExp) => sql.findIndex((s) => re.test(s.text));

beforeEach(() => { r2Calls.length = 0; leftovers = {}; pruneOk = true; });

// ---- dry run ----------------------------------------------------------------------------
describe('dry run', () => {
  it('planErasure issues no write of any kind and counts every table', async () => {
    const client = fakeClient();
    const out = await erasure.eraseUser(client, { email: 'pat@example.ch', apply: false });
    expect(out.dryRun).toBe(true);
    expect(writes(client.sql)).toEqual([]);
    expect(out.plan.storyIds).toEqual(['s1', 's2']);
    // a job that failed before its story row existed is still swept for derived rows
    expect(out.plan.derivedIds).toContain('job_failed_early');
    for (const t of erasure.STORY_DERIVED_DELETE) expect(out.plan.counts.storyDerived[t]).toBe(2);
    for (const k of ['email_sends', 'email_events', 'idea_events', 'trial_events', 'logs', 'files', 'characters']) {
      expect(out.plan.counts.owned[k]).toBe(2);
    }
    expect(out.plan.r2.pdfKeys).toEqual(['orders/f1.pdf']);
    expect(out.plan.r2.prefixes.map((p: any) => p.prefix)).toEqual(['characters/u1/', 'stories/u1/', 'stories/s1/', 'stories/s2/']);
    expect(out.plan.referral.referees).toBe(1);
  });

  it('refuses when R2 points at a different bucket than the database serves', async () => {
    const client = fakeClient();
    const orig = client.query.bind(client);
    client.query = async (text: string, params: any[]) => (/SELECT image_url/.test(text)
      ? { rows: [{ image_url: 'https://images-staging.example.test/stories/s1/x.jpg' }], rowCount: 1 }
      : orig(text, params));
    await expect(erasure.eraseUser(client, { email: 'pat@example.ch' })).rejects.toMatchObject({ code: 'ERASURE_R2_UNAVAILABLE' });
    expect(writes(client.sql)).toEqual([]);
  });

  it('a blocker (in-flight job) is ERASURE_PREFLIGHT, before any R2 listing', async () => {
    const client = fakeClient();
    const orig = client.query.bind(client);
    client.query = async (text: string, params: any[]) => (/status IN \('pending'/.test(text)
      ? { rows: [{ id: 'j9', status: 'running' }], rowCount: 1 }
      : orig(text, params));
    await expect(erasure.eraseUser(client, { email: 'pat@example.ch' })).rejects.toMatchObject({ code: 'ERASURE_PREFLIGHT' });
    expect(r2Calls).toEqual([]);
  });
});

// ---- the transaction ----------------------------------------------------------------------
describe('executeErasure', () => {
  async function run() {
    const client = fakeClient();
    const out = await erasure.eraseUser(client, { email: 'pat@example.ch', apply: true, actor: 'admin', environment: 'test' });
    return { client, out };
  }

  it('is one BEGIN … COMMIT with no statement outside it', async () => {
    const { client } = await run();
    const w = writes(client.sql);
    expect(w[0].text).toBe('BEGIN');
    expect(w[w.length - 1].text).toBe('COMMIT');
    expect(w.filter((s) => /^(BEGIN|COMMIT)$/.test(s.text))).toHaveLength(2);
    // nothing written before BEGIN or after COMMIT
    const b = idx(client.sql, /^BEGIN$/); const c = idx(client.sql, /^COMMIT$/);
    expect(client.sql.slice(0, b).filter((s) => /^(DELETE|UPDATE|INSERT)/.test(s.text))).toEqual([]);
    expect(client.sql.slice(c + 1).filter((s) => /^(DELETE|UPDATE|INSERT)/.test(s.text))).toEqual([]);
  });

  it('hits every table ERASURE_COVERAGE says it deletes, and never DELETEs a retained one', async () => {
    const { client } = await run();
    const deletes = client.sql.filter((s) => /^DELETE FROM/.test(s.text)).map((s) => /^DELETE FROM (\w+)/.exec(s.text)![1]);
    const expectDeleted = Object.entries(erasure.ERASURE_COVERAGE)
      .filter(([, how]) => String(how).startsWith('delete') || String(how).startsWith('story-derived'))
      .map(([t]) => t);
    for (const t of expectDeleted) expect(deletes, `DELETE FROM ${t}`).toContain(t);
    for (const t of erasure.RETAINED_TABLES) expect(deletes, `must never DELETE FROM ${t}`).not.toContain(t);
    // the cascade claims are not deleted by us
    for (const [t, how] of Object.entries(erasure.ERASURE_COVERAGE)) {
      if (String(how).startsWith('cascade')) expect(deletes).not.toContain(t);
    }
  });

  it('runs in FK-safe order: retained rows are detached before DELETE FROM users, events before sends, derived before stories', async () => {
    const { client } = await run();
    const s = client.sql;
    const users = idx(s, /^DELETE FROM users/);
    expect(idx(s, /^UPDATE orders SET user_id = NULL/)).toBeLessThan(users);
    expect(idx(s, /^UPDATE credit_transactions SET user_id = \$1, description = NULL, reference_id = NULL/)).toBeLessThan(users);
    expect(idx(s, /^UPDATE referral_payouts SET user_id = \$1, description = NULL/)).toBeLessThan(users);
    expect(idx(s, /^INSERT INTO users/)).toBeLessThan(idx(s, /^UPDATE credit_transactions/));
    expect(idx(s, /^DELETE FROM email_events/)).toBeLessThan(idx(s, /^DELETE FROM email_sends/));
    expect(idx(s, /^DELETE FROM eval_calls/)).toBeLessThan(idx(s, /^DELETE FROM stories/));
    // the receipt is written after the per-user logs sweep and before COMMIT
    const receipt = idx(s, /^INSERT INTO logs/);
    expect(receipt).toBeGreaterThan(idx(s, /^DELETE FROM logs/));
    expect(receipt).toBeLessThan(idx(s, /^COMMIT$/));
    expect(users).toBe(s.length - 3); // users is the last DELETE: receipt INSERT and COMMIT follow
  });

  it('email rows go by recipient address as well as user id, case-insensitively', async () => {
    const { client } = await run();
    const sends = client.sql.find((s) => /^DELETE FROM email_sends/.test(s.text))!;
    expect(sends.text).toMatch(/LOWER\(recipient\) = LOWER\(\$2\)/);
    expect(sends.params).toEqual(['u1', 'Pat@Example.ch']);
  });

  it('the receipt names the id only — never the email or username', async () => {
    const { client } = await run();
    const receipt = client.sql.find((s) => /^INSERT INTO logs/.test(s.text))!;
    expect(receipt.params[2]).toBe('GDPR_ERASURE');
    expect(receipt.params[3]).not.toMatch(/example\.ch|pat/i);
    expect(JSON.parse(receipt.params[3]).erasedUserId).toBe('u1');
  });

  it('rolls back and rethrows when a statement fails; R2 is never touched', async () => {
    const client = fakeClient({ failOn: /^DELETE FROM characters/ });
    await expect(erasure.eraseUser(client, { email: 'pat@example.ch', apply: true })).rejects.toThrow('boom');
    const w = writes(client.sql).map((s) => s.text);
    expect(w[w.length - 1]).toBe('ROLLBACK');
    expect(w).not.toContain('COMMIT');
    expect(r2Calls.filter((c) => c.fn !== 'list')).toEqual([]);
  });
});

// ---- R2 after commit ----------------------------------------------------------------------
describe('R2 after COMMIT', () => {
  it('prunes every prefix and PDF key, re-lists, and reports complete', async () => {
    const client = fakeClient();
    const out = await erasure.eraseUser(client, { email: 'pat@example.ch', apply: true });
    expect(out.complete).toBe(true);
    expect(out.r2.failures).toEqual([]);
    expect(r2Calls.filter((c) => c.fn === 'prunePrefix').map((c) => c.arg)).toEqual(['characters/u1/', 'stories/u1/', 'stories/s1/', 'stories/s2/']);
    expect(r2Calls.filter((c) => c.fn === 'pruneObject').map((c) => c.arg)).toEqual(['orders/f1.pdf']);
    // every prune happens after COMMIT (the plan's listing happened before BEGIN)
    expect(out.r2.deleted).toBe(13);
  });

  it('a surviving object or a failed PDF delete surfaces in the result, not in a log line only', async () => {
    pruneOk = false;
    leftovers = { 'characters/u1/': ['characters/u1/c1/photos/front.jpg'] };
    const client = fakeClient();
    const out = await erasure.eraseUser(client, { email: 'pat@example.ch', apply: true });
    expect(out.complete).toBe(false);
    expect(out.r2.failures.some((f: string) => /orders\/f1\.pdf/.test(f))).toBe(true);
    expect(out.r2.failures.some((f: string) => /1 object\(s\) survive under characters\/u1\//.test(f))).toBe(true);
    // the database half still committed — the caller must say "incomplete", not "failed"
    expect(writes(client.sql).map((s) => s.text)).toContain('COMMIT');
  });
});

// ---- deleteStoryDerivedRows --------------------------------------------------------------
describe('deleteStoryDerivedRows', () => {
  it('deletes every content table and unlinks the event logs, with no statement for an empty list', async () => {
    const client = fakeClient();
    const counts = await erasure.deleteStoryDerivedRows(client, ['s1']);
    const dels = client.sql.filter((s) => /^DELETE FROM/.test(s.text)).map((s) => /^DELETE FROM (\w+)/.exec(s.text)![1]);
    expect(dels).toEqual(erasure.STORY_DERIVED_DELETE);
    for (const t of erasure.STORY_DERIVED_UNLINK) {
      expect(client.sql.some((s) => s.text === `UPDATE ${t} SET story_id = NULL WHERE story_id = ANY($1)`)).toBe(true);
      expect(counts[`${t} (unlinked)`]).toBe(1);
    }
    const empty = fakeClient();
    expect(await erasure.deleteStoryDerivedRows(empty, [])).toEqual({});
    expect(empty.sql).toEqual([]);
  });
});

// ---- callers ----------------------------------------------------------------------------
describe('the story delete route and the trial cleanup use deleteStoryDerivedRows', () => {
  it('DELETE /api/stories/:id sweeps the derived tables after the story row', async () => {
    const poolSql: string[] = [];
    db.dbQuery = async (sql: string) => (/^DELETE FROM stories/.test(sql) ? { rowCount: 1 } : []);
    poolImpl = { query: async (sql: string) => { poolSql.push(sql); return { rows: [], rowCount: 0 }; } };
    const storiesRouter = nodeRequire('../../server/routes/stories.js');
    const layer = storiesRouter.stack.find((l: any) => l.route && l.route.path === '/:id' && l.route.methods.delete);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res: any = { code: 200, body: null, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } };
    await handler({ params: { id: 's1' }, user: { id: 'u1', username: 'pat' } }, res);
    expect(res.code).toBe(200);
    for (const t of erasure.STORY_DERIVED_DELETE) expect(poolSql).toContain(`DELETE FROM ${t} WHERE story_id = ANY($1)`);
  });

  it('trial.js and stories.js both import the shared sweep (source pin)', () => {
    for (const f of ['server/routes/stories.js', 'server/routes/trial.js']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../', f), 'utf8');
      expect(src, f).toMatch(/require\('\.\.\/lib\/userErasure'\)/);
      expect(src, f).toMatch(/await deleteStoryDerivedRows\(/);
    }
  });
});

describe('DELETE /api/admin/users/:userId', () => {
  const usersRouter = nodeRequire('../../server/routes/admin/users.js');
  const layer = usersRouter.stack.find((l: any) => l.route && l.route.path === '/:userId' && l.route.methods.delete);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const mockRes = () => ({ code: 200, body: null as any, status(c: number) { this.code = c; return this; }, json(b: any) { this.body = b; return this; } });
  let client: any;
  beforeEach(() => {
    client = fakeClient();
    poolImpl = { connect: async () => ({ ...client, release() {} }) };
  });

  it('is admin-only by construction (requireAdmin precedes the handler)', () => {
    expect(layer.route.stack.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses without confirmEmail, and on a mismatch, writing nothing', async () => {
    const res = mockRes();
    await handler({ params: { userId: 'u1' }, user: { id: 'admin', username: 'root', role: 'admin' }, body: {} }, res);
    expect(res.code).toBe(400);
    expect(writes(client.sql)).toEqual([]);
    const res2 = mockRes();
    await handler({ params: { userId: 'u1' }, user: { id: 'admin', username: 'root', role: 'admin' }, body: { confirmEmail: 'someone@else.ch' } }, res2);
    expect(res2.code).toBe(400);
    expect(res2.body.error).toMatch(/does not match/);
    expect(writes(client.sql)).toEqual([]);
  });

  it('with the typed-back address runs the one erasure: transaction, no orders delete, R2 result reported', async () => {
    const res = mockRes();
    await handler({ params: { userId: 'u1' }, user: { id: 'admin', username: 'root', role: 'admin' }, body: { confirmEmail: ' pat@example.ch ' } }, res);
    expect(res.code).toBe(200);
    expect(res.body.complete).toBe(true);
    expect(res.body.deletedCounts.users).toBe(1);
    expect(res.body.followUp).toEqual({ stripeSessions: ['cs_7'], gelatoOrders: ['g7'] });
    const w = writes(client.sql).map((s) => s.text);
    expect(w[0]).toBe('BEGIN');
    expect(w.some((t) => /^DELETE FROM orders/.test(t))).toBe(false);
    expect(w.some((t) => /^UPDATE orders SET user_id = NULL/.test(t))).toBe(true);
    expect(client.sql.find((s) => /^INSERT INTO logs/.test(s.text))!.params[1]).toBe('root');
  });

  it('reports an incomplete R2 half with complete:false and the failures', async () => {
    pruneOk = false;
    const res = mockRes();
    await handler({ params: { userId: 'u1' }, user: { id: 'admin', username: 'root', role: 'admin' }, body: { confirmEmail: 'pat@example.ch' } }, res);
    expect(res.code).toBe(200);
    expect(res.body.complete).toBe(false);
    expect(res.body.r2Failures.length).toBeGreaterThan(0);
  });
});

// ---- the guard --------------------------------------------------------------------------
describe('GUARD: every migration table with a user_id / story_id column is covered', () => {
  const dir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const tables = new Map<string, { file: string; body: string }>();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g)) tables.set(m[1], { file: f, body: m[2] });
    for (const m of sql.matchAll(/DROP TABLE IF EXISTS (\w+)/g)) tables.delete(m[1]);
    // a column added later counts too
    for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w*(?:user_id|story_id))\b/g)) {
      const t = tables.get(m[1]); if (t) t.body += `\n${m[2]} VARCHAR`;
    }
  }
  const keyed = [...tables].filter(([, t]) => /^\s*\w*(user_id|story_id)\s/m.test(t.body));

  it('finds the schema (sanity)', () => {
    expect(tables.has('email_sends')).toBe(true);
    expect(tables.has('avatar_sheet_set_members')).toBe(false); // dropped in 012
    expect(keyed.length).toBeGreaterThan(20);
  });

  it('names every user_id / story_id table in ERASURE_COVERAGE', () => {
    const missing = keyed.map(([name]) => name).filter((name) => !(name in erasure.ERASURE_COVERAGE));
    expect(missing, 'add each to server/lib/userErasure.js (delete / retain / cascade / story-derived) and to the transaction').toEqual([]);
  });

  it('lists no table the migrations do not create', () => {
    const phantom = Object.keys(erasure.ERASURE_COVERAGE).filter((t) => !tables.has(t));
    expect(phantom).toEqual([]);
  });

  it('every story_id column without an FK to stories is swept by deleteStoryDerivedRows (or is a retained/owned table)', () => {
    const ownedOrRetained = new Set(['orders', 'files']);
    const noFk = keyed
      .filter(([, t]) => /^\s*story_id\s/m.test(t.body) && !/story_id[^,]*REFERENCES stories\(id\)/.test(t.body))
      .map(([name]) => name)
      .filter((name) => !ownedOrRetained.has(name));
    const swept = new Set([...erasure.STORY_DERIVED_DELETE, ...erasure.STORY_DERIVED_UNLINK]);
    expect(noFk.filter((n) => !swept.has(n))).toEqual([]);
    for (const t of erasure.STORY_DERIVED_DELETE) expect(noFk, `${t} has an FK now — drop it from STORY_DERIVED_DELETE`).toContain(t);
  });

  it('every "cascade from stories/story_jobs" claim is backed by ON DELETE CASCADE in the schema', () => {
    for (const [t, how] of Object.entries(erasure.ERASURE_COVERAGE)) {
      const m = /^cascade from (\w+)/.exec(String(how));
      if (!m) continue;
      const body = tables.get(t)!.body;
      expect(body, `${t}`).toMatch(new RegExp(`REFERENCES ${m[1]}\\(id\\) ON DELETE CASCADE`));
    }
  });
});
