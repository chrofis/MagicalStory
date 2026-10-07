// The trial-reminder sweep mails each address at most once per reminder, even
// when two sweeps run over the same rows at the same time.
//
// Before 2026-10-07 sendOne sent first and stamped trial_reminder_*_sent_at
// after. Two sweeps overlap in production whenever a deploy's boot sweep (60 s
// after start) meets the hourly tick of the container it replaces; both read
// the same unclaimed rows and both sent. A stamp that failed after a
// successful send re-sent on the next tick too. The sweep now claims the row
// with `UPDATE ... WHERE <column> IS NULL RETURNING id` before sending, skips
// when the claim is lost, and hands the claim back when the send fails.

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

// Stub email.js before the sweep requires it (CommonJS require cache; the same
// approach as tests/manual/test-trial-reminders.js).
const sent: Array<{ userEmail: string; reminderType: string }> = [];
let sendResult: (() => unknown) = () => ({ id: 'stub' });
const emailPath = path.join(ROOT, 'email.js');
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: {
    isEmailConfigured: () => true,
    resolveGreetingName: () => 'Anna',
    async sendTrialReminderEmail(userEmail: string, _n: string, _u: string, _l: string, options: { reminderType: string }) {
      sent.push({ userEmail, reminderType: options.reminderType });
      return sendResult();
    },
  },
} as never;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runTrialReminderSweep } = require(path.join(ROOT, 'server/lib/trialReminders.js'));

const ROW = {
  id: 'u1', email: 'a@example.com', username: 'Anna', shipping_first_name: null,
  preferred_language: 'German', claim_token: 'tok',
  claim_token_expires: new Date(Date.now() + 20 * 24 * 3600 * 1000),
};

// A pool that behaves like users.trial_reminder_5d_sent_at: the day-5 SELECT
// returns the row while it is unstamped, the claim UPDATE stamps it only when
// it is still NULL, and the release UPDATE clears it.
function makePool() {
  const state = { stamped5: false, stamped25: false, releaseFails: false };
  const pool = {
    state,
    async query(sql: string, params: unknown[]) {
      if (/FROM users/.test(sql) && /trial_reminder_5d_sent_at IS NULL/.test(sql)) {
        return { rows: state.stamped5 ? [] : [ROW] };
      }
      if (/FROM users/.test(sql) && /trial_reminder_25d_sent_at IS NULL/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM stories/.test(sql)) return { rows: [] };
      if (/UPDATE users SET trial_reminder_5d_sent_at = NOW\(\)/.test(sql)) {
        expect(sql).toMatch(/trial_reminder_5d_sent_at IS NULL/);
        expect(params).toEqual(['u1']);
        if (state.stamped5) return { rows: [] };
        state.stamped5 = true;
        return { rows: [{ id: 'u1' }] };
      }
      if (/UPDATE users SET trial_reminder_5d_sent_at = NULL/.test(sql)) {
        if (state.releaseFails) throw new Error('db down');
        state.stamped5 = false;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pool;
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => {
  sent.length = 0;
  sendResult = () => ({ id: 'stub' });
});

describe('trial-reminder sweep claims a row before mailing it', () => {
  it('two sweeps over the same unclaimed row send exactly once', async () => {
    const pool = makePool();
    const [a, b] = await Promise.all([
      runTrialReminderSweep(pool, quiet),
      runTrialReminderSweep(pool, quiet),
    ]);
    expect(sent).toEqual([{ userEmail: 'a@example.com', reminderType: 'day5' }]);
    expect(a.sent.day5 + b.sent.day5).toBe(1);
    expect(a.errors + b.errors).toBe(0);
    expect(pool.state.stamped5).toBe(true);
  });

  it('a second sweep after a successful one sends nothing', async () => {
    const pool = makePool();
    await runTrialReminderSweep(pool, quiet);
    const again = await runTrialReminderSweep(pool, quiet);
    expect(sent).toHaveLength(1);
    expect(again.sent.day5).toBe(0);
  });

  it('a failed send hands the claim back, and the next sweep retries', async () => {
    const pool = makePool();
    sendResult = () => null;
    const first = await runTrialReminderSweep(pool, quiet);
    expect(first.errors).toBe(1);
    expect(first.sent.day5).toBe(0);
    expect(pool.state.stamped5).toBe(false);

    sendResult = () => ({ id: 'stub' });
    const second = await runTrialReminderSweep(pool, quiet);
    expect(second.sent.day5).toBe(1);
    expect(sent).toHaveLength(2);
    expect(pool.state.stamped5).toBe(true);
  });

  it('a failed send whose release also fails is counted as an error and said at ERROR', async () => {
    const pool = makePool();
    pool.state.releaseFails = true;
    sendResult = () => null;
    const errors: string[] = [];
    const log = { ...quiet, error: (m: string) => errors.push(m) };
    const result = await runTrialReminderSweep(pool, log);
    expect(result.errors).toBe(1);
    expect(errors.some((m) => /could not be released/.test(m))).toBe(true);
    // The row stays stamped: the reminder is lost, not duplicated.
    expect(pool.state.stamped5).toBe(true);
  });
});
