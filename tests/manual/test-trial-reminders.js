// Manual test for the trial-reminder sweep. Stubs the DB pool and the email
// module, then exercises both reminder paths.
//
// Run: node tests/manual/test-trial-reminders.js

const Module = require('module');
const path = require('path');

// Stub email.js BEFORE the sweep requires it.
const stubbedEmail = {
  isEmailConfigured: () => true,
  sentEmails: [],
  async sendTrialReminderEmail(userEmail, firstName, claimUrl, language, options) {
    this.sentEmails.push({ userEmail, firstName, claimUrl, language, options });
    return { id: `stub-${this.sentEmails.length}` };
  },
};
const emailPath = path.resolve(__dirname, '..', '..', 'email.js');
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: stubbedEmail };

const { runTrialReminderSweep } = require('../../server/lib/trialReminders');

function makeRows(reminderType) {
  if (reminderType === 'day5') {
    return [
      {
        id: 'u1',
        email: 'a@example.com',
        username: 'Anna Beispiel',
        shipping_first_name: null,
        preferred_language: 'German',
        claim_token: 'tok-a',
        claim_token_expires: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
      },
    ];
  }
  if (reminderType === 'day25') {
    return [
      {
        id: 'u2',
        email: 'b@example.com',
        username: 'Bob Test',
        shipping_first_name: 'Bob',
        preferred_language: 'English',
        claim_token: 'tok-b',
        claim_token_expires: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      },
      {
        id: 'u3',
        email: 'c@example.com',
        username: 'Claire',
        shipping_first_name: 'Claire',
        preferred_language: 'French',
        claim_token: 'tok-c',
        claim_token_expires: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      },
    ];
  }
  return [];
}

const updates = [];
const fakePool = {
  async query(sql, params) {
    const lower = sql.toLowerCase();
    if (lower.includes('select') && lower.includes('from users')) {
      // First call: day5; second call: day25
      if (lower.includes("created_at < now() - interval '5 days'")) {
        return { rows: makeRows('day5') };
      }
      if (lower.includes("claim_token_expires < now() + interval '5 days'")) {
        return { rows: makeRows('day25') };
      }
      return { rows: [] };
    }
    if (lower.startsWith('select') && lower.includes('from stories')) {
      return { rows: [{ title: 'A Test Story' }] };
    }
    if (lower.startsWith('update users set')) {
      updates.push({ sql, params });
      return { rowCount: 1 };
    }
    return { rows: [] };
  },
};

const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  debug: () => {},
};

(async () => {
  const result = await runTrialReminderSweep(fakePool, log);
  console.log('result:', JSON.stringify(result, null, 2));

  console.log('\n--- Sent emails ---');
  for (const sent of stubbedEmail.sentEmails) {
    console.log(`to=${sent.userEmail} lang=${sent.language} type=${sent.options.reminderType} ` +
                `daysLeft=${sent.options.daysLeft ?? '-'} claim=${sent.claimUrl}`);
  }

  console.log('\n--- DB updates ---');
  for (const u of updates) {
    console.log(`SQL: ${u.sql.trim().replace(/\s+/g, ' ')}  params=${JSON.stringify(u.params)}`);
  }

  // Assertions
  const expectations = [
    [result.sent.day5 === 1, 'day5 count = 1'],
    [result.sent.day25 === 2, 'day25 count = 2'],
    [result.errors === 0, 'no errors'],
    [stubbedEmail.sentEmails.length === 3, '3 emails sent'],
    [stubbedEmail.sentEmails[0].options.reminderType === 'day5', 'first is day5'],
    [stubbedEmail.sentEmails[1].options.reminderType === 'day25', 'second is day25'],
    [stubbedEmail.sentEmails[1].options.daysLeft > 0, 'daysLeft is positive'],
    [updates.length === 3, '3 UPDATE statements'],
    [updates[0].sql.includes('trial_reminder_5d_sent_at'), 'day5 update column'],
    [updates[1].sql.includes('trial_reminder_25d_sent_at'), 'day25 update column'],
  ];

  let ok = true;
  for (const [pass, label] of expectations) {
    console.log(`${pass ? 'PASS' : 'FAIL'} - ${label}`);
    if (!pass) ok = false;
  }
  process.exit(ok ? 0 : 1);
})();
