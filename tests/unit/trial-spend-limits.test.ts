import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Code review 2026-10 batch 4: trial flow spend limits.
 * T1 caps + session-gated ideas route, T2 link-email limits and honest send result,
 * T3 prepare-title once per trial, T4 Turnstile fails closed, merge-bumped session tokens.
 */
const nodeRequire = createRequire(import.meta.url);
process.env.JWT_SECRET = 'test-secret-trial-spend-limits';
const db: any = nodeRequire('../../server/services/database.js');

let poolQuery: (sql: string, params: any[]) => Promise<{ rows: any[] }> = async () => ({ rows: [] });
db.getPool = () => ({ query: (sql: string, params: any[]) => poolQuery(sql, params) });

const email: any = nodeRequire('../../email.js');
let sendResult: any = { success: true };
email.sendEmailVerificationEmail = async () => sendResult;

const trial: any = nodeRequire('../../server/routes/trial.js');
const router = trial.router || trial;
const auth: any = nodeRequire('../../server/middleware/auth.js');

const route = (method: string, path: string) => {
  const l = router.stack.find((x: any) => x.route && x.route.path === path && x.route.methods[method]);
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
  r.write = () => true; r.end = () => {};
  r.on = () => r;
  return r;
};
const sessionToken = (userId: string, tv?: number) =>
  auth.signToken({ userId, anonymous: true, ...(tv === undefined ? {} : { tv }) }, '1h');
let n = 0;
const uid = () => `user-${++n}-${Date.now()}`;

beforeEach(() => { poolQuery = async () => ({ rows: [] }); sendResult = { success: true }; });

describe('trial session token carries token_version (a merge ends a held session)', () => {
  const verify = route('get', '/check-status')[0];
  const run = async (token: string | null) => {
    const res = mockRes();
    let called = false;
    await verify({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res, () => { called = true; });
    return { res, called };
  };
  it('accepts a token whose version matches the account', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 0, role: 'user' }] });
    expect((await run(sessionToken(uid(), 0))).called).toBe(true);
  });
  it('accepts a legacy token with no tv while the account is still at version 0', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 0, role: 'user' }] });
    expect((await run(sessionToken(uid()))).called).toBe(true);
  });
  it('rejects the token after the Google merge bumped token_version', async () => {
    poolQuery = async () => ({ rows: [{ token_version: 1, role: 'user' }] });
    const { res, called } = await run(sessionToken(uid(), 0));
    expect(called).toBe(false);
    expect(res.code).toBe(403);
  });
  it('rejects a token for an account that no longer exists', async () => {
    poolQuery = async () => ({ rows: [] });
    expect((await run(sessionToken(uid(), 0))).res.code).toBe(403);
  });
});

describe('T4: Turnstile fails closed', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; delete process.env.TURNSTILE_SECRET_KEY; });
  it('throws (never passes) when the secret is not configured', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(trial.verifyTurnstile('tok', '1.1.1.1')).rejects.toBeInstanceOf(trial.TurnstileUnavailableError);
  });
  it('throws when siteverify cannot be reached', async () => {
    process.env.TURNSTILE_SECRET_KEY = 's';
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any;
    await expect(trial.verifyTurnstile('tok', '1.1.1.1')).rejects.toBeInstanceOf(trial.TurnstileUnavailableError);
  });
  it('still returns false for a visitor with no token or a failed challenge', async () => {
    process.env.TURNSTILE_SECRET_KEY = 's';
    expect(await trial.verifyTurnstile('', '1.1.1.1')).toBe(false);
    global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: false, 'error-codes': ['bad'] }) }) as any;
    expect(await trial.verifyTurnstile('tok', '1.1.1.1')).toBe(false);
  });
  it('create-anonymous-account answers 503 retryable when Turnstile is unavailable', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const handler = route('post', '/create-anonymous-account').pop();
    const res = mockRes();
    await handler({ body: { name: 'Mia', age: 7, gender: 'female', facePhoto: 'data:image/jpeg;base64,AAAA' }, ip: '1.1.1.1', headers: {} }, res);
    expect(res.code).toBe(503);
    expect(res.body.retryable).toBe(true);
  });
});

describe('T1: ideas route needs a session and caps its text', () => {
  const chain = route('post', '/generate-ideas-stream');
  it('runs the session check before the limiter and the handler', () => {
    expect(chain.length).toBe(3);
    expect(chain[0].name).toBe('verifySessionToken');
  });
  it('rejects an oversized topic with 400 before the stream opens', async () => {
    const res = mockRes();
    await chain[2]({ body: { storyCategory: 'adventure', storyTopic: 'x'.repeat(2001), characters: [{ name: 'Mia' }] }, headers: {} }, res);
    expect(res.code).toBe(400);
    expect(res.flushed).toBeUndefined();
  });
  it('rejects oversized traits on a character', async () => {
    const res = mockRes();
    await chain[2]({ body: { storyCategory: 'adventure', characters: [{ name: 'Mia', traits: Array(30).fill('t') }] }, headers: {} }, res);
    expect(res.code).toBe(400);
  });
});

describe('T1: stored trial text is capped', () => {
  it('create-story rejects an oversized storyDetails', async () => {
    const handler = route('post', '/create-story').pop();
    const res = mockRes();
    // An unspent trial account: the resume check (existingTrialJobResponse) runs before validation.
    poolQuery = async (sql: string) => (/SELECT stories_generated FROM users/.test(sql) ? { rows: [{ stories_generated: 0 }] } : { rows: [] });
    await handler({ sessionUser: { userId: 'u' }, body: { storyCategory: 'adventure', storyDetails: 'x'.repeat(4001) } }, res);
    expect(res.code).toBe(400);
  });
  it('update-character-details rejects 21 traits', async () => {
    const handler = route('patch', '/update-character-details').pop();
    const res = mockRes();
    await handler({ sessionUser: { userId: 'u' }, body: { name: 'Mia', traits: Array(21).fill('t') } }, res);
    expect(res.code).toBe(400);
  });
});

describe('T2: link-email', () => {
  const chain = route('post', '/link-email');
  const sessionLimiter = chain[1];
  const addressLimiter = chain[2];
  const handler = chain[3];
  const limit = async (limiter: any, req: any) => {
    const res = mockRes();
    let passed = false;
    await limiter({ ip: '1.1.1.1', headers: {}, app: { get: () => false }, ...req }, res, () => { passed = true; });
    return { passed, res };
  };
  it('allows 3 sends per session, then refuses', async () => {
    const req = { sessionUser: { userId: uid() }, body: { email: 'a@b.ch' } };
    for (let i = 0; i < 3; i++) expect((await limit(sessionLimiter, req)).passed).toBe(true);
    const fourth = await limit(sessionLimiter, req);
    expect(fourth.passed).toBe(false);
    expect(fourth.res.code).toBe(429);
  });
  it('allows 5 sends per address per day across sessions, then refuses', async () => {
    const address = `victim-${Date.now()}@example.com`;
    for (let i = 0; i < 5; i++) {
      expect((await limit(addressLimiter, { sessionUser: { userId: uid() }, body: { email: address } })).passed).toBe(true);
    }
    expect((await limit(addressLimiter, { sessionUser: { userId: uid() }, body: { email: address.toUpperCase() } })).passed).toBe(false);
  });
  const happyPool = () => async (sql: string) => {
    if (/SELECT id, anonymous, email, email_verified FROM users/.test(sql)) {
      return { rows: [{ id: 'u', anonymous: true, email: null, email_verified: false }] };
    }
    return { rows: [] };
  };
  it('does not report success when the verification email was not sent', async () => {
    poolQuery = happyPool();
    sendResult = { success: false, error: { code: 'NOT_CONFIGURED', message: 'no key' } };
    const res = mockRes();
    await handler({ sessionUser: { userId: 'u' }, body: { email: 'a@b.ch' } }, res);
    expect(res.code).toBe(502);
    expect(res.body.success).toBeUndefined();
  });
  it('reports success when it sent', async () => {
    poolQuery = happyPool();
    const res = mockRes();
    await handler({ sessionUser: { userId: 'u' }, body: { email: 'a@b.ch' } }, res);
    expect(res.body.success).toBe(true);
  });
});

describe('T3: prepare-title once per trial', () => {
  const handler = route('post', '/prepare-title').pop();
  const body = { storyCategory: 'adventure', storyTheme: 'pirate' };
  const pool = (used: number, charData?: any) => async (sql: string) => {
    if (/SELECT stories_generated FROM users/.test(sql)) return { rows: [{ stories_generated: used }] };
    if (/SELECT data FROM characters/.test(sql)) return { rows: [{ data: charData }] };
    return { rows: [] };
  };
  it('refuses after the trial story was taken', async () => {
    poolQuery = pool(1);
    const res = mockRes();
    await handler({ sessionUser: { userId: uid() }, body }, res);
    expect(res.code).toBe(409);
    expect(res.body.code).toBe('TRIAL_USED');
  });
  it('returns the stored sheets for the same costume instead of generating again', async () => {
    const { getTrialCostume, resolveTrialCostumeLookup } = nodeRequire('../../server/config/trialCostumes.js');
    const look = resolveTrialCostumeLookup({ storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: undefined });
    const costume = getTrialCostume(look.topic, look.category, 'male');
    const storedType = costume ? costume.costumeType : null;
    const { markCutCell, brandCutList, writeCutSlides } = nodeRequire('../../server/lib/clientAvatarImages.js');
    const stored: any = { name: 'Mia', gender: 'male', preGeneratedStyledAvatars: { Mia: {} }, preGeneratedCostumeType: storedType };
    writeCutSlides(stored, brandCutList([markCutCell('data:image/jpeg;base64,S1'), markCutCell('data:image/jpeg;base64,S2')]), ['https://r2/s1.jpg', 'https://r2/s2.jpg']);
    poolQuery = pool(0, { characters: [stored] });
    const res = mockRes();
    await handler({ sessionUser: { userId: uid() }, body }, res);
    expect(res.body).toEqual({ costumeType: storedType, avatarSlides: ['https://r2/s1.jpg', 'https://r2/s2.jpg'] });
  });
  it('generates nothing for a different costume once sheets exist', async () => {
    poolQuery = pool(0, { characters: [{ name: 'Mia', gender: 'male', preGeneratedStyledAvatars: { Mia: {} }, preGeneratedCostumeType: 'some-other-costume', preGeneratedAvatarSlides: ['s1'] }] });
    const res = mockRes();
    await handler({ sessionUser: { userId: uid() }, body }, res);
    expect(res.body).toEqual({ costumeType: null, avatarSlides: [] });
  });
});
