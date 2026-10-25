/**
 * Admin voucher routes, mounted at /api/admin/vouchers: campaign batches, list, PDF, void, resend.
 */
const express = require('express');
const router = express.Router();

const { getPool } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');
const { CREDIT_CONFIG } = require('../../config/credits');
const vouchers = require('../../lib/vouchers');
const email = require('../../../email');

const V = CREDIT_CONFIG.VOUCHER;

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};
router.use(authenticateToken, requireAdmin);

function addMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d;
}

// POST /api/admin/vouchers/batch { count, label, expiresInMonths, credits?, bookCents? }
router.post('/batch', async (req, res) => {
  try {
    const count = parseInt(req.body?.count);
    if (!(count >= 1 && count <= 200)) return res.status(400).json({ error: 'count must be 1-200' });
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label is required' });
    const months = req.body?.expiresInMonths === undefined ? V.CAMPAIGN_DEFAULT_EXPIRY_MONTHS : parseInt(req.body.expiresInMonths);
    if (!(months >= 0)) return res.status(400).json({ error: 'expiresInMonths must be >= 0 (0 = never)' });
    const credits = req.body?.credits === undefined ? V.GIFT.credits : parseInt(req.body.credits);
    const bookCents = req.body?.bookCents === undefined ? V.GIFT.bookCents : parseInt(req.body.bookCents);
    if (!(credits > 0) || !(bookCents >= 0)) return res.status(400).json({ error: 'invalid credits / bookCents' });
    const expiresAt = months === 0 ? null : addMonths(months);

    const out = [];
    for (let i = 0; i < count; i++) {
      const v = await vouchers.createVoucher(getPool(), {
        kind: 'campaign', credits, bookCents, batchLabel: label, expiresAt, createdByUserId: req.user.id,
      });
      out.push({ id: v.id, code: v.code, url: vouchers.redemptionUrl(v.code), expiresAt: expiresAt ? expiresAt.toISOString() : null });
    }
    log.info(`🎁 [VOUCHER] admin ${req.user.id} created ${count} campaign vouchers "${label}"`);
    res.json({ vouchers: out });
  } catch (err) {
    log.error('❌ [VOUCHER] batch failed:', err);
    res.status(500).json({ error: 'Failed to create vouchers' });
  }
});

// GET /api/admin/vouchers?status=&kind=&label=
router.get('/', async (req, res) => {
  try {
    const rows = await vouchers.listForAdmin(getPool(), {
      status: req.query.status, kind: req.query.kind, label: req.query.label, limit: req.query.limit,
    });
    res.json({
      vouchers: rows.map(r => ({
        id: r.id,
        codePrefix: r.code_prefix,
        kind: r.kind,
        status: vouchers.publicView(r).status,
        credits: r.credits,
        bookCents: r.book_cents,
        batchLabel: r.batch_label,
        expiresAt: r.expires_at,
        purchaserEmail: r.purchaser_email,
        redeemedByEmail: r.redeemed_by_email,
        redeemedAt: r.redeemed_at,
        bookUsed: !!r.book_order_session_id,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    log.error('❌ [VOUCHER] admin list failed:', err);
    res.status(500).json({ error: 'Failed to list vouchers' });
  }
});

async function loadWithCode(id) {
  const { rows } = await getPool().query('SELECT * FROM vouchers WHERE id = $1', [parseInt(id)]);
  if (!rows[0]) return null;
  return { row: rows[0], code: vouchers.decryptCode(rows[0].code_enc) };
}

async function pdfFor({ row, code }) {
  return vouchers.renderVoucherPdf({
    code, url: vouchers.redemptionUrl(code), credits: row.credits, expiresAt: row.expires_at, language: row.language,
  });
}

// GET /api/admin/vouchers/:id/pdf
router.get('/:id/pdf', async (req, res) => {
  try {
    const v = await loadWithCode(req.params.id);
    if (!v) return res.status(404).json({ error: 'Voucher not found' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Gutschein-${v.row.code_prefix}.pdf"` });
    res.send(await pdfFor(v));
  } catch (err) {
    log.error('❌ [VOUCHER] admin pdf failed:', err);
    res.status(500).json({ error: 'Failed to render voucher' });
  }
});

// POST /api/admin/vouchers/:id/void
router.post('/:id/void', async (req, res) => {
  try {
    await vouchers.voidVoucher(getPool(), parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof vouchers.VoucherError) return res.status(409).json({ error: err.message, code: err.code });
    log.error('❌ [VOUCHER] void failed:', err);
    res.status(500).json({ error: 'Failed to void voucher' });
  }
});

// POST /api/admin/vouchers/:id/resend { email }
router.post('/:id/resend', async (req, res) => {
  try {
    const to = String(req.body?.email || '').trim();
    if (!email.validateEmailAddress(to)) return res.status(400).json({ error: 'valid email required' });
    const v = await loadWithCode(req.params.id);
    if (!v) return res.status(404).json({ error: 'Voucher not found' });
    if (vouchers.publicView(v.row).status !== 'active') return res.status(409).json({ error: 'Voucher is not active' });
    await email.sendVoucherEmail(to, v.row.language, {
      code: v.code, url: vouchers.redemptionUrl(v.code), pdfBuffer: await pdfFor(v),
      expiresAt: v.row.expires_at, credits: v.row.credits,
    });
    res.json({ ok: true });
  } catch (err) {
    log.error('❌ [VOUCHER] resend failed:', err);
    res.status(500).json({ error: 'Failed to send voucher' });
  }
});

module.exports = router;
