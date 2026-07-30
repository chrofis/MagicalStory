/**
 * Admin Diagnostics — GET /api/admin/diagnostics
 *
 * One-page health answer for "X is broken on staging and I can't reach Railway
 * logs": which commit is actually running, is the DB reachable, did all prompt
 * templates load, which AI provider keys are configured, and — because story
 * ideas are the FIRST Anthropic call in the funnel — a live 1-token Anthropic
 * ping that surfaces the exact API error (invalid key, quota, deprecated model)
 * instead of a generic 500. Admin-gated, read-only, no state changes.
 */

const express = require('express');
const router = express.Router();

const { getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

const startedAt = new Date().toISOString();

router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  const out = {
    now: new Date().toISOString(),
    startedAt,
    uptimeSec: Math.round(process.uptime()),
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || null,
    node: process.version,
  };

  // DB
  try {
    if (!isDatabaseMode()) { out.db = 'file-mode'; }
    else { await getPool().query('SELECT 1'); out.db = 'ok'; }
  } catch (e) { out.db = `ERROR: ${e.message}`; }

  // Prompt templates
  try {
    const { PROMPT_TEMPLATES } = require('../../services/prompts');
    const keys = Object.keys(PROMPT_TEMPLATES);
    const empty = keys.filter(k => !PROMPT_TEMPLATES[k]);
    out.templates = { loaded: keys.length, empty: empty.length ? empty : undefined };
  } catch (e) { out.templates = `ERROR: ${e.message}`; }

  // Provider key presence (never the values)
  out.keys = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    xai: !!process.env.XAI_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    runware: !!process.env.RUNWARE_API_KEY,
  };

  // Live 1-token Anthropic ping with the SAME model the ideas call uses —
  // surfaces the true API error (401 bad key, 429 quota, 404 retired model).
  // ?ping=0 skips it.
  if (req.query.ping !== '0') {
    try {
      const { TEXT_MODELS, MODEL_DEFAULTS } = require('../../config/models');
      const modelId = TEXT_MODELS[MODEL_DEFAULTS.idea]?.modelId || 'claude-sonnet-4-6';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.json().catch(() => ({}));
      out.anthropicPing = r.ok
        ? { ok: true, model: modelId }
        : { ok: false, status: r.status, model: modelId, error: body?.error?.message || JSON.stringify(body).slice(0, 300) };
    } catch (e) {
      out.anthropicPing = { ok: false, error: e.message };
    }
  }

  log.info(`[DIAGNOSTICS] db=${out.db} templates=${out.templates?.loaded} anthropicPing=${out.anthropicPing ? JSON.stringify(out.anthropicPing.ok ?? out.anthropicPing) : 'skipped'}`);
  res.json(out);
});

module.exports = router;
