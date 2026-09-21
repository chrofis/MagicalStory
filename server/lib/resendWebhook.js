/**
 * RESEND WEBHOOK SIGNATURE VERIFICATION.
 *
 * Resend delivers webhooks through Svix. Every delivery carries three headers —
 * svix-id, svix-timestamp, svix-signature — and the signature is an HMAC-SHA256
 * over `${svix-id}.${svix-timestamp}.${raw body}`, keyed by the webhook's
 * signing secret, presented as `v1,<base64>` (a header may list several
 * space-separated versions during a secret rotation). Verified against Resend's
 * "Verify webhooks requests" doc on 2026-09-21.
 *
 * The scheme is NOT hand-rolled here. resend.webhooks.verify() is the vendor's
 * own implementation (it delegates to svix, which resend already depends on),
 * and it also enforces the timestamp tolerance that stops a captured delivery
 * from being replayed days later. This module exists only to give it a callable
 * shape: the Resend constructor refuses to build a client without an API key,
 * which has nothing to do with verifying an inbound signature, so the key is
 * supplied from the environment when present and a fixed placeholder otherwise.
 * The placeholder is never used to talk to the API — verify() is offline.
 *
 * It throws on ANY failure. There is no second, weaker check: an unverifiable
 * delivery is rejected, never accepted on reduced evidence.
 */

'use strict';

const { Resend } = require('resend');

/**
 * Only ever used to satisfy the constructor for the offline verify() path.
 * A real key is used when one is configured so nothing about the client differs
 * between environments.
 */
const OFFLINE_PLACEHOLDER_KEY = 're_webhook_verify_only';

let _client = null;
function _verifier() {
  if (!_client) {
    _client = new Resend(process.env.RESEND_API_KEY || OFFLINE_PLACEHOLDER_KEY);
  }
  return _client;
}

/**
 * Verify one inbound Resend delivery and return its parsed payload.
 *
 * @param {object} args
 * @param {string} args.payload  the RAW request body, exactly as received
 * @param {string} args.secret   RESEND_WEBHOOK_SECRET (whsec_… from the dashboard)
 * @param {{id: string, timestamp: string, signature: string}} args.headers
 * @returns {object} the verified, parsed event body
 * @throws if any input is missing or the signature does not verify
 */
function verifyResendWebhook(args = {}) {
  const { payload, secret, headers } = args;
  if (!secret) throw new Error('no webhook secret configured');
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('raw payload missing — express.raw() must run before express.json()');
  }
  if (!headers || !headers.id || !headers.timestamp || !headers.signature) {
    throw new Error('missing svix-id / svix-timestamp / svix-signature header');
  }

  const verified = _verifier().webhooks.verify({
    payload,
    headers: {
      id: String(headers.id),
      timestamp: String(headers.timestamp),
      signature: String(headers.signature),
    },
    webhookSecret: secret,
  });

  // svix returns the parsed payload; be explicit rather than trusting the shape.
  if (verified && typeof verified === 'object') return verified;
  return JSON.parse(payload);
}

/**
 * The POST /api/resend/webhook handler, mounted in server.js behind
 * express.raw({ type: 'application/json' }).
 *
 * Status codes are chosen against Svix's retry behaviour, and they differ from
 * the Gelato handler's always-200 on purpose:
 *   500 — no secret configured. We cannot verify anything, so we must not
 *         acknowledge; Svix retries and the events survive the misconfiguration.
 *   401 — missing headers or a signature that does not verify. Not transient,
 *         and never acknowledged as success.
 *   500 — the event verified but could not be stored. Svix retries with
 *         backoff, so a database blip costs a retry, not the event.
 *   200 — stored, or recognised as a replay of something already stored.
 */
async function resendWebhookHandler(req, res) {
  const { log } = require('../utils/logger');
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    log.error('❌ [RESEND WEBHOOK] RESEND_WEBHOOK_SECRET not configured - rejecting webhook');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) {
    log.warn('⚠️ [RESEND WEBHOOK] Missing svix-* signature headers');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

  let body;
  try {
    body = verifyResendWebhook({
      payload,
      secret,
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
    });
  } catch (err) {
    log.warn(`⚠️ [RESEND WEBHOOK] Signature verification failed: ${err.message}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const { recordEmailEvent } = require('./emailSends');
    const result = await recordEmailEvent({ svixId, body });
    if (result.duplicate) {
      log.debug(`📧 [RESEND WEBHOOK] Replay of ${result.eventType} (svix-id ${svixId}) - ignored`);
    } else {
      log.info(`📧 [RESEND WEBHOOK] ${result.eventType} recorded`);
    }
    return res.status(200).json({ received: true, duplicate: result.duplicate });
  } catch (err) {
    log.error('❌ [RESEND WEBHOOK] Error storing event:', err);
    return res.status(500).json({ error: 'Failed to store event' });
  }
}

module.exports = { verifyResendWebhook, resendWebhookHandler, OFFLINE_PLACEHOLDER_KEY };
