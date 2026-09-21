/**
 * Engagement tracking — story views, email send records, Resend event ingest.
 *
 * Pins the behaviour shipped with migrations/040_email_sends.sql:
 *   - every send site in email.js goes through sendTracked (no bare
 *     resend.emails.send survives), so nothing can send untracked;
 *   - outgoing sends carry correlation tags Resend will accept;
 *   - a webhook delivery is only ingested when its signature verifies, and a
 *     Svix retry of one already stored is a no-op rather than a double count;
 *   - both story-view call sites — authenticated and shared — exist.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// database.js is CommonJS, and both modules under test resolve it with their
// own `require('../services/database')` at CALL time — which vi.mock's ESM
// interception does not reach. So load the REAL modules through createRequire
// and swap the two functions on the module object, the house pattern from
// tests/unit/character-image-offload.test.ts. Nothing touches a database.
const require_ = createRequire(import.meta.url);
const database = require_('../../server/services/database');
const emailSends = require_('../../server/lib/emailSends');
const { verifyResendWebhook, resendWebhookHandler } = require_('../../server/lib/resendWebhook');
const storyViews = require_('../../server/lib/storyViews');

const ROOT = path.resolve(__dirname, '..', '..');

const realGetPool = database.getPool;
const realLogActivity = database.logActivity;
afterAll(() => { database.getPool = realGetPool; database.logActivity = realLogActivity; });

// A stub pool. Each test declares what its queries return; every call is
// recorded so the assertions can read the SQL that was actually issued.
const calls: Array<{ sql: string; params: any[] }> = [];
let queryImpl: (sql: string, params: any[]) => any = () => ({ rows: [] });
database.getPool = () => ({
  query: (sql: string, params: any[]) => {
    calls.push({ sql, params });
    return Promise.resolve(queryImpl(sql, params));
  },
});

beforeEach(() => {
  calls.length = 0;
  queryImpl = () => ({ rows: [{ id: 1 }] });
  database.logActivity = vi.fn(async () => {});
  storyViews._resetViewDedupe();
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
describe('outgoing send tags', () => {
  it('keeps tag values inside the character set Resend accepts', () => {
    // Resend rejects the WHOLE send on an invalid tag, so an unsafe character
    // must never reach it — a rejected tag would turn telemetry into an outage.
    expect(emailSends.sanitizeTagValue('job_1788641639919_ab12')).toBe('job_1788641639919_ab12');
    expect(emailSends.sanitizeTagValue('a@b.ch')).toBe('a_b_ch');
    expect(emailSends.sanitizeTagValue('')).toBeNull();
    expect(emailSends.sanitizeTagValue(null)).toBeNull();
    expect(emailSends.sanitizeTagValue('x'.repeat(400))!.length).toBe(256);
  });

  it('tags a send with its type, environment and story', () => {
    const tags = emailSends.buildTags({ emailType: 'story-complete', storyId: 'job_1_a', environment: 'staging' });
    expect(tags).toEqual(
      expect.arrayContaining([
        { name: 'email_type', value: 'story-complete' },
        { name: 'environment', value: 'staging' },
        { name: 'story_id', value: 'job_1_a' },
      ])
    );
    // An absent field is dropped, never sent as an empty string.
    expect(tags.find((t: any) => t.name === 'user_id')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendTracked
// ---------------------------------------------------------------------------
describe('sendTracked', () => {
  it('sends with tags and records the Resend message id', async () => {
    const send = vi.fn(async () => ({ data: { id: 'msg_abc' }, error: null }));
    const res = await emailSends.sendTracked(
      { emails: { send } },
      'story-complete',
      { from: 'a@b.ch', to: 'kid@example.ch', subject: 'Done' },
      { storyId: 'job_9_z', language: 'German' }
    );

    expect(res.data.id).toBe('msg_abc');
    const payload = send.mock.calls[0][0] as any;
    expect(payload.tags).toEqual(
      expect.arrayContaining([{ name: 'email_type', value: 'story-complete' }, { name: 'story_id', value: 'job_9_z' }])
    );

    const insert = calls.find(c => c.sql.includes('INSERT INTO email_sends'))!;
    expect(insert).toBeTruthy();
    expect(insert.params).toEqual(expect.arrayContaining(['story-complete', 'kid@example.ch', 'msg_abc', 'sent', 'German', 'job_9_z']));
  });

  it('records a send that Resend refused, with status send_failed', async () => {
    const send = vi.fn(async () => ({ data: null, error: { message: 'domain not verified' } }));
    await emailSends.sendTracked({ emails: { send } }, 'password-reset', { to: 'a@b.ch', subject: 'x' });

    const insert = calls.find(c => c.sql.includes('INSERT INTO email_sends'))!;
    expect(insert.params).toContain('send_failed');
    expect(insert.params).toContain('domain not verified');
  });

  it('never turns a record failure into a send failure', async () => {
    // The mail is already gone. Throwing here would be caught upstream as
    // "send failed" and could produce a DUPLICATE mail to a real customer.
    queryImpl = () => { throw new Error('db down'); };
    const send = vi.fn(async () => ({ data: { id: 'msg_x' }, error: null }));
    const res = await emailSends.sendTracked({ emails: { send } }, 'story-complete', { to: 'a@b.ch' });
    expect(res.data.id).toBe('msg_x');
  });

  it('refuses to send without a type — an untracked send is not a supported path', async () => {
    const send = vi.fn();
    await expect(emailSends.sendTracked({ emails: { send } }, '', { to: 'a@b.ch' })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// email.js call sites — no bare send may survive
// ---------------------------------------------------------------------------
describe('email.js send sites', () => {
  const source = fs.readFileSync(path.join(ROOT, 'email.js'), 'utf8');

  it('routes every send through sendTracked', () => {
    expect(source).not.toMatch(/resend\.emails\.send\s*\(/);
    expect(source.match(/sendTracked\(resend,/g)!.length).toBeGreaterThanOrEqual(13);
  });

  it('gives every send site a distinct type slug', () => {
    const types = [...source.matchAll(/sendTracked\(resend,\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
    expect(types.length).toBe(new Set(types).size);
    expect(types).toContain('story-complete');
    expect(types).toContain('trial-reminder');
    expect(types).toContain('order-confirmation');
  });
});

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------
function signedDelivery(body: string, secretRaw: Buffer, id = 'msg_test') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'v1,' + crypto.createHmac('sha256', secretRaw).update(`${id}.${ts}.${body}`).digest('base64');
  return { id, timestamp: ts, signature: sig };
}

describe('Resend webhook signature', () => {
  const secretRaw = crypto.randomBytes(24);
  const secret = 'whsec_' + secretRaw.toString('base64');
  const body = JSON.stringify({ type: 'email.opened', created_at: '2026-09-21T10:00:00.000Z', data: { email_id: 'msg_1' } });

  it('accepts a correctly signed delivery and returns the parsed payload', () => {
    const out = verifyResendWebhook({ payload: body, secret, headers: signedDelivery(body, secretRaw) });
    expect(out.type).toBe('email.opened');
  });

  it('rejects a tampered body', () => {
    const headers = signedDelivery(body, secretRaw);
    const tampered = body.replace('email.opened', 'email.clicked');
    expect(() => verifyResendWebhook({ payload: tampered, secret, headers })).toThrow();
  });

  it('rejects the wrong secret', () => {
    const headers = signedDelivery(body, secretRaw);
    const other = 'whsec_' + crypto.randomBytes(24).toString('base64');
    expect(() => verifyResendWebhook({ payload: body, secret: other, headers })).toThrow();
  });

  it('rejects a missing header or a re-stringified body', () => {
    const headers = signedDelivery(body, secretRaw);
    expect(() => verifyResendWebhook({ payload: body, secret, headers: { ...headers, signature: '' } })).toThrow();
    // Re-serialising changes the bytes, which is exactly why the route uses
    // express.raw() — prove the signature notices.
    const reparsed = JSON.stringify(JSON.parse(body), null, 2);
    expect(() => verifyResendWebhook({ payload: reparsed, secret, headers })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------
function fakeRes() {
  const out: any = { code: 0, body: null };
  out.status = (c: number) => { out.code = c; return out; };
  out.json = (b: any) => { out.body = b; return out; };
  return out;
}

describe('POST /api/resend/webhook handler', () => {
  const secretRaw = crypto.randomBytes(24);
  const secret = 'whsec_' + secretRaw.toString('base64');
  const body = JSON.stringify({ type: 'email.delivered', created_at: '2026-09-21T10:00:00.000Z', data: { email_id: 'msg_1', to: ['a@b.ch'] } });

  beforeEach(() => { process.env.RESEND_WEBHOOK_SECRET = secret; });

  it('refuses to acknowledge when no secret is configured', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = fakeRes();
    await resendWebhookHandler({ headers: {}, body: Buffer.from(body) }, res);
    // 500, not 200: Svix must retry rather than believe the event landed.
    expect(res.code).toBe(500);
  });

  it('401s on missing svix headers and on a bad signature', async () => {
    const noHeaders = fakeRes();
    await resendWebhookHandler({ headers: {}, body: Buffer.from(body) }, noHeaders);
    expect(noHeaders.code).toBe(401);

    const badSig = fakeRes();
    await resendWebhookHandler({
      // Current timestamp, so this fails on the SIGNATURE and not on staleness.
      headers: { 'svix-id': 'msg_test', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,' + Buffer.from('nope').toString('base64') },
      body: Buffer.from(body),
    }, badSig);
    expect(badSig.code).toBe(401);
  });

  it('stores a verified delivery and rolls it up onto the send', async () => {
    const h = signedDelivery(body, secretRaw);
    const res = fakeRes();
    await resendWebhookHandler({
      headers: { 'svix-id': h.id, 'svix-timestamp': h.timestamp, 'svix-signature': h.signature },
      body: Buffer.from(body),
    }, res);

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
    expect(calls.some(c => c.sql.includes('INSERT INTO email_events'))).toBe(true);
    expect(calls.some(c => c.sql.includes('UPDATE email_sends') && c.params.includes('delivered'))).toBe(true);
  });

  it('treats a Svix retry of a stored delivery as a no-op', async () => {
    // ON CONFLICT (svix_id) DO NOTHING returns no row — the rollup must be
    // skipped, or a redelivered open would double the open count.
    queryImpl = (sql) => (sql.includes('INSERT INTO email_events') ? { rows: [] } : { rows: [{ id: 1 }] });
    const h = signedDelivery(body, secretRaw);
    const res = fakeRes();
    await resendWebhookHandler({
      headers: { 'svix-id': h.id, 'svix-timestamp': h.timestamp, 'svix-signature': h.signature },
      body: Buffer.from(body),
    }, res);

    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(calls.some(c => c.sql.includes('UPDATE email_sends'))).toBe(false);
  });

  it('500s when the event verified but could not be stored', async () => {
    queryImpl = () => { throw new Error('db down'); };
    const h = signedDelivery(body, secretRaw);
    const res = fakeRes();
    await resendWebhookHandler({
      headers: { 'svix-id': h.id, 'svix-timestamp': h.timestamp, 'svix-signature': h.signature },
      body: Buffer.from(body),
    }, res);
    expect(res.code).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Event rollups
// ---------------------------------------------------------------------------
describe('email event rollups', () => {
  it('counts an open and records the clicked link', async () => {
    await emailSends.recordEmailEvent({
      svixId: 'svix_1',
      body: { type: 'email.opened', created_at: '2026-09-21T10:00:00.000Z', data: { email_id: 'msg_1' } },
    });
    const upd = calls.find(c => c.sql.includes('open_count = open_count + 1'))!;
    expect(upd).toBeTruthy();

    calls.length = 0;
    await emailSends.recordEmailEvent({
      svixId: 'svix_2',
      body: { type: 'email.clicked', data: { email_id: 'msg_1', click: { link: 'https://www.magicalstory.ch/shared/t' } } },
    });
    const ins = calls.find(c => c.sql.includes('INSERT INTO email_events'))!;
    expect(ins.params).toContain('https://www.magicalstory.ch/shared/t');
    expect(calls.some(c => c.sql.includes('click_count = click_count + 1'))).toBe(true);
  });

  it('only ever moves status forward, so a late email.sent cannot un-bounce a row', () => {
    const r = emailSends.STATUS_RANK;
    expect(r.sent).toBeLessThan(r.delivered);
    expect(r.delivered).toBeLessThan(r.bounced);
    expect(r.opened).toBeUndefined();
    expect(r.clicked).toBeUndefined();
  });

  it('refuses a payload with no type rather than storing a shapeless row', async () => {
    await expect(emailSends.recordEmailEvent({ svixId: 's', body: { data: {} } })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Story views
// ---------------------------------------------------------------------------
describe('story views', () => {
  it('writes a STORY_VIEWED row into the logs table for an owner', async () => {
    const ok = await storyViews.recordStoryView({
      storyId: 'job_1_a',
      source: 'owner',
      req: { user: { id: 'u1', username: 'anna' } },
    });
    expect(ok).toBe(true);
    const [userId, username, action, details] = (database.logActivity as any).mock.calls[0];
    expect(action).toBe('STORY_VIEWED');
    expect(userId).toBe('u1');
    expect(username).toBe('anna');
    expect(details).toMatchObject({ storyId: 'job_1_a', source: 'owner', authenticated: true });
  });

  it('records an anonymous shared view with its share token and no user', async () => {
    const ok = await storyViews.recordStoryView({
      storyId: 'job_1_a',
      source: 'shared',
      req: { ip: '10.0.0.9' },
      shareToken: 'tok_abc',
      ownerUserId: 'u1',
    });
    expect(ok).toBe(true);
    const [userId, , action, details] = (database.logActivity as any).mock.calls[0];
    expect(action).toBe('STORY_VIEWED');
    expect(userId).toBeNull();
    expect(details).toMatchObject({ source: 'shared', shareToken: 'tok_abc', ownerUserId: 'u1', authenticated: false });
  });

  it('suppresses a repeat view by the same viewer, but not a different one', async () => {
    const req = { user: { id: 'u1', username: 'anna' } };
    expect(await storyViews.recordStoryView({ storyId: 'job_1_a', source: 'owner', req })).toBe(true);
    expect(await storyViews.recordStoryView({ storyId: 'job_1_a', source: 'owner', req })).toBe(false);
    expect(await storyViews.recordStoryView({ storyId: 'job_1_a', source: 'owner', req: { user: { id: 'u2' } } })).toBe(true);
    expect(await storyViews.recordStoryView({ storyId: 'job_2_b', source: 'owner', req })).toBe(true);
  });

  it('needs both a story and a source', async () => {
    expect(await storyViews.recordStoryView({ storyId: 'job_1_a' })).toBe(false);
    expect(await storyViews.recordStoryView({ source: 'owner' })).toBe(false);
  });

  it('is wired on BOTH the authenticated and the shared route', () => {
    // The shared/trial path in this repo has repeatedly lagged the full path;
    // this is the guard that says both siblings kept the instrumentation.
    const stories = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'stories.js'), 'utf8');
    const sharing = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'sharing.js'), 'utf8');
    expect(stories).toMatch(/recordStoryView\(\{/);
    expect(sharing).toMatch(/recordStoryView\(\{/);
    expect(sharing).toMatch(/source: 'shared'/);
  });
});
