import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Code review S1 / S5 / V1 on the auth routes: Google merge onto an unverified account,
 * Google email_verified claim, token_version bumps on reset/change, no domain auto-verify.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-auth-routes';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
const db: any = nodeRequire('../../server/services/database.js');

const queries: { sql: string; params: any[] }[] = [];
let googlePayload: any = {};
let poolRows: any[] = [];
db.isDatabaseMode = () => true;
db.logActivity = async () => {};
db.dbQuery = async (sql: string, params: any[]) => {
  queries.push({ sql, params });
  if (/INSERT INTO users \(id, username, email, password, role, story_quota, stories_generated, credits\)\s+VALUES/.test(sql) && /RETURNING role, story_quota, credits/.test(sql)) {
    return [{ role: 'user', story_quota: 2, credits: 200, token_version: 0 }];
  }
  if (/FROM users WHERE LOWER\(email\)/.test(sql)) return [];
  if (/ON CONFLICT \(username\)/.test(sql)) {
    return [{ id: 'g1', username: 'a@b.ch', email: 'a@b.ch', role: 'user', credits: 200, token_version: 1, email_verified: true, is_new_user: false }];
  }
  return [];
};
// auth.js destructures getPool at load, so tests swap behaviour through this variable.
let poolQuery: (sql: string, params: any[]) => Promise<{ rows: any[] }> = async () => ({ rows: poolRows });
db.getPool = () => ({
  query: async (sql: string, params: any[]) => {
    queries.push({ sql, params });
    return poolQuery(sql, params);
  },
});

const gal = nodeRequire('google-auth-library');
gal.OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => googlePayload });

const router = nodeRequire('../../server/routes/auth.js');
const authRouter = router.router || router;

const handler = (method: string, path: string) => {
  const l = authRouter.stack.find((x: any) => x.route && x.route.path === path && x.route.methods[method]);
  if (!l) throw new Error(`no ${method} ${path}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const mockRes = () => {
  const r: any = { code: 200, body: null };
  r.status = (s: number) => { r.code = s; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.cookie = () => r; r.clearCookie = () => r; r.redirect = () => r;
  return r;
};

beforeEach(() => { queries.length = 0; poolRows = []; poolQuery = async () => ({ rows: poolRows }); });

describe('S1: Google sign-in onto an existing account', () => {
  it('replaces the password and bumps token_version when the existing email was unverified', async () => {
    googlePayload = { sub: 'sub1', email: 'a@b.ch', email_verified: true };
    const res = mockRes();
    await handler('post', '/google')({ body: { idToken: 'x' }, ip: '1.1.1.1' }, res);
    expect(res.code).toBe(200);
    const upsert = queries.find(q => /ON CONFLICT \(username\)/.test(q.sql))!;
    // only a VERIFIED existing account keeps its password and sessions
    expect(upsert.sql).toMatch(/password = CASE WHEN users\.email_verified IS TRUE THEN users\.password ELSE EXCLUDED\.password END/);
    expect(upsert.sql).toMatch(/token_version = users\.token_version \+ CASE WHEN users\.email_verified IS TRUE THEN 0 ELSE 1 END/);
  });

  it('refuses a Google identity whose email Google has not verified', async () => {
    googlePayload = { sub: 'sub1', email: 'a@b.ch', email_verified: false };
    const res = mockRes();
    await handler('post', '/google')({ body: { idToken: 'x' }, ip: '1.1.1.1' }, res);
    expect(res.code).toBe(400);
    expect(queries.some(q => /ON CONFLICT/.test(q.sql))).toBe(false);
  });
});

describe('S5: password reset and change revoke sessions', () => {
  it('reset-password/confirm bumps token_version', async () => {
    poolRows = [{ id: 'u1', email: 'e@x.ch' }];
    const res = mockRes();
    await handler('post', '/reset-password/confirm')({ body: { token: 't', password: 'longenough1' } }, res);
    expect(res.code).toBe(200);
    expect(queries.some(q => /SET password = \$1.*token_version = token_version \+ 1/s.test(q.sql))).toBe(true);
  });

  it('change-password bumps the version and returns a fresh token for this session', async () => {
    const bcrypt = nodeRequire('bcryptjs');
    const hash = bcrypt.hashSync('oldpassword', 4);
    poolQuery = async (sql: string) => {
      if (/SELECT id, password, firebase_uid/.test(sql)) return { rows: [{ id: 'u1', password: hash }] };
      if (/RETURNING/.test(sql)) return { rows: [{ id: 'u1', username: 'u', email: 'e', role: 'user', email_verified: true, token_version: 2 }] };
      return { rows: [] };
    };
    const res = mockRes();
    await handler('post', '/change-password')({ body: { currentPassword: 'oldpassword', newPassword: 'newpassword1' }, user: { id: 'u1' } }, res);
    expect(res.code).toBe(200);
    expect(queries.some(q => /token_version = token_version \+ 1/.test(q.sql))).toBe(true);
    const jwt = nodeRequire('jsonwebtoken');
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET).tv).toBe(2);
  });
});

describe('V1: registration', () => {
  it('does not auto-verify an @magicalstory.ch address', async () => {
    const res = mockRes();
    await handler('post', '/register')({
      body: { email: 'demo-x@magicalstory.ch', password: 'longenough1', _formStartTime: String(Date.now() - 10000) },
      ip: '1.1.1.1',
    }, res);
    expect(res.code).toBe(200);
    expect(queries.some(q => /UPDATE users SET email_verified = TRUE/.test(q.sql))).toBe(false);
  });
});
