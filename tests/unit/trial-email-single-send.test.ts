/**
 * sendTrialCompletionEmailIfDeferred is called from verify-email AND
 * link-google, and a verification link is opened more than once (mail-client
 * prefetch + the click, double-tap). Its idempotency guard read
 * `trial_completion_email_sent_at`, built the PDF, sent, THEN stamped the
 * column — two overlapping calls both read NULL and both sent. The stamp must be
 * an atomic claim taken before the send.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DB = path.join(ROOT, 'server/services/database.js');
const PDF = path.join(ROOT, 'server/lib/pdf.js');
const TRIAL_EMAIL = path.join(ROOT, 'server/lib/trialEmail.js');

type Row = Record<string, any>;
function fakePool(user: Row) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (/FROM users WHERE id/.test(sql)) return { rows: [{ ...user }] };
      if (/FROM stories/.test(sql)) return { rows: [{ id: 'story1', data: { title: 'T', language: 'English', sceneImages: [] } }] };
      if (/UPDATE users SET trial_completion_email_sent_at = NULL/.test(sql)) { user.trial_completion_email_sent_at = null; return { rows: [], rowCount: 1 }; }
      if (/UPDATE users SET trial_completion_email_sent_at/.test(sql)) {
        // Atomic claim semantics: only the first claim wins.
        if (user.trial_completion_email_sent_at) return { rows: [], rowCount: 0 };
        user.trial_completion_email_sent_at = new Date();
        return { rows: [{ id: user.id }], rowCount: 1 };
      }
      if (/UPDATE users SET claim_token/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

let pool: any;
let sent: any[] = [];
const saved: Record<string, any> = {};
let sendTrialCompletionEmailIfDeferred: (userId: string) => Promise<any>;
let email: any;
let origSend: any;

beforeAll(() => {
  for (const p of [DB, PDF, TRIAL_EMAIL]) saved[p] = require.cache[p];
  const stubModule = (p: string, exports: any) => {
    const m: any = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
    require.cache[p] = m;
  };
  stubModule(DB, {
    isDatabaseMode: () => true,
    getPool: () => pool,
    rehydrateStoryImages: async (_id: string, data: any) => data,
  });
  stubModule(PDF, { generateViewPdf: async () => Buffer.from('pdf') });
  delete require.cache[TRIAL_EMAIL];
  ({ sendTrialCompletionEmailIfDeferred } = require(TRIAL_EMAIL));
  email = require(path.join(ROOT, 'email.js'));
  origSend = email.sendStoryCompleteEmail;
  email.sendStoryCompleteEmail = async (...args: any[]) => {
    // Resend takes a moment — long enough for a second caller to pass the guard.
    await new Promise(r => setTimeout(r, 20));
    sent.push(args);
    return { id: 'msg' };
  };
});

afterAll(() => {
  email.sendStoryCompleteEmail = origSend;
  for (const p of [DB, PDF, TRIAL_EMAIL]) {
    if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p];
  }
});

describe('deferred trial completion email is sent once', () => {
  it('two overlapping calls (prefetch + click) send ONE email', async () => {
    const user = { id: 'u1', email: 'r@example.ch', is_trial: false, has_set_password: true, trial_completion_email_sent_at: null, preferred_language: 'English' };
    pool = fakePool(user);
    sent = [];
    const [a, b] = await Promise.all([
      sendTrialCompletionEmailIfDeferred('u1'),
      sendTrialCompletionEmailIfDeferred('u1'),
    ]);
    expect(sent).toHaveLength(1);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
  });

  it('a failed send releases the claim so a later call can send', async () => {
    const user = { id: 'u2', email: 'r@example.ch', is_trial: false, has_set_password: true, trial_completion_email_sent_at: null, preferred_language: 'English' };
    pool = fakePool(user);
    sent = [];
    const good = email.sendStoryCompleteEmail;
    email.sendStoryCompleteEmail = async () => { throw new Error('resend down'); };
    const first = await sendTrialCompletionEmailIfDeferred('u2');
    expect(first.sent).toBe(false);
    email.sendStoryCompleteEmail = good;
    const second = await sendTrialCompletionEmailIfDeferred('u2');
    expect(second.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
