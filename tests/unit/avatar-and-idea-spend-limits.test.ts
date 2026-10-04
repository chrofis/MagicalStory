import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';

/**
 * Code review 2026-10 batch 4: V4 avatar limits, V5 avatar photo sources, R4 idea route caps and
 * abort, V2 trust-proxy hop count, rateLimit admin peek on the session check.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-avatar-idea-limits';
process.env.R2_PUBLIC_URL = 'https://cdn.example-r2.test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const db: any = nodeRequire('../../server/services/database.js');
let poolQuery: (sql: string, params: any[]) => Promise<{ rows: any[] }> = async () => ({ rows: [] });
db.getPool = () => ({ query: (sql: string, params: any[]) => poolQuery(sql, params) });

const avatars: any = nodeRequire('../../server/routes/avatars.js');
const avatarRouter = avatars.router || avatars;
const ideas: any = nodeRequire('../../server/routes/storyIdeas.js');
const rl: any = nodeRequire('../../server/middleware/rateLimit.js');
const auth: any = nodeRequire('../../server/middleware/auth.js');
const runtime: any = nodeRequire('../../server/config/runtime.js');

const chain = (r: any, method: string, path: string) => {
  const l = r.stack.find((x: any) => x.route && x.route.path === path && x.route.methods[method]);
  if (!l) throw new Error(`no ${method} ${path}`);
  return l.route.stack.map((s: any) => s.handle);
};
const mockRes = () => {
  const r: any = { code: 200, body: null, headers: {} };
  r.status = (s: number) => { r.code = s; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.send = (b: any) => { r.body = b; return r; };
  r.setHeader = (k: string, v: any) => { r.headers[k] = v; };
  r.set = r.setHeader; r.get = (k: string) => r.headers[k];
  r.flushHeaders = () => { r.flushed = true; };
  r.write = () => true; r.end = () => {}; r.on = () => r;
  return r;
};
const user = { id: 7, username: 'u', role: 'user' };

describe('V5: avatar routes accept only inline or R2 photos', () => {
  const clothing = chain(avatarRouter, 'post', '/generate-clothing-avatars');
  const options = chain(avatarRouter, 'post', '/generate-avatar-options');
  const clothingHandler = clothing[clothing.length - 1];
  const optionsHandler = options[options.length - 1];

  it('refuses an external reference URL on generate-clothing-avatars', async () => {
    const res = mockRes();
    await clothingHandler({ user, query: {}, body: { referencePhoto: 'http://169.254.169.254/latest/meta-data', characterId: 1 } }, res);
    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/external URL/);
  });
  it('refuses an external face URL on generate-clothing-avatars', async () => {
    const res = mockRes();
    await clothingHandler({ user, query: {}, body: { referencePhoto: 'data:image/jpeg;base64,AAAA', facePhoto: 'https://evil.example/f.jpg', characterId: 1 } }, res);
    expect(res.code).toBe(400);
  });
  it('refuses an external URL on generate-avatar-options', async () => {
    const res = mockRes();
    await optionsHandler({ user, body: { facePhoto: 'https://evil.example/f.jpg', gender: 'male' } }, res);
    expect(res.code).toBe(400);
  });
});

describe('V4: avatar generation caps', () => {
  const clothing = chain(avatarRouter, 'post', '/generate-clothing-avatars');
  const handler = clothing[clothing.length - 1];

  it('both generation routes sit behind the daily limiter', () => {
    expect(chain(avatarRouter, 'post', '/generate-clothing-avatars')).toContain(rl.avatarGenerationLimiter);
    expect(chain(avatarRouter, 'post', '/generate-avatar-options')).toContain(rl.avatarGenerationLimiter);
  });
  it('an ordinary user cannot pick the avatar model', async () => {
    const res = mockRes();
    await handler({ user, query: {}, body: { referencePhoto: 'data:image/jpeg;base64,AAAA', characterId: 1, avatarModel: 'gemini-2.5-flash-image' } }, res);
    expect(res.code).toBe(403);
  });
  it('an admin may', async () => {
    const res = mockRes();
    await handler({ user: { ...user, role: 'admin' }, query: {}, body: { referencePhoto: 'external-not-set', characterId: 'bad', avatarModel: 'grok-imagine' } }, res);
    expect(res.code).not.toBe(403);
  });
  const hit = async (u: any) => {
    const res = mockRes();
    let passed = false;
    await rl.avatarGenerationLimiter({ ip: '1.1.1.1', headers: {}, app: { get: () => false }, user: u }, res, () => { passed = true; });
    return { passed, code: res.code };
  };
  it('refuses the 31st generation of the day, per user', async () => {
    const u = { id: 'cap-user', role: 'user' };
    for (let i = 0; i < 30; i++) expect((await hit(u)).passed).toBe(true);
    const over = await hit(u);
    expect(over.passed).toBe(false);
    expect(over.code).toBe(429);
    expect((await hit({ id: 'other-user', role: 'user' })).passed).toBe(true);
  });
  it('never refuses an admin or an admin acting as a user', async () => {
    for (let i = 0; i < 40; i++) expect((await hit({ id: 'adm', role: 'admin' })).passed).toBe(true);
    for (let i = 0; i < 40; i++) expect((await hit({ id: 'imp', role: 'user', impersonating: true, originalAdminRole: 'admin' })).passed).toBe(true);
  });
});

describe('R4: story-ideas routes cap their text and stop on disconnect', () => {
  const handlerOf = (path: string) => { const c = chain(ideas, 'post', path); return c[c.length - 1]; };
  for (const path of ['/generate-story-ideas', '/generate-story-ideas-stream']) {
    it(`${path} rejects over-long free text before any paid call or stream`, async () => {
      const res = mockRes();
      await handlerOf(path)({ user, body: { storyCategory: 'custom', customThemeText: 'x'.repeat(2001), characters: [{ name: 'Mia' }] } }, res);
      expect(res.code).toBe(400);
      expect(res.flushed).toBeUndefined();
    });
    it(`${path} rejects 21 traits on a character`, async () => {
      const res = mockRes();
      await handlerOf(path)({ user, body: { characters: [{ name: 'Mia', traits: { strengths: Array(21).fill('a') } }] } }, res);
      expect(res.code).toBe(400);
    });
  }
  it('streamIdeaArm hands its abort signal to the model call', async () => {
    const ac = new AbortController();
    let received: any = null;
    const callStreaming = (_p: string, _s: unknown, _d: unknown, _m: string, options: any) => { received = options; return Promise.resolve({ usage: null, modelId: 'm' }); };
    await ideas.streamIdeaArm({ arm: 0, prompt: 'p', res: { write: () => true }, callStreaming, model: 'm', signal: ac.signal });
    expect(received.signal).toBe(ac.signal);
  });
});

describe('V2: client IP behind Railway', () => {
  it('trusts two hops (client, Railway edge) - one is the edge itself, which shared every limiter bucket', () => {
    expect(runtime.runtime('trustProxyHops')).toBe(2);
  });
  it('req.ip is the client for the measured chain "client, railway edge"', async () => {
    const app = express();
    app.set('trust proxy', 2);
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      const body: any = await new Promise((resolve, reject) => {
        http.get({ port, path: '/ip', headers: { 'x-forwarded-for': '31.165.8.121, 212.102.36.193' } }, (r) => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      expect(body.ip).toBe('31.165.8.121');
    } finally { server.close(); }
  });
});

describe('rateLimit admin peek goes through the session check', () => {
  const bearer = (payload: any) => ({ headers: { authorization: `Bearer ${auth.signToken(payload, '1h')}` } });
  beforeEach(() => { poolQuery = async () => ({ rows: [] }); });
  it('skips the cap for a current admin session', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 0, role: 'admin' }] });
    expect(await rl._peekAdminFromToken(bearer({ id: 'a1', tv: 0, role: 'admin' }))).toBe(true);
  });
  it('does not skip for an admin token whose version was revoked', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 3, role: 'admin' }] });
    expect(await rl._peekAdminFromToken(bearer({ id: 'a2', tv: 0, role: 'admin' }))).toBe(false);
  });
  it('does not skip for a token that still says admin after the role was removed', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 0, role: 'user' }] });
    expect(await rl._peekAdminFromToken(bearer({ id: 'a3', tv: 0, role: 'admin' }))).toBe(false);
  });
  it('does not skip for a forged or missing token', async () => {
    expect(await rl._peekAdminFromToken({ headers: { authorization: 'Bearer not.a.jwt' } })).toBe(false);
    expect(await rl._peekAdminFromToken({ headers: {} })).toBe(false);
  });
});
