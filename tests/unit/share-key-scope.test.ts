import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Share ?key= scope (owner decision 2026-10-04, code review S2/S4): the signed email-link
 * key unlocks the first-paint header (title, cover) and nothing else; the full story needs
 * the owner's login or an active public share. An admin draft is hidden everywhere,
 * header included.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-share-key-scope';
const db: any = nodeRequire('../../server/services/database.js');

const TOKEN = 'a'.repeat(64);
let row: any;

// Evaluates the access predicate the real SQL expresses, from the SQL text + params.
db.dbQuery = async (sql: string, params: any[]) => {
  if (!/FROM stories/.test(sql)) return [];
  const notDraft = !/NOT admin_draft/.test(sql) || !row.admin_draft;
  const keyClause = /\$3 = true/.test(sql) && params[2] === true;
  const allowed = notDraft && (keyClause || row.is_shared || row.user_id === params[1]);
  if (!allowed) return [];
  return [{ ...row, page_count: 1, language: 'en', language_level: 'standard', layout: null }];
};
db.imagesExistByType = async () => new Set();
db.getActiveVersion = async () => 0;
db.getStoryImage = async () => null;

const { sign } = nodeRequire('../../server/lib/shareLinkSig.js');
const { apiRouter } = nodeRequire('../../server/routes/sharing.js');

function handler(path: string) {
  const layer = apiRouter.stack.find((l: any) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`no GET ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function call(path: string, query: any, user?: any) {
  const req: any = { params: { shareToken: TOKEN }, query, headers: {}, user };
  let status = 200; let body: any = null;
  const res: any = {
    status(s: number) { status = s; return this; },
    json(b: any) { body = b; return this; },
    set() { return this; }, type() { return this; }, send(b: any) { body = b; return this; },
    redirect() { return this; },
  };
  await handler(path)(req, res);
  return { status, body };
}

beforeEach(() => {
  row = { id: 's1', user_id: 'owner', is_shared: false, admin_draft: false, title: 'My Story', data: { title: 'My Story', sceneImages: [] } };
});

describe('signed share key scope', () => {
  const key = () => sign(TOKEN);

  it('the key unlocks the header (first paint) for a private story', async () => {
    const r = await call('/shared/:shareToken/header', { key: key() });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('My Story');
  });

  it('the key does NOT unlock the full story', async () => {
    const r = await call('/shared/:shareToken', { key: key() });
    expect(r.status).toBe(404);
  });

  it('without a key or login the header is 404 too', async () => {
    expect((await call('/shared/:shareToken/header', {})).status).toBe(404);
  });

  it('the owner (logged in) still gets the full story', async () => {
    const r = await call('/shared/:shareToken', {}, { id: 'owner' });
    expect(r.status).toBe(200);
  });

  it('a public share still serves the full story without a key', async () => {
    row.is_shared = true;
    expect((await call('/shared/:shareToken', {})).status).toBe(200);
  });

  it('S4: the header never serves an admin draft, key or not', async () => {
    row.admin_draft = true;
    expect((await call('/shared/:shareToken/header', { key: key() })).status).toBe(404);
    expect((await call('/shared/:shareToken/header', {}, { id: 'owner' })).status).toBe(404);
  });
});
