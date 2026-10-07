// The trial reminders are promotional mail and carry a working one-click
// opt-out (Swiss UWG Art. 3 lit. o). Pins, with no network and a fake pool:
//   - the unsubscribe token signs a user id and rejects a tampered one;
//   - GET /api/email/unsubscribe/:token stamps users.marketing_opt_out_at
//     (idempotently) and answers a page in the user's language;
//   - POST (RFC 8058 one-click) stamps the same column and answers 200;
//   - the reminder sender puts the link in the body and the List-Unsubscribe
//     headers on the send, and refuses to send with no user id to sign for;
//   - transactional templates carry no unsubscribe line.

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-unsubscribe';
// A Resend client exists (fake key, never called): every send goes through
// sendTracked, which is stubbed here BEFORE email.js destructures it, so the
// sender tests see the exact payload a real send would carry.
process.env.RESEND_API_KEY = 're_test_never_called';
const sends: Array<{ emailType: string; payload: any; meta: any }> = [];
const emailSendsPath = path.join(ROOT, 'server/lib/emailSends.js');
require.cache[emailSendsPath] = {
  id: emailSendsPath, filename: emailSendsPath, loaded: true,
  exports: {
    async sendTracked(_resend: unknown, emailType: string, payload: any, meta: any) {
      sends.push({ emailType, payload, meta });
      return { data: { id: 'stub-id' }, error: null };
    },
  },
} as never;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sign, verify, buildUnsubscribeUrl } = require(path.join(ROOT, 'server/lib/unsubscribeToken.js'));

describe('unsubscribe token', () => {
  it('round-trips a user id', () => {
    const token = sign('user_abc-123');
    expect(verify(token)).toBe('user_abc-123');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  });

  it('rejects a tampered user id, a tampered signature, and junk', () => {
    const token = sign('user_1');
    const [id, sig] = token.split('.');
    const otherId = Buffer.from('user_2', 'utf8').toString('base64url');
    expect(verify(`${otherId}.${sig}`)).toBeNull();
    const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    expect(verify(`${id}.${flipped}`)).toBeNull();
    expect(verify(`${id}.${sig.slice(0, 63)}`)).toBeNull();
    expect(verify('')).toBeNull();
    expect(verify(null)).toBeNull();
    expect(verify('no-dot')).toBeNull();
    expect(verify(`.${sig}`)).toBeNull();
  });

  it('a token minted under another secret does not verify', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'other-secret';
    const foreign = sign('user_1');
    process.env.JWT_SECRET = saved;
    expect(verify(foreign)).toBeNull();
  });

  it('builds the link on the claim link\'s base (env-first, apex by default)', () => {
    const savedF = process.env.FRONTEND_URL; const savedB = process.env.BASE_URL;
    delete process.env.FRONTEND_URL; delete process.env.BASE_URL;
    expect(buildUnsubscribeUrl('u1')).toMatch(/^https:\/\/magicalstory\.ch\/api\/email\/unsubscribe\/[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    process.env.FRONTEND_URL = 'https://staging.magicalstory.ch';
    expect(buildUnsubscribeUrl('u1').startsWith('https://staging.magicalstory.ch/api/email/unsubscribe/')).toBe(true);
    if (savedF === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = savedF;
    if (savedB === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = savedB;
  });
});

// ── the route, on a fake pool ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require(path.join(ROOT, 'server/services/database.js'));
const queries: Array<{ sql: string; params: unknown[] }> = [];
const users: Record<string, { preferred_language: string; marketing_opt_out_at: Date | null }> = {};
db.getPool = () => ({
  async query(sql: string, params: unknown[]) {
    queries.push({ sql, params });
    if (/UPDATE users\s+SET marketing_opt_out_at = COALESCE\(marketing_opt_out_at, NOW\(\)\)/.test(sql)) {
      const u = users[params[0] as string];
      if (!u) return { rows: [] };
      u.marketing_opt_out_at = u.marketing_opt_out_at || new Date();
      return { rows: [{ preferred_language: u.preferred_language }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require(path.join(ROOT, 'server/routes/email.js'));
const handler = (method: string, routePath: string) => {
  const l = router.stack.find((x: any) => x.route && x.route.path === routePath && x.route.methods[method]);
  if (!l) throw new Error(`no ${method} ${routePath}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
const mockRes = () => {
  const r: any = { code: 200, body: null, headers: {} as Record<string, string> };
  r.status = (s: number) => { r.code = s; return r; };
  r.type = () => r;
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.send = (b: unknown) => { r.body = b; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
};

beforeEach(() => {
  queries.length = 0;
  for (const k of Object.keys(users)) delete users[k];
  users.u_de = { preferred_language: 'German', marketing_opt_out_at: null };
  users.u_fr = { preferred_language: 'fr-CH', marketing_opt_out_at: null };
  users.u_it = { preferred_language: 'Italian', marketing_opt_out_at: null };
  users.u_en = { preferred_language: 'English', marketing_opt_out_at: null };
});

describe('GET /api/email/unsubscribe/:token', () => {
  it('stamps marketing_opt_out_at for the signed user and answers in their language', async () => {
    const expectations: Array<[string, string, string]> = [
      ['u_de', 'de-CH', 'Abgemeldet'],
      ['u_fr', 'fr-CH', 'Désabonnement confirmé'],
      ['u_it', 'it-CH', 'Disiscrizione confermata'],
      ['u_en', 'en', 'Unsubscribed'],
    ];
    for (const [id, htmlLang, title] of expectations) {
      const res = mockRes();
      await handler('get', '/unsubscribe/:token')({ params: { token: sign(id) } }, res);
      expect(res.code, id).toBe(200);
      expect(res.body).toContain(`<html lang="${htmlLang}">`);
      expect(res.body).toContain(`<h1>${title}</h1>`);
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(users[id].marketing_opt_out_at).toBeInstanceOf(Date);
    }
    expect(queries.every((q) => /WHERE id = \$1/.test(q.sql))).toBe(true);
  });

  it('a second click keeps the first timestamp (COALESCE) and still answers 200', async () => {
    const first = new Date('2026-01-01T00:00:00Z');
    users.u_de.marketing_opt_out_at = first;
    const res = mockRes();
    await handler('get', '/unsubscribe/:token')({ params: { token: sign('u_de') } }, res);
    expect(res.code).toBe(200);
    expect(users.u_de.marketing_opt_out_at).toBe(first);
  });

  it('a tampered token stamps nothing and answers 400', async () => {
    const [id] = sign('u_de').split('.');
    const res = mockRes();
    await handler('get', '/unsubscribe/:token')({ params: { token: `${id}.${'0'.repeat(64)}` } }, res);
    expect(res.code).toBe(400);
    expect(res.body).toContain('not valid');
    expect(queries).toHaveLength(0);
    expect(users.u_de.marketing_opt_out_at).toBeNull();
  });

  it('a valid token for a user that no longer exists answers 400', async () => {
    const res = mockRes();
    await handler('get', '/unsubscribe/:token')({ params: { token: sign('u_gone') } }, res);
    expect(res.code).toBe(400);
  });
});

describe('POST /api/email/unsubscribe/:token (RFC 8058 one-click)', () => {
  it('stamps the column and answers 200 JSON without reading the body', async () => {
    const res = mockRes();
    await handler('post', '/unsubscribe/:token')({ params: { token: sign('u_it') }, body: undefined }, res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(users.u_it.marketing_opt_out_at).toBeInstanceOf(Date);
  });

  it('rejects a bad token with 400', async () => {
    const res = mockRes();
    await handler('post', '/unsubscribe/:token')({ params: { token: 'junk' } }, res);
    expect(res.code).toBe(400);
    expect(queries).toHaveLength(0);
  });
});

// ── the sender ───────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const email = require(path.join(ROOT, 'email.js'));
const { getTemplateSection } = email;
const LANGUAGES = ['English', 'German', 'French', 'Italian'];

describe('the trial-reminder template carries the unsubscribe line; transactional templates do not', () => {
  for (const language of LANGUAGES) {
    it(`trial-reminder [${language}]: html and text link to {unsubscribeUrl}`, () => {
      const { html, text } = getTemplateSection('trial-reminder', language);
      expect(html).toMatch(/href="\{unsubscribeUrl\}"/);
      expect(text).toContain('{unsubscribeUrl}');
    });
  }
  for (const name of ['story-complete', 'trial-story-complete', 'story-failed', 'order-confirmation', 'order-shipped', 'order-failed', 'email-verification', 'password-reset']) {
    it(`${name} has no unsubscribe link`, () => {
      for (const language of LANGUAGES) {
        const { html, text } = getTemplateSection(name, language);
        expect(html).not.toContain('unsubscribe');
        expect(text).not.toContain('unsubscribe');
      }
    });
  }
});

describe('sendTrialReminderEmail', () => {
  beforeEach(() => { sends.length = 0; });

  it('puts the signed link in the body and the List-Unsubscribe headers on the send', async () => {
    const result = await email.sendTrialReminderEmail('a@example.com', 'Anna', 'https://magicalstory.ch/claim/t', 'German', { reminderType: 'day5', userId: 'u_de' });
    expect(result).toEqual({ id: 'stub-id' });
    expect(sends).toHaveLength(1);
    const { payload, meta } = sends[0];
    const url = buildUnsubscribeUrl('u_de');
    expect(payload.headers['List-Unsubscribe']).toBe(`<${url}>`);
    expect(payload.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(payload.html).toContain(`href="${url}"`);
    expect(payload.text).toContain(url);
    expect(payload.html).not.toContain('{unsubscribeUrl}');
    expect(meta.userId).toBe('u_de');
    expect(verify(url.split('/').pop())).toBe('u_de');
  });

  it('refuses to send with no userId to sign the link for (no reminder without an opt-out)', async () => {
    const result = await email.sendTrialReminderEmail('a@example.com', 'Anna', 'https://magicalstory.ch/claim/t', 'German', { reminderType: 'day5' });
    expect(result).toBeNull();
    expect(sends).toHaveLength(0);
  });

  it('transactional senders set no List-Unsubscribe header', async () => {
    await email.sendStoryFailedEmail('a@example.com', 'Anna', 'German');
    await email.sendEmailVerificationEmail('a@example.com', 'Anna', 'https://magicalstory.ch/api/auth/verify-email/t', 'German');
    expect(sends).toHaveLength(2);
    for (const s of sends) expect(s.payload.headers).toBeUndefined();
  });
});
