#!/usr/bin/env node
/**
 * Send one email through Resend from any address on a domain verified in Resend
 * (magicalstory.ch today: roger@, support@, info@ ... no mailbox needed to SEND).
 * Replies land wherever the address's MX points (IONOS for magicalstory.ch), so a
 * reply-receiving address also needs a mailbox/alias there.
 *
 *   node scripts/email/send.js --from "Roger Fischer <roger@magicalstory.ch>" --to a@b.ch \
 *        --subject "Hallo" --text-file msg.txt [--html-file msg.html] [--reply-to x@y] [--cc a,b] [--bcc a,b] [--send]
 *
 * Without --send it only prints what it would send (dry run).
 */
require('dotenv').config();
const fs = require('fs');
const { Resend } = require('resend');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const from = arg('from');
  const to = list(arg('to'));
  const subject = arg('subject');
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
  if (!process.argv.includes('--send')) { console.log('DRY RUN - nothing sent (add --send).'); return; }

  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send(msg);
  if (error) throw new Error(`${error.name}: ${error.message}`);
  console.log(`SENT - Resend id ${data.id}`);
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
