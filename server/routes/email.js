/**
 * Email Routes - /api/email/*
 *
 * GET  /api/email/unsubscribe/:token  — the link in the mail; answers a small
 *                                       localized confirmation page.
 * POST /api/email/unsubscribe/:token  — RFC 8058 one-click (the mail carries
 *                                       `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
 *                                       so Gmail/Apple Mail POST here with no page
 *                                       shown). Same effect, plain 200.
 *
 * Both stamp users.marketing_opt_out_at (migration 045) for the user the token
 * was signed for (server/lib/unsubscribeToken.js) and are idempotent: a second
 * click keeps the first timestamp. Only PROMOTIONAL mail reads the column — the
 * trial reminder sweep (server/lib/trialReminders.js). Transactional mail
 * (verification, password reset, order, story complete) never carries this
 * link and is never gated on it.
 */

const express = require('express');
const router = express.Router();

const { verify } = require('../lib/unsubscribeToken');
const { getPool } = require('../services/database');
const { log } = require('../utils/logger');

// Four languages, du / vous / tu as the mails themselves (docs/decisions.md,
// email/text entries). Swiss German: ss, never ß.
const COPY = {
  ENGLISH: {
    title: 'Unsubscribed',
    body: 'You will receive no more reminder emails from Magical Story. Emails about your own orders and stories still reach you.',
    invalid: 'This unsubscribe link is not valid.',
  },
  GERMAN: {
    title: 'Abgemeldet',
    body: 'Du erhältst keine Erinnerungs-E-Mails mehr von Magical Story. E-Mails zu deinen eigenen Bestellungen und Geschichten erreichen dich weiterhin.',
    invalid: 'Dieser Abmeldelink ist ungültig.',
  },
  FRENCH: {
    title: 'Désabonnement confirmé',
    body: 'Vous ne recevrez plus d’e-mails de rappel de Magical Story. Les e-mails concernant vos propres commandes et histoires continueront de vous parvenir.',
    invalid: 'Ce lien de désabonnement n’est pas valide.',
  },
  ITALIAN: {
    title: 'Disiscrizione confermata',
    body: 'Non riceverai più e-mail di promemoria da Magical Story. Le e-mail sui tuoi ordini e sulle tue storie continueranno ad arrivarti.',
    invalid: 'Questo link di disiscrizione non è valido.',
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(lang, title, body) {
  const htmlLang = { ENGLISH: 'en', GERMAN: 'de-CH', FRENCH: 'fr-CH', ITALIAN: 'it-CH' }[lang] || 'en';
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – Magical Story</title>
<style>
  body { margin: 0; padding: 48px 16px; background: #faf7f2; color: #1f2937; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 520px; margin: 0 auto; background: #fff; border: 1px solid #e7e0d6; border-radius: 12px; padding: 32px 28px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { font-size: 16px; line-height: 24px; margin: 0 0 16px; }
  a { color: #4f46e5; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
<p><a href="https://magicalstory.ch">magicalstory.ch</a></p>
</main>
</body>
</html>
`;
}

// Stamp the opt-out; returns the user's language (template marker) or null
// when the token does not verify or names no user.
async function optOut(token) {
  const userId = verify(token);
  if (!userId) return null;
  const pool = getPool();
  if (!pool) throw new Error('unsubscribe: no database pool');
  const { rows } = await pool.query(
    `UPDATE users
        SET marketing_opt_out_at = COALESCE(marketing_opt_out_at, NOW())
      WHERE id = $1
  RETURNING preferred_language`,
    [userId]
  );
  if (rows.length === 0) return null;
  const { normalizeLanguage } = require('../../email');
  log.info(`📧 [unsubscribe] ${userId} opted out of reminder mail`);
  return normalizeLanguage(rows[0].preferred_language);
}

router.get('/unsubscribe/:token', async (req, res) => {
  try {
    const lang = await optOut(req.params.token);
    res.setHeader('Cache-Control', 'no-store');
    if (!lang) {
      return res.status(400).type('html').send(page('ENGLISH', COPY.ENGLISH.title, COPY.ENGLISH.invalid));
    }
    const c = COPY[lang] || COPY.ENGLISH;
    return res.status(200).type('html').send(page(lang, c.title, c.body));
  } catch (err) {
    log.error(`❌ [unsubscribe] failed: ${err.message}`);
    return res.status(500).type('html').send(page('ENGLISH', 'Error', 'Something went wrong. Please write to info@magicalstory.ch.'));
  }
});

// One-click (RFC 8058): mail clients POST `List-Unsubscribe=One-Click` here.
// The body is not read — the token is the whole instruction.
router.post('/unsubscribe/:token', async (req, res) => {
  try {
    const lang = await optOut(req.params.token);
    if (!lang) return res.status(400).json({ error: 'invalid token' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error(`❌ [unsubscribe] one-click failed: ${err.message}`);
    return res.status(500).json({ error: 'unsubscribe failed' });
  }
});

module.exports = router;
