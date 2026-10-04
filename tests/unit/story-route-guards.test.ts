import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Code review batch 3 (R7, R8, R9, R10, X1, S6, R12): owner-side story routes.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-story-route-guards';
process.env.R2_PUBLIC_URL = 'https://images.example.test';
const db: any = nodeRequire('../../server/services/database.js');

// ---- fakes the route modules destructure at load time -----------------------------------
const draftIds = new Set<string>();
let draftQueries = 0;
const calls: any = { saveStoryImage: [], setActiveVersion: [], saveStoryData: [] };
db.isDatabaseMode = () => true;
db.dbQuery = async (sql: string, params: any[]) => {
  if (/AND admin_draft/.test(sql)) {
    draftQueries++;
    return draftIds.has(`${params[1]}:${params[0]}`) ? [{ '?column?': 1 }] : [];
  }
  return [];
};
db.getPool = () => ({
  query: async (sql: string) => {
    if (/SELECT \* FROM stories/.test(sql)) {
      return { rows: [{ id: 's1', user_id: 'admin1', data: { sceneImages: [{ pageNumber: 2, imageData: 'old', imageVersions: [{ imageData: 'old' }] }] } }] };
    }
    return { rows: [] };
  },
});
db.rehydrateStoryImages = async (_id: string, d: any) => d;
db.getNextVersionIndex = async () => 4;
db.saveStoryImage = async (...a: any[]) => { calls.saveStoryImage.push(a); };
db.setActiveVersion = async (...a: any[]) => { calls.setActiveVersion.push(a); };
db.saveStoryData = async (...a: any[]) => { calls.saveStoryData.push(a); };

const auth = nodeRequire('../../server/middleware/auth.js');
const { hideAdminDraftFromOwner } = nodeRequire('../../server/middleware/storyAccess.js');
const storiesRouter = nodeRequire('../../server/routes/stories.js');
const photosRouter = nodeRequire('../../server/routes/photos.js');
const pdf = nodeRequire('../../server/lib/pdf.js');

const routeLayer = (router: any, method: string, path: string) =>
  router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
const handles = (router: any, method: string, path: string): Function[] => {
  const l = routeLayer(router, method, path);
  if (!l) throw new Error(`no ${method} ${path}`);
  return l.route.stack.map((s: any) => s.handle);
};
const mockRes = () => {
  const r: any = { code: 200, body: null };
  r.status = (s: number) => { r.code = s; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

beforeEach(() => { draftIds.clear(); draftQueries = 0; calls.saveStoryImage = []; calls.setActiveVersion = []; calls.saveStoryData = []; });

describe('R7: owner of an unpublished admin draft', () => {
  const run = async (user: any, id: string) => {
    const res = mockRes(); let nexted = false;
    await hideAdminDraftFromOwner({ user, params: { id } }, res, () => { nexted = true; });
    return { res, nexted };
  };

  it('gets 404 on any /:id route', async () => {
    draftIds.add('owner1:draft-1');
    const r = await run({ id: 'owner1', role: 'user' }, 'draft-1');
    expect(r.nexted).toBe(false);
    expect(r.res.code).toBe(404);
  });

  it('is not blocked on a normal story', async () => {
    expect((await run({ id: 'owner1', role: 'user' }, 'story-9')).nexted).toBe(true);
  });

  it('admins and impersonating admins keep access to drafts without a query', async () => {
    draftIds.add('admin1:draft-2');
    expect((await run({ id: 'admin1', role: 'admin' }, 'draft-2')).nexted).toBe(true);
    expect((await run({ id: 'target', role: 'user', impersonating: true, originalAdminRole: 'admin' }, 'draft-2')).nexted).toBe(true);
    expect(draftQueries).toBe(0);
  });

  it('is mounted on the stories router before the first /:id/... route', () => {
    const stack = storiesRouter.stack;
    const useIdx = stack.findIndex((l: any) => !l.route && l.handle === hideAdminDraftFromOwner);
    const metaIdx = stack.findIndex((l: any) => l.route && l.route.path === '/:id/quick-metadata');
    expect(useIdx).toBeGreaterThan(-1);
    expect(useIdx).toBeLessThan(metaIdx);
    expect(stack[useIdx - 1].handle).toBe(auth.authenticateToken); // sets req.user first
  });
});

describe('R8: developer/eval endpoints', () => {
  const devRoutes = ['/:id/dev-metadata', '/:id/evaluation-data', '/:id/entity-grid-image', '/:id/dev-image',
    '/:id/avatar-generation-image', '/:id/retry-images/:pageNumber', '/:id/garment-colour/:pageNumber',
    '/:id/composite-stages/:pageNumber', '/:id/reference-sheet-sources'];
  for (const p of devRoutes) {
    it(`${p} requires an admin or impersonating admin`, () => {
      expect(handles(storiesRouter, 'get', p)).toContain(auth.requireAdminActing);
    });
  }
});

describe('X1: debug routes', () => {
  it('use requireAdmin (no token carries req.user.isAdmin)', () => {
    expect(handles(storiesRouter, 'get', '/debug/:id')).toContain(auth.requireAdmin);
    expect(handles(storiesRouter, 'get', '/debug/:id/images')).toContain(auth.requireAdmin);
  });
});

describe('R9: POST /api/stories', () => {
  it('no longer exists (no caller; it stored any client blob)', () => {
    expect(routeLayer(storiesRouter, 'post', '/')).toBeUndefined();
  });
});

describe('S6: /api/photos/status', () => {
  it('requires admin', () => {
    expect(handles(photosRouter, 'get', '/status')).toContain(auth.requireAdmin);
  });
});

describe('R10: admin page-image replace', () => {
  it('writes a new story_images version and pins it active, not just the blob', async () => {
    const hs = handles(storiesRouter, 'patch', '/:id/page/:pageNum');
    const res = mockRes();
    await hs[hs.length - 1]({
      params: { id: 's1', pageNum: '2' },
      body: { imageData: 'data:image/jpeg;base64,NEW' },
      user: { id: 'admin1', username: 'a', role: 'admin' },
    }, res);
    expect(res.code).toBe(200);
    expect(calls.saveStoryImage).toHaveLength(1);
    const [storyId, type, page, data, opts] = calls.saveStoryImage[0];
    expect([storyId, type, page, data, opts.versionIndex]).toEqual(['s1', 'scene', 2, 'data:image/jpeg;base64,NEW', 4]);
    expect(calls.setActiveVersion).toEqual([['s1', '2', 4, { pinned: true }]]);
  });
});

describe('R12: PDF image fetch', () => {
  it('refuses a URL outside the R2 bucket', async () => {
    await expect(pdf.resolveImageBuffer('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/not on the R2 bucket/);
    await expect(pdf.resolveImageBuffer('https://evil.example/x.jpg')).rejects.toThrow(/not on the R2 bucket/);
  });

  it('still decodes data URIs', async () => {
    const buf = await pdf.resolveImageBuffer('data:image/png;base64,aGVsbG8=');
    expect(buf.toString()).toBe('hello');
  });
});
