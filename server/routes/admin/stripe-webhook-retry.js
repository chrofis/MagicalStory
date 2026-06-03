/**
 * Admin: Stripe webhook retry buffer
 *
 * The Stripe webhook handler buffers events whose post-verification
 * processing threw — instead of returning 400 (which made Stripe abandon
 * the event) it now buffers + acks 200. This module exposes the buffer
 * so an operator can inspect and dismiss rows.
 *
 * Automated draining (full processing-handler extraction) lives in the
 * long-term plan; for now this is a visibility + manual-replay surface.
 */

const express = require('express');
const router = express.Router();

const { getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/stripe-webhook-retry — list unprocessed buffered events
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) return res.status(400).json({ error: 'Database mode required' });
    const pool = getPool();
    const rows = await pool.query(`
      SELECT id, event_id, event_type, error_message, retry_count, created_at, processed_at
      FROM stripe_webhook_retry
      WHERE processed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({
      unprocessed: rows.rows,
      count: rows.rowCount,
    });
  } catch (err) {
    log.error('[ADMIN/STRIPE-RETRY] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stripe-webhook-retry/:id — full payload for one buffered event
router.get('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) return res.status(400).json({ error: 'Database mode required' });
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, event_id, event_type, payload, error_message, error_stack,
              retry_count, created_at, processed_at
       FROM stripe_webhook_retry
       WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    log.error('[ADMIN/STRIPE-RETRY] get failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/stripe-webhook-retry/:id/dismiss — mark as processed
// (operator has handled it manually — e.g. comped the customer, retried via Stripe Dashboard).
router.post('/:id/dismiss', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) return res.status(400).json({ error: 'Database mode required' });
    const pool = getPool();
    const result = await pool.query(
      `UPDATE stripe_webhook_retry
       SET processed_at = NOW(), retry_count = retry_count + 1
       WHERE id = $1 AND processed_at IS NULL
       RETURNING id, event_id, event_type`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found or already processed' });
    log.info(`[ADMIN/STRIPE-RETRY] event ${result.rows[0].event_id} (${result.rows[0].event_type}) dismissed by ${req.user?.email || req.user?.id}`);
    res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    log.error('[ADMIN/STRIPE-RETRY] dismiss failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
