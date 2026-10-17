/**
 * Argument parsing + validation for scripts/email/send.js (pure, unit-tested).
 *
 * WHY (owner, 2026-10-17): every support email Claude sends to a customer must
 * show up in the daily admin recap, which reads email_sends. So a real send
 * needs a `support-*` type, and the script records it through sendTracked.
 */
'use strict';

const TYPE_RE = /^support-[a-z0-9][a-z0-9-]*$/;
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{errors: string[], opts: object}}
 */
function parseSendArgs(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? undefined : v;
  };
  const has = (name) => argv.includes(`--${name}`);

  const opts = {
    send: has('send'),
    recordOnly: has('record-only'),
    from: arg('from'),
    to: list(arg('to')),
    subject: arg('subject'),
    type: arg('type'),
    storyId: arg('story-id'),
    userId: arg('user-id'),
    lang: arg('lang'),
    orderId: arg('order-id'),
    resendId: arg('resend-id'),
    db: arg('db') || 'production',
  };

  const errors = [];
  if (!['production', 'staging'].includes(opts.db)) errors.push('--db must be "staging" (default is production)');
  if (opts.send && opts.recordOnly) errors.push('--send and --record-only are mutually exclusive');
  if (opts.recordOnly) {
    if (!opts.type) errors.push('--record-only requires --type');
    if (!opts.resendId) errors.push('--record-only requires --resend-id');
    if (!opts.from || !opts.to || !opts.subject) errors.push('--record-only requires --from, --to and --subject');
  }
  if ((opts.send || opts.recordOnly) && opts.type && !TYPE_RE.test(opts.type)) {
    errors.push('--type must be a slug starting with "support-" (e.g. support-short-trial-book)');
  }
  if (opts.send && !opts.type) errors.push('--send requires --type support-<slug>');
  return { errors, opts };
}

/** The email_sends.detail object for a support send. */
function buildDetail(opts) {
  const detail = { source: 'scripts/email/send.js' };
  if (opts.orderId) detail.orderId = opts.orderId;
  return detail;
}

module.exports = { parseSendArgs, buildDetail, TYPE_RE };
