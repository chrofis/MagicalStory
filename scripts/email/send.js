#!/usr/bin/env node
/**
 * Send one SUPPORT email through Resend from any address on a domain verified in
 * Resend (magicalstory.ch today: roger@, support@, info@ ... no mailbox needed to
 * SEND). Replies land wherever the address's MX points (IONOS), so a
 * reply-receiving address also needs a mailbox/alias there.
 *
 * A real send goes through sendTracked (server/lib/emailSends.js), so it is
 * recorded in email_sends and appears in the daily admin recap ("Support" block).
 *
 *   node scripts/email/send.js --from "Roger Fischer <roger@magicalstory.ch>" --to a@b.ch  *        --subject "Hallo" --text-file msg.txt [--html-file msg.html] [--reply-to x@y] [--cc a,b] [--bcc a,b]  *        --type support-<slug> [--story-id ..] [--user-id ..] [--order-id ..] [--lang it] [--db staging] [--send]
 *
 * Without --send it only prints what it would send (dry run).
 * Records into the PRODUCTION DB (DATABASE_URL); --db staging uses STAGING_DATABASE_URL.
 * A failed record exits non-zero AFTER the send and never resends.
 *
 * Backfill an email that was already sent (no Resend call, writes one email_sends row):
 *   node scripts/email/send.js --record-only --resend-id <id> --type support-<slug>  *        --from .. --to .. --subject .. [--story-id ..] [--user-id ..] [--order-id ..] [--lang ..] [--db staging]
 */
require('dotenv').config();
const fs = require('fs');
const { Resend } = require('resend');
const { Pool } = require('pg');
const { parseSendArgs, buildDetail } = require('./sendArgs');
const { sendTracked, recordEmailSend, setEmailSendsPool } = require('../../server/lib/emailSends');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function openPool(db) {
  const url = db === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${db === 'staging' ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} not set`);
  process.env.RAILWAY_ENVIRONMENT_NAME = db; // email_sends.environment
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  setEmailSendsPool(pool);
  return pool;
}

async function main() {
  const { errors, opts } = parseSendArgs(process.argv.slice(2));
  if (errors.length) { console.error(`ERR:\n  ${errors.join('\n  ')}`); process.exit(1); }
  const detail = buildDetail(opts);

  if (opts.recordOnly) {
    const pool = openPool(opts.db);
    try {
      const id = await recordEmailSend({
        emailType: opts.type, recipient: opts.to[0], subject: opts.subject, language: opts.lang,
        storyId: opts.storyId, userId: opts.userId, resendMessageId: opts.resendId, status: 'sent',
        detail: { ...detail, backfilled: true },
      });
      if (id == null) { console.error(`ERR: email_sends row NOT written (see log above, or ${opts.resendId} already recorded)`); process.exit(2); }
      console.log(`RECORDED - email_sends id ${id} (${opts.db}) for Resend id ${opts.resendId}`);
    } finally { await pool.end(); }
    return;
  }

  const { from, to, subject } = opts;
  const text = arg('text-file') ? fs.readFileSync(arg('text-file'), 'utf8') : arg('text');
  const html = arg('html-file') ? fs.readFileSync(arg('html-file'), 'utf8') : undefined;
  if (!from || !to || !subject || (!text && !html)) {
    console.error('Need --from, --to, --subject and --text/--text-file or --html-file');
    process.exit(1);
  }
  const msg = { from, to, subject, text, html, cc: list(arg('cc')), bcc: list(arg('bcc')), replyTo: arg('reply-to') };

  console.log(`From:     ${msg.from}\nTo:       ${to.join(', ')}${msg.cc ? `\nCc:       ${msg.cc.join(', ')}` : ''}`);
  if (msg.bcc) console.log(`Bcc:      ${msg.bcc.join(', ')}`);
  if (msg.replyTo) console.log(`Reply-To: ${msg.replyTo}`);
  console.log(`Subject:  ${subject}\n\n${text || '(html only)'}\n`);
  if (!opts.send) { console.log('DRY RUN - nothing sent (add --send).'); return; }

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const pool = openPool(opts.db); // before the send: a bad DB URL must fail while nothing has gone out
  try {
    let recorded = false;
    let recordedId = null;
    const { data, error } = await sendTracked(
      new Resend(process.env.RESEND_API_KEY), opts.type, msg,
      { storyId: opts.storyId, userId: opts.userId, language: opts.lang, detail,
        onRecorded: (id) => { recorded = true; recordedId = id; } }
    );
    if (error) throw new Error(`${error.name}: ${error.message} (recorded as send_failed)`);
    console.log(`SENT - Resend id ${data.id}`);
    if (recorded && recordedId != null) console.log(`RECORDED - email_sends id ${recordedId} (${opts.db})`);
    else {
      console.error(`ERR: the email WAS SENT (Resend id ${data.id}) but the email_sends record FAILED. DO NOT resend. ` +
        `Backfill with --record-only --resend-id ${data.id} --type ${opts.type} ...`);
      process.exit(2);
    }
  } finally { await pool.end(); }
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
