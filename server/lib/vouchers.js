/**
 * Gift / campaign vouchers (plan: tasks/vouchers-2026-10-25.md, docs/decisions.md "Gift vouchers").
 *
 * A code is 20 Crockford base32 chars (100 bits). Only its sha256 (lookup) and an AES-256-GCM
 * ciphertext (so the card can be re-sent) are stored. State machine: active -> redeemed | void.
 * "expired" is derived from expires_at, never stored.
 */
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { CREDIT_CONFIG } = require('../config/credits');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I L O U
const CODE_CHARS = CREDIT_CONFIG.VOUCHER.CODE_CHARS;

class VoucherError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function formatCode(raw) {
  return 'MS-' + raw.match(/.{1,5}/g).join('-');
}

function generateCode() {
  // 256 / 32 = 8, so byte & 31 is unbiased.
  const bytes = crypto.randomBytes(CODE_CHARS);
  let raw = '';
  for (let i = 0; i < CODE_CHARS; i++) raw += ALPHABET[bytes[i] & 31];
  return formatCode(raw);
}

// Uppercase, strip separators, map the look-alikes O->0, I/L->1, drop the MS prefix.
// Returns the bare 20 chars, or '' when the input cannot be a code.
function normalizeCode(input) {
  let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.startsWith('MS') && s.length === CODE_CHARS + 2) s = s.slice(2);
  if (s.length !== CODE_CHARS) return '';
  for (const ch of s) if (!ALPHABET.includes(ch)) return '';
  return s;
}

function hashCode(code) {
  const n = normalizeCode(code);
  if (!n) throw new VoucherError('VOUCHER_NOT_FOUND', 'Malformed voucher code');
  return crypto.createHash('sha256').update(n).digest('hex');
}

function secretKey() {
  if (!process.env.VOUCHER_SECRET) throw new Error('VOUCHER_SECRET is not set');
  return crypto.createHash('sha256').update(process.env.VOUCHER_SECRET).digest();
}

function encryptCode(code) {
  const n = normalizeCode(code);
  if (!n) throw new VoucherError('VOUCHER_NOT_FOUND', 'Malformed voucher code');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const ct = Buffer.concat([cipher.update(formatCode(n), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}

function decryptCode(enc) {
  const [iv, tag, ct] = String(enc).split(':').map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function redemptionUrl(code) {
  const base = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch';
  return `${base}/gutschein/einloesen/${code}`;
}

function isExpired(row, now = new Date()) {
  return !!row.expires_at && new Date(row.expires_at) <= now;
}

function publicView(row, now = new Date()) {
  let status = row.status;
  if (status === 'active' && isExpired(row, now)) status = 'expired';
  return {
    status,
    credits: row.credits,
    bookCents: row.book_cents,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    kind: row.kind,
  };
}

async function createVoucher(db, {
  kind, credits, bookCents, batchLabel = null, expiresAt = null, purchaserUserId = null,
  purchaserEmail = null, stripeSessionId = null, stripeMode = null, language = 'de', createdByUserId = null,
}) {
  const code = generateCode();
  const { rows } = await db.query(
    `INSERT INTO vouchers (code_hash, code_enc, code_prefix, kind, credits, book_cents, batch_label, expires_at,
        purchaser_user_id, purchaser_email, stripe_session_id, stripe_mode, language, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [hashCode(code), encryptCode(code), code.slice(0, 8), kind, credits, bookCents, batchLabel, expiresAt,
      purchaserUserId, purchaserEmail, stripeSessionId, stripeMode, language, createdByUserId]
  );
  return { id: rows[0].id, code, row: rows[0] };
}

async function lookupByCode(db, code) {
  const n = normalizeCode(code);
  if (!n) return null;
  const { rows } = await db.query('SELECT * FROM vouchers WHERE code_hash = $1', [hashCode(n)]);
  return rows[0] || null;
}

// Pure state check shared by redeem() and its tests.
function assertRedeemable(row, now = new Date()) {
  if (!row) throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found');
  if (row.status === 'redeemed') throw new VoucherError('VOUCHER_REDEEMED', 'Voucher already redeemed');
  if (row.status === 'void') throw new VoucherError('VOUCHER_VOID', 'Voucher is void');
  if (isExpired(row, now)) throw new VoucherError('VOUCHER_EXPIRED', 'Voucher expired');
}

async function redeem(pool, { code, userId }) {
  const n = normalizeCode(code);
  if (!n) throw new VoucherError('VOUCHER_NOT_FOUND', 'Voucher not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const v = await client.query('SELECT * FROM vouchers WHERE code_hash = $1 FOR UPDATE', [hashCode(n)]);
    const row = v.rows[0];
    assertRedeemable(row);
    const u = await client.query('SELECT credits FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (u.rows.length === 0) throw new Error('User not found for voucher redemption');
    const current = u.rows[0].credits || 0;
    const balanceAfter = current === -1 ? -1 : current + row.credits; // unlimited stays unlimited
    if (current !== -1) await client.query('UPDATE users SET credits = $1 WHERE id = $2', [balanceAfter, userId]);
    await client.query(
      `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
       VALUES ($1,$2,$3,'voucher_redeem',$4,$5)`,
      [userId, row.credits, balanceAfter, `voucher_${row.id}`, `Gutschein eingelöst: ${row.credits} credits`]
    );
    await client.query(
      `UPDATE vouchers SET status='redeemed', redeemed_by_user_id=$1, redeemed_at=now(), updated_at=now() WHERE id=$2`,
      [userId, row.id]
    );
    await client.query('COMMIT');
    return { credits: row.credits, balanceAfter, bookCents: row.book_cents };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function claimBookCredit(db, { userId, sessionId }) {
  const { rows } = await db.query(
    `UPDATE vouchers SET book_order_session_id = $2, updated_at = now()
      WHERE id = (SELECT id FROM vouchers
                   WHERE redeemed_by_user_id = $1 AND status = 'redeemed' AND book_order_session_id IS NULL
                   ORDER BY redeemed_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND book_order_session_id IS NULL
      RETURNING id, book_cents`,
    [userId, sessionId]
  );
  return rows[0] ? { voucherId: rows[0].id, bookCents: rows[0].book_cents } : null;
}

async function releaseBookCredit(db, { sessionId }) {
  const { rowCount } = await db.query(
    'UPDATE vouchers SET book_order_session_id = NULL, updated_at = now() WHERE book_order_session_id = $1',
    [sessionId]
  );
  return rowCount > 0;
}

async function getBookCreditAvailable(db, userId) {
  const { rows } = await db.query(
    `SELECT book_cents FROM vouchers
      WHERE redeemed_by_user_id = $1 AND status = 'redeemed' AND book_order_session_id IS NULL
      ORDER BY redeemed_at LIMIT 1`,
    [userId]
  );
  return { available: rows.length > 0, bookCents: rows[0]?.book_cents || 0 };
}

// Voucher book price rule (owner, 2026-10-25): list price on the receipt, a one-time coupon takes
// off everything except the hardcover surcharge. Returns the coupon amount in cents.
// The facing-pages layout surcharge (layoutSurchargeCents) is part of the list total but is never covered:
// the customer pays it like the hardcover surcharge (decisions.md 2026-10-27).
function bookCouponCents({ listTotalCents, hardcover, layoutSurchargeCents = 0 }) {
  const pay = (hardcover ? CREDIT_CONFIG.VOUCHER.HARDCOVER_SURCHARGE_CENTS : 0) + layoutSurchargeCents;
  return Math.max(0, listTotalCents - pay);
}

async function listForAdmin(db, { status, kind, label, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`v.status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`v.kind = $${params.length}`); }
  if (label) { params.push(label); where.push(`v.batch_label = $${params.length}`); }
  params.push(Math.min(1000, Math.max(1, parseInt(limit) || 200)));
  const { rows } = await db.query(
    `SELECT v.*, u.email AS redeemed_by_email FROM vouchers v
       LEFT JOIN users u ON u.id = v.redeemed_by_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY v.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function voidVoucher(db, id) {
  const { rows } = await db.query(
    "UPDATE vouchers SET status='void', updated_at=now() WHERE id=$1 AND status='active' RETURNING id", [id]);
  if (!rows[0]) throw new VoucherError('VOUCHER_NOT_ACTIVE', 'Only an active voucher can be voided');
}

// ── PDF card ────────────────────────────────────────────────────────────────

const PDF_STRINGS = {
  de: {
    title: 'Geschenkgutschein', subtitle: 'Gift voucher',
    contains: (c, p) => `${c} Credits für bis zu ${c / 10} Geschichtenseiten und ein Buch bis ${p} Seiten inkl. Versand (CH): Softcover gratis, Hardcover gegen CHF 10 Aufpreis.`,
    expiry: d => `Gültig bis ${d}`, noExpiry: 'Unbefristet gültig',
    steps: ['QR-Code scannen oder Link öffnen', 'Konto erstellen oder anmelden und den Gutschein einlösen', 'Geschichte erstellen und das Buch bestellen'],
    code: 'Dein Code',
  },
  en: {
    title: 'Gift voucher', subtitle: 'Geschenkgutschein',
    contains: (c, p) => `${c} credits for up to ${c / 10} story pages and a book of up to ${p} pages incl. shipping (CH): softcover free, hardcover for CHF 10 extra.`,
    expiry: d => `Valid until ${d}`, noExpiry: 'No expiry date',
    steps: ['Scan the QR code or open the link', 'Create an account or log in and redeem the voucher', 'Create a story and order the book'],
    code: 'Your code',
  },
  fr: {
    title: 'Bon cadeau', subtitle: 'Gift voucher',
    contains: (c, p) => `${c} crédits pour jusqu'à ${c / 10} pages d'histoire et un livre jusqu'à ${p} pages, livraison (CH) incluse : couverture souple offerte, couverture rigide avec supplément de CHF 10.`,
    expiry: d => `Valable jusqu'au ${d}`, noExpiry: 'Sans date limite',
    steps: ['Scanner le code QR ou ouvrir le lien', 'Créer un compte ou se connecter et utiliser le bon', 'Créer une histoire et commander le livre'],
    code: 'Votre code',
  },
  it: {
    title: 'Buono regalo', subtitle: 'Gift voucher',
    contains: (c, p) => `${c} crediti per fino a ${c / 10} pagine di storia e un libro fino a ${p} pagine, spedizione (CH) inclusa: copertina morbida gratis, copertina rigida con supplemento di CHF 10.`,
    expiry: d => `Valido fino al ${d}`, noExpiry: 'Senza scadenza',
    steps: ['Scansiona il codice QR o apri il link', 'Crea un account o accedi e riscatta il buono', 'Crea una storia e ordina il libro'],
    code: 'Il tuo codice',
  },
};

function pdfLang(language) {
  const l = String(language || 'de').toLowerCase().slice(0, 2);
  return PDF_STRINGS[l] ? l : 'en';
}

async function renderVoucherPdf({ code, url, credits, expiresAt, language }) {
  const s = PDF_STRINGS[pdfLang(language)];
  const qr = await QRCode.toBuffer(url, { margin: 1, width: 400, errorCorrectionLevel: 'M' });
  const doc = new PDFDocument({ size: [595.28, 419.53], margin: 0, info: { Title: s.title } }); // A5 landscape
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const W = 595.28, H = 419.53, M = 36;
  doc.rect(0, 0, W, H).fill('#FAF7F2');
  doc.rect(M / 2, M / 2, W - M, H - M).lineWidth(1.5).stroke('#6366F1');
  doc.fillColor('#312E81').font('Helvetica-Bold').fontSize(26).text(s.title, M, M, { width: W - 2 * M - 170 });
  doc.fillColor('#6B7280').font('Helvetica').fontSize(12).text(s.subtitle, M, doc.y + 2, { width: W - 2 * M - 170 });
  doc.image(qr, W - M - 150, M, { width: 150 });
  doc.fillColor('#6B7280').fontSize(9).text(s.code, W - M - 150, M + 154, { width: 150, align: 'center' });
  doc.fillColor('#111827').font('Courier-Bold').fontSize(9.5).text(code, W - M - 175, M + 166, { width: 200, align: 'center', lineBreak: false });

  const leftW = W - 2 * M - 190;
  doc.fillColor('#111827').font('Helvetica').fontSize(11).text(s.contains(credits, CREDIT_CONFIG.VOUCHER.MAX_BOOK_PAGES), M, 110, { width: leftW });
  const exp = expiresAt ? s.expiry(new Date(expiresAt).toLocaleDateString('de-CH')) : s.noExpiry;
  doc.fillColor('#6B7280').fontSize(10).text(exp, M, doc.y + 8, { width: leftW });
  doc.moveDown(1.2);
  doc.fillColor('#111827').font('Helvetica').fontSize(11);
  s.steps.forEach((st, i) => doc.text(`${i + 1}.  ${st}`, M, doc.y + 4, { width: leftW }));
  doc.fillColor('#4F46E5').font('Helvetica-Bold').fontSize(12).text('magicalstory.ch', M, H - M - 18, { width: W - 2 * M });
  doc.end();
  return done;
}

module.exports = {
  VoucherError, generateCode, normalizeCode, hashCode, encryptCode, decryptCode, redemptionUrl,
  isExpired, publicView, assertRedeemable, createVoucher, lookupByCode, redeem, claimBookCredit,
  releaseBookCredit, getBookCreditAvailable, bookCouponCents, renderVoucherPdf, listForAdmin, voidVoucher,
};
