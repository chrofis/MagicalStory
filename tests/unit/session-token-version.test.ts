import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Session revocation (owner decision 2026-10-04, code review S1/S5): the JWT carries
 * users.token_version, authenticateToken compares it with the DB row and reads the role
 * fresh. A password reset / change / role change / Google merge bumps the version.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-session-token-version';
const jwt = nodeRequire('jsonwebtoken');
const db: any = nodeRequire('../../server/services/database.js');
const auth = nodeRequire('../../server/middleware/auth.js');

// users table stand-in: id -> { token_version, role }
let users: Record<string, { token_version: number; role: string }> = {};
let queryFails = false;
let queryCount = 0;
db.getPool = () => ({
  query: async (_sql: string, params: any[]) => {
    queryCount++;
    if (queryFails) throw new Error('db down');
    const u = users[String(params[0])];
    return { rows: u ? [u] : [] };
  },
});

const sign = (payload: any) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
const runAuth = async (token: string) => {
  const req: any = { headers: { authorization: `Bearer ${token}` }, path: '/x' };
  let status = 200; let body: any = null; let nexted = false;
  const res: any = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } };
  await auth.authenticateToken(req, res, () => { nexted = true; });
  return { req, status, body, nexted };
};

beforeEach(() => {
  users = {};
  queryFails = false;
  queryCount = 0;
  for (const id of ['u1', 'u2', 'admin1', 'target1', 'targetAdmin']) auth.invalidateAuthState(id);
});

describe('authenticateToken - token_version', () => {
  it('accepts a token whose version matches the DB row', async () => {
    users.u1 = { token_version: 3, role: 'user' };
    const r = await runAuth(sign({ id: 'u1', tv: 3, role: 'user' }));
    expect(r.nexted).toBe(true);
    expect(r.req.user.id).toBe('u1');
  });

  it('rejects a token issued before a version bump', async () => {
    users.u1 = { token_version: 4, role: 'user' };
    const r = await runAuth(sign({ id: 'u1', tv: 3, role: 'user' }));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('treats a token without a version (issued before the migration) as version 0', async () => {
    users.u1 = { token_version: 0, role: 'user' };
    expect((await runAuth(sign({ id: 'u1', role: 'user' }))).nexted).toBe(true);
    auth.invalidateAuthState('u1');
    users.u1 = { token_version: 1, role: 'user' };
    expect((await runAuth(sign({ id: 'u1', role: 'user' }))).nexted).toBe(false);
  });

  it('reads the role from the DB, so a demoted admin loses admin rights at once', async () => {
    users.admin1 = { token_version: 0, role: 'user' };
    const r = await runAuth(sign({ id: 'admin1', tv: 0, role: 'admin' }));
    expect(r.nexted).toBe(true);
    expect(r.req.user.role).toBe('user');
  });

  it('rejects a token for a deleted user', async () => {
    const r = await runAuth(sign({ id: 'ghost', tv: 0, role: 'user' }));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('fails closed with 503 when the lookup fails', async () => {
    queryFails = true;
    const r = await runAuth(sign({ id: 'u1', tv: 0, role: 'user' }));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(503);
  });

  it('caches the lookup briefly, and invalidateAuthState makes a bump effective immediately', async () => {
    users.u1 = { token_version: 0, role: 'user' };
    const token = sign({ id: 'u1', tv: 0, role: 'user' });
    await runAuth(token);
    await runAuth(token);
    expect(queryCount).toBe(1);
    users.u1 = { token_version: 1, role: 'user' };
    expect((await runAuth(token)).nexted).toBe(true); // still cached
    auth.invalidateAuthState('u1');
    expect((await runAuth(token)).nexted).toBe(false);
  });
});

describe('impersonation tokens', () => {
  const imp = (target: string) => sign({
    id: target, role: 'user', impersonating: true,
    originalAdminId: 'admin1', originalAdminRole: 'admin',
  });

  it('never carries an admin role copied from the target', async () => {
    users.admin1 = { token_version: 0, role: 'admin' };
    users.targetAdmin = { token_version: 0, role: 'admin' };
    const r = await runAuth(sign({
      id: 'targetAdmin', role: 'admin', impersonating: true,
      originalAdminId: 'admin1', originalAdminRole: 'admin',
    }));
    expect(r.nexted).toBe(true);
    expect(r.req.user.role).toBe('user');
    expect(auth.isAdminActing(r.req.user)).toBe(true); // authority comes from the original admin
  });

  it('stops working when the original admin is demoted', async () => {
    users.admin1 = { token_version: 0, role: 'user' };
    users.target1 = { token_version: 0, role: 'user' };
    const r = await runAuth(imp('target1'));
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('is accepted while the original admin is still an admin', async () => {
    users.admin1 = { token_version: 0, role: 'admin' };
    users.target1 = { token_version: 7, role: 'user' };
    const r = await runAuth(imp('target1'));
    expect(r.nexted).toBe(true);
    expect(r.req.user.impersonating).toBe(true);
  });
});

describe('generateToken / isAdminActing / requireAdminActing', () => {
  it('embeds the version and refuses a user row that lacks it', () => {
    const t = auth.generateToken({ id: 'u1', username: 'u', role: 'user', email: 'e', email_verified: true, token_version: 5 });
    expect(jwt.verify(t, process.env.JWT_SECRET).tv).toBe(5);
    expect(() => auth.generateToken({ id: 'u1', username: 'u', role: 'user' })).toThrow(/token_version/);
  });

  it('isAdminActing: admin yes, impersonating admin yes, plain user no, forged flag no', () => {
    expect(auth.isAdminActing({ role: 'admin' })).toBe(true);
    expect(auth.isAdminActing({ role: 'user', impersonating: true, originalAdminRole: 'admin' })).toBe(true);
    expect(auth.isAdminActing({ role: 'user' })).toBe(false);
    expect(auth.isAdminActing({ role: 'user', impersonating: true })).toBe(false);
    expect(auth.isAdminActing(undefined)).toBe(false);
  });

  it('requireAdminActing answers 403 to a plain owner', () => {
    let status = 0; let nexted = false;
    const res: any = { status(s: number) { status = s; return this; }, json() { return this; } };
    auth.requireAdminActing({ user: { role: 'user' } }, res, () => { nexted = true; });
    expect(status).toBe(403);
    expect(nexted).toBe(false);
  });
});

describe('role change (admin users route)', () => {
  it('bumps token_version so the old sessions die', async () => {
    const sqls: string[] = [];
    db.dbQuery = async (sql: string) => {
      sqls.push(sql);
      return /SELECT id, username, role/.test(sql) ? [{ id: 'u2', username: 'x', role: 'admin' }] : [];
    };
    db.logActivity = async () => {};
    db.isDatabaseMode = () => true;
    const usersRouter = nodeRequire('../../server/routes/admin/users.js');
    const r = usersRouter.router || usersRouter;
    const layer = r.stack.find((l: any) => l.route && l.route.path === '/:userId/role' && l.route.methods.post);
    const h = layer.route.stack[layer.route.stack.length - 1].handle;
    let code = 200;
    const res: any = { status(s: number) { code = s; return this; }, json() { return this; } };
    await h({ params: { userId: 'u2' }, body: { role: 'user' }, user: { id: 'admin1', username: 'a' } }, res);
    expect(code).toBe(200);
    expect(sqls.some(q => /UPDATE users SET role = \$1, token_version = token_version \+ 1/.test(q))).toBe(true);
  });
});
