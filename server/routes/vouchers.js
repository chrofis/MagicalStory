/**
 * Gift voucher routes (plan: tasks/vouchers-2026-10-25.md; docs/codebase-guide.md "Gift Vouchers").
 * Public: lookup, checkout (purchase needs no login). Auth: redeem, mine, book-credit, book-checkout.
 */
const express = require('express');
const router = express.Router();

const { authenticateToken, verifySession } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { CREDIT_CONFIG } = require('../config/credits');
const { getPool } = require('../services/database');
const { log } = require('../utils/logger');
const vouchers = require('../lib/vouchers');
const { computeBookPageInfo, isBlankPagesAckMissing } = require('../lib/gelato');
const { getPriceForPages, getStripeForUser, isUserTestMode } = require('./print');

const V = CREDIT_CONFIG.VOUCHER;
const frontend = () => process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch';

const ERROR_STATUS = {
  VOUCHER_NOT_FOUND: 404,
  VOUCHER_REDEEMED: 409,
  VOUCHER_EXPIRED: 410,
  VOUCHER_VOID: 410,
};

function sendVoucherError(res, err) {
  if (err instanceof vouchers.VoucherError) {
    return res.status(ERROR_STATUS[err.code] || 400).json({ error: err.message, code: err.code });
  }
  throw err;
}

// GET /api/vouchers/lookup/:code  (public)
router.get('/vouchers/lookup/:code', authLimiter, async (req, res) => {
  try {
    const row = await vouchers.lookupByCode(getPool(), req.params.code);
    if (!row) return res.status(404).json({ error: 'Voucher not found', code: 'VOUCHER_NOT_FOUND' });
    res.json(vouchers.publicView(row));
  } catch (err) {
    log.error('❌ [VOUCHER] lookup failed:', err);
    res.status(500).json({ error: 'Voucher lookup failed' });
  }
});

// POST /api/vouchers/redeem  { code }
router.post('/vouchers/redeem', authLimiter, authenticateToken, async (req, res) => {
  try {
    const result = await vouchers.redeem(getPool(), { code: req.body?.code, userId: req.user.id });
    log.info(`🎁 [VOUCHER] redeemed by user ${req.user.id}: ${result.credits} credits`);
    res.json({ ok: true, ...result });
  } catch (err) {
    try { return sendVoucherError(res, err); } catch (e) {
      log.error('❌ [VOUCHER] redeem failed:', e);
      res.status(500).json({ error: 'Voucher redemption failed' });
    }
  }
});

// POST /api/vouchers/checkout  { language }  (no login required; optional Bearer token records the buyer)
router.post('/vouchers/checkout', async (req, res) => {
  try {
    let user = null;
    try {
      const bearer = (req.headers['authorization'] || '').split(' ')[1];
      if (bearer) user = await verifySession(bearer);
    } catch { /* anonymous buyer */ }

    const stripe = getStripeForUser(user);
    if (!stripe) {
      return res.status(500).json({ error: `Stripe not configured. Please set ${isUserTestMode(user) ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'}` });
    }
    const language = String(req.body?.language || 'de').toLowerCase().slice(0, 2);
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: 'Geschenkgutschein MagicalStory: 2 Geschichten + Buch',
            description: `${V.GIFT.credits} Credits (bis zu ${V.GIFT.credits / 10} Geschichtenseiten) + Buch bis ${V.MAX_BOOK_PAGES} Seiten inkl. Versand (CH)`,
          },
          unit_amount: V.GIFT.priceCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${frontend()}/gutschein/kaufen?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend()}/gutschein/kaufen?payment=cancelled`,
      metadata: {
        type: 'voucher',
        ...(user && { userId: String(user.id) }),
        language,
        stripeMode: isUserTestMode(user) ? 'test' : 'live',
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    log.error('❌ [VOUCHER] checkout failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/vouchers/mine
router.get('/vouchers/mine', authenticateToken, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM vouchers WHERE purchaser_user_id = $1 OR redeemed_by_user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({
      vouchers: rows.map(r => {
        const view = vouchers.publicView(r);
        const bought = r.purchaser_user_id === req.user.id;
        return {
          id: r.id,
          role: bought ? 'bought' : 'redeemed',
          status: view.status,
          credits: r.credits,
          bookCents: r.book_cents,
          expiresAt: view.expiresAt,
          createdAt: r.created_at,
          redeemedAt: r.redeemed_at,
          code: bought && view.status === 'active' ? vouchers.decryptCode(r.code_enc) : null,
          codePrefix: r.code_prefix,
          bookUsed: !!r.book_order_session_id,
        };
      }),
    });
  } catch (err) {
    log.error('❌ [VOUCHER] mine failed:', err);
    res.status(500).json({ error: 'Failed to load vouchers' });
  }
});

// GET /api/vouchers/mine/:id/pdf  (buyer only, active only)
router.get('/vouchers/mine/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM vouchers WHERE id = $1 AND purchaser_user_id = $2', [parseInt(req.params.id), req.user.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Voucher not found', code: 'VOUCHER_NOT_FOUND' });
    if (vouchers.publicView(row).status !== 'active') {
      return res.status(409).json({ error: 'Voucher is no longer active', code: 'VOUCHER_REDEEMED' });
    }
    const code = vouchers.decryptCode(row.code_enc);
    const pdf = await vouchers.renderVoucherPdf({
      code, url: vouchers.redemptionUrl(code), credits: row.credits, expiresAt: row.expires_at, language: row.language,
    });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Magical-Story-Gutschein.pdf"' });
    res.send(pdf);
  } catch (err) {
    log.error('❌ [VOUCHER] pdf failed:', err);
    res.status(500).json({ error: 'Failed to render voucher' });
  }
});

// GET /api/vouchers/book-credit
router.get('/vouchers/book-credit', authenticateToken, async (req, res) => {
  try {
    const credit = await vouchers.getBookCreditAvailable(getPool(), req.user.id);
    res.json({ ...credit, maxPages: V.MAX_BOOK_PAGES, hardcoverSurchargeCents: V.HARDCOVER_SURCHARGE_CENTS });
  } catch (err) {
    log.error('❌ [VOUCHER] book-credit failed:', err);
    res.status(500).json({ error: 'Failed to load book credit' });
  }
});

// POST /api/vouchers/book-checkout  { storyIds, coverType, bookFormat, blankPagesAcknowledged }
// Owner rule 2026-10-25: softcover CHF 0, hardcover CHF 10, CH shipping included, up to 50 pages.
// The Stripe line item carries the normal list price (receipt shows the real value); a one-time
// coupon takes off everything except the hardcover surcharge.
router.post('/vouchers/book-checkout', authenticateToken, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.id;
    const { storyIds, bookFormat = 'A4' } = req.body || {};
    const coverType = req.body?.coverType === 'hardcover' ? 'hardcover' : 'softcover';
    if (!Array.isArray(storyIds) || storyIds.length === 0) {
      return res.status(400).json({ error: 'No stories provided' });
    }
    const credit = await vouchers.getBookCreditAvailable(pool, userId);
    if (!credit.available) {
      return res.status(409).json({ error: 'No voucher book credit available', code: 'VOUCHER_BOOK_NOT_AVAILABLE' });
    }
    const stripe = getStripeForUser(req.user);
    const isTestMode = isUserTestMode(req.user);
    if (!stripe) {
      return res.status(500).json({ error: `Stripe not configured. Please set ${isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY'}` });
    }

    const stories = [];
    for (const sid of storyIds) {
      const r = await pool.query('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
      if (r.rows.length === 0) return res.status(404).json({ error: `Story not found: ${sid}` });
      stories.push({ id: sid, data: typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data });
    }
    const pageInfo = await computeBookPageInfo(pool, stories.map(s => s.data), coverType, bookFormat);
    // Price tier and voucher page limit = the PRINTED content page count of the chosen layout
    // (decisions.md, book layout by scene count).
    const totalPages = pageInfo.contentPages;
    if (totalPages > V.MAX_BOOK_PAGES) {
      return res.status(400).json({ error: `A voucher book has at most ${V.MAX_BOOK_PAGES} pages`, code: 'VOUCHER_BOOK_TOO_LONG', totalPages, max: V.MAX_BOOK_PAGES });
    }
    if (isBlankPagesAckMissing(pageInfo.blankPages, req.body.blankPagesAcknowledged)) {
      return res.status(400).json({
        error: `This book has ${pageInfo.blankPages} blank pages; the blank pages must be acknowledged before checkout.`,
        code: 'BLANK_PAGES_NOT_ACKNOWLEDGED',
        blankPages: pageInfo.blankPages,
      });
    }

    const isHardcover = coverType === 'hardcover';
    const SHIPPING_COST_CHF = 10; // same flat CH shipping as the normal checkout
    const listTotalCents = ((await getPriceForPages(totalPages, isHardcover)) + SHIPPING_COST_CHF) * 100;
    const couponCents = vouchers.bookCouponCents({ listTotalCents, hardcover: isHardcover });
    log.info(`🎁 [VOUCHER BOOK] user ${userId}: list CHF ${listTotalCents / 100}, voucher -CHF ${couponCents / 100}, pays CHF ${(listTotalCents - couponCents) / 100}`);

    const firstTitle = stories[0].data.title;
    const bookTitle = stories.length === 1 ? firstTitle : `${firstTitle} + ${stories.length - 1} more`;
    const { PRINT_SHIPPING_COUNTRIES } = require('../config/print');
    const coupon = await stripe.coupons.create({
      amount_off: couponCents, currency: 'chf', duration: 'once', name: 'Geschenkgutschein Buch',
    });
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `Personalized Storybook: ${bookTitle}`,
            description: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}, ${totalPages} pages, ${coverType} — incl. CHF ${SHIPPING_COST_CHF} shipping`,
          },
          unit_amount: listTotalCents,
        },
        quantity: 1,
      }],
      discounts: [{ coupon: coupon.id }],
      mode: 'payment',
      // A softcover voucher book totals CHF 0. Do NOT set payment_method_collection here: Stripe
      // rejects it in payment mode ("only if there are recurring prices", seen on staging
      // 2026-10-25); a zero-total payment-mode session completes without a card on its own.
      success_url: `${frontend()}/orders?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend()}/gutschein/buch?payment=cancelled`,
      metadata: {
        userId: userId.toString(),
        storyIds: JSON.stringify(storyIds),
        storyCount: stories.length.toString(),
        totalPages: totalPages.toString(),
        blankPagesAcknowledged: pageInfo.blankPages.toString(),
        coverType,
        bookFormat,
        quantity: '1',
        stripeMode: isTestMode ? 'test' : 'live',
        voucherBook: '1',
      },
      shipping_address_collection: { allowed_countries: PRINT_SHIPPING_COUNTRIES },
    });

    // The session URL has not been handed out yet, so expiring on a lost claim race is safe.
    const claim = await vouchers.claimBookCredit(pool, { userId, sessionId: session.id });
    if (!claim) {
      try { await stripe.checkout.sessions.expire(session.id); } catch (e) {
        log.error(`❌ [VOUCHER BOOK] failed to expire unclaimed session ${session.id}: ${e.message}`);
      }
      return res.status(409).json({ error: 'Voucher book credit was already used', code: 'VOUCHER_BOOK_ALREADY_USED' });
    }
    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    log.error('❌ [VOUCHER BOOK] checkout failed:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

module.exports = router;
