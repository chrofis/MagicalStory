/**
 * Support emails in the daily admin recap (owner, 2026-10-17): every support
 * mail Claude sends a customer is recorded in email_sends (type 'support-*')
 * by scripts/email/send.js and shown in a "Support" block of the Tagesbericht.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { parseSendArgs, buildDetail } = require_('../../scripts/email/sendArgs');

describe('send.js argument validation', () => {
  const base = ['--from', 'R <roger@magicalstory.ch>', '--to', 'a@b.ch', '--subject', 'Hi', '--text', 'x'];

  it('dry run needs no type', () => {
    expect(parseSendArgs(base).errors).toEqual([]);
  });
  it('--send requires a type', () => {
    expect(parseSendArgs([...base, '--send']).errors.join()).toMatch(/--send requires --type/);
  });
  it('--send rejects a type not starting with support-', () => {
    expect(parseSendArgs([...base, '--send', '--type', 'story-complete']).errors.join()).toMatch(/support-/);
    expect(parseSendArgs([...base, '--send', '--type', 'support-']).errors.join()).toMatch(/support-/);
    expect(parseSendArgs([...base, '--send', '--type', 'Support-X']).errors.join()).toMatch(/support-/);
  });
  it('--send with a support type passes and carries the optional ids', () => {
    const { errors, opts } = parseSendArgs([...base, '--send', '--type', 'support-short-trial-book',
      '--story-id', 'job_1', '--user-id', 'u1', '--lang', 'it', '--order-id', '100']);
    expect(errors).toEqual([]);
    expect(opts).toMatchObject({ storyId: 'job_1', userId: 'u1', lang: 'it', orderId: '100', db: 'production' });
    expect(buildDetail(opts).orderId).toBe('100');
  });
  it('--db only accepts staging (default production)', () => {
    expect(parseSendArgs([...base, '--db', 'staging']).opts.db).toBe('staging');
    expect(parseSendArgs([...base, '--db', 'dev']).errors.join()).toMatch(/--db/);
  });
  it('--record-only refuses without --type and --resend-id', () => {
    const e = parseSendArgs(['--record-only', '--from', 'a', '--to', 'b@c.ch', '--subject', 's']).errors.join();
    expect(e).toMatch(/requires --type/);
    expect(e).toMatch(/requires --resend-id/);
  });
  it('--record-only with everything passes; with --send is refused', () => {
    const ok = ['--record-only', '--resend-id', 'r1', '--type', 'support-x', '--from', 'a', '--to', 'b@c.ch', '--subject', 's'];
    expect(parseSendArgs(ok).errors).toEqual([]);
    expect(parseSendArgs([...ok, '--send']).errors.join()).toMatch(/mutually exclusive/);
  });
});

vi.mock('../../server/lib/apiHealth', () => ({ getApiHealth: async () => [] }));
vi.mock('../../server/lib/failureLog', () => ({
  summariseFailures: async () => ({ totals: { customer: 0, internal: 0 }, customer: [], internal: [] }),
}));
const { buildActivityFeed } = require_('../../server/lib/adminActivity');

describe('buildActivityFeed support rows', () => {
  it('queries support-% email_sends within the window and shapes the rows', async () => {
    const seen: Array<{ sql: string; params: any[] }> = [];
    const sentAt = new Date('2026-10-17T08:00:00Z');
    const pool = {
      query: async (sql: string, params: any[]) => {
        seen.push({ sql, params });
        if (/FROM email_sends/.test(sql)) {
          return { rows: [
            { sent_at: sentAt, recipient: 'a@b.ch', subject: 'S1', status: 'delivered', email_type: 'support-x', open_count: 2 },
            { sent_at: sentAt, recipient: 'c@d.ch', subject: 'S2', status: 'sent', email_type: 'support-y', open_count: 0 },
          ] };
        }
        return { rows: [] };
      },
    };
    const feed = await buildActivityFeed(pool, 24);
    const q = seen.find(c => /FROM email_sends/.test(c.sql))!;
    expect(q.sql).toMatch(/email_type LIKE 'support-%'/);
    expect(q.params).toEqual([24]);
    expect(feed.support).toEqual([
      { ts: sentAt, recipient: 'a@b.ch', subject: 'S1', status: 'delivered', type: 'support-x', opened: true },
      { ts: sentAt, recipient: 'c@d.ch', subject: 'S2', status: 'sent', type: 'support-y', opened: false },
    ]);
  });
  it('is an empty list when nothing was sent', async () => {
    const feed = await buildActivityFeed({ query: async () => ({ rows: [] }) }, 24);
    expect(feed.support).toEqual([]);
  });
});

describe('Tagesbericht Support block', () => {
  let html: string;
  async function render(support: any[]) {
    process.env.RESEND_API_KEY = 're_test';
    const database = require_('../../server/services/database');
    database.getPool = () => ({ query: async () => ({ rows: [{ id: 1 }] }) });
    let sent = '';
    (globalThis as any).fetch = vi.fn(async (_u: any, init: any) => {
      sent = JSON.parse(init.body).html;
      return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const email = require_('../../email');
    await email.sendAdminDailySummary({ summary: {}, events: [], support }, 'Samstag');
    return sent;
  }
  beforeEach(() => { html = ''; });

  it('lists recipient, subject, status and opened', async () => {
    html = await render([{ ts: new Date('2026-10-17T08:00:00Z'), recipient: 'a@b.ch', subject: 'Il libro <b>', status: 'delivered', type: 'support-x', opened: true }]);
    expect(html).toContain('Support-Mails (24h): 1');
    expect(html).toContain('a@b.ch');
    expect(html).toContain('Il libro &lt;b&gt;');
    expect(html).toContain('delivered');
    expect(html).toMatch(/>ja</);
  });
  it('shows nothing when there are none', async () => {
    html = await render([]);
    expect(html).not.toContain('Support-Mails');
  });
});
