import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Code review 2026-10 M3: `DELETE /api/admin/landmarks-cache`.
 * - admin session only (no `?secret=` — it would land in proxy and access logs)
 * - a `city` value is LIKE-escaped (`_` / `%` must not match every row)
 * - the full wipe of the judged landmark_index needs `?confirm=all`
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-landmarks-cache';
process.env.ADMIN_SECRET = 'the-old-query-secret';
const db: any = nodeRequire('../../server/services/database.js');

const queries: Array<{ sql: string; params: any[] | undefined }> = [];
db.isDatabaseMode = () => true;
db.getPool = () => ({
  query: async (sql: string, params?: any[]) => { queries.push({ sql, params }); return { rows: [], rowCount: 3 }; },
});

const { adminRoutes, initAdminRoutes } = nodeRequire('../../server/routes/admin.js');
const { authenticateToken, requireAdmin } = nodeRequire('../../server/middleware/auth.js');
initAdminRoutes({ userLandmarkCache: new Map() });

const layer = adminRoutes.stack.find((l: any) => l.route && l.route.path === '/landmarks-cache' && l.route.methods.delete);
const handlers: Function[] = layer.route.stack.map((s: any) => s.handle);

const mockRes = () => {
  const r: any = { code: 200, body: null };
  r.status = (s: number) => { r.code = s; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

/** Runs the route's handler chain the way express would; a preset req.user stands in for a verified session. */
async function run(req: any) {
  const res = mockRes();
  for (const h of handlers) {
    if (req.user && h === authenticateToken) continue;
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return res;
}

beforeEach(() => { queries.length = 0; });

describe('DELETE /api/admin/landmarks-cache', () => {
  it('is guarded by the admin session middleware, not a query-string secret', async () => {
    expect(handlers.slice(0, 2)).toEqual([authenticateToken, requireAdmin]);
    const res = await run({ query: { secret: 'the-old-query-secret' }, headers: {}, path: '/landmarks-cache' });
    expect(res.code).toBe(401);
    expect(queries).toEqual([]);
  });

  it('refuses a non-admin session', async () => {
    const res = await run({ query: { city: 'Baden' }, headers: { authorization: 'Bearer x' }, user: { id: 'u1', role: 'user' } });
    expect(res.code).toBe(403);
    expect(queries).toEqual([]);
  });

  it('escapes LIKE wildcards in the city value', async () => {
    const res = await run({ query: { city: '100%_x' }, headers: {}, user: { id: 'a1', role: 'admin' } });
    expect(res.code).toBe(200);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/LIKE \$1/);
    expect(queries[0].params).toEqual(['%100\\%\\_x%']);
  });

  it('refuses the full wipe without ?confirm=all', async () => {
    const res = await run({ query: {}, headers: {}, user: { id: 'a1', role: 'admin' } });
    expect(res.code).toBe(400);
    expect(queries).toEqual([]);
  });

  it('runs the full wipe only with ?confirm=all', async () => {
    const res = await run({ query: { confirm: 'all' }, headers: {}, user: { id: 'a1', role: 'admin' } });
    expect(res.code).toBe(200);
    expect(queries.map(q => q.sql)).toEqual(['DELETE FROM landmark_index']);
    expect(res.body.rowsDeleted).toBe(3);
  });
});
