/**
 * Gift vouchers (server/lib/vouchers.js, plan tasks/vouchers-2026-10-25.md).
 * Pure helpers are tested directly; redeem() runs against a scripted fake pg pool.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.VOUCHER_SECRET = 'unit-test-secret';
const v = require('../../server/lib/vouchers');
const { CREDIT_CONFIG } = require('../../server/config/credits');

describe('code generation and normalization', () => {
  it('has the MS-XXXXX x4 format with Crockford chars only', () => {
    for (let i = 0; i < 50; i++) {
      expect(v.generateCode()).toMatch(/^MS(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    }
  });
  it('is unique across many draws (100 bits)', () => {
    const set = new Set(Array.from({ length: 2000 }, () => v.generateCode()));
    expect(set.size).toBe(2000);
  });
  it('normalizes case, separators and the MS prefix', () => {
    const code = v.generateCode();
    const bare = v.normalizeCode(code);
    expect(bare).toHaveLength(20);
    expect(v.normalizeCode(code.toLowerCase())).toBe(bare);
    expect(v.normalizeCode(code.replace(/-/g, ' '))).toBe(bare);
    expect(v.normalizeCode(bare)).toBe(bare);
  });
  it('maps O to 0 and I/L to 1', () => {
    expect(v.normalizeCode('MS-OOOOO-IIIII-LLLLL-00011')).toBe('00000111111111100011');
  });
  it('rejects malformed input', () => {
    expect(v.normalizeCode('')).toBe('');
    expect(v.normalizeCode('MS-ABC')).toBe('');
    expect(v.normalizeCode('MS-UUUUU-UUUUU-UUUUU-UUUUU')).toBe(''); // U is not in the alphabet
  });
  it('hashes equal for equivalent spellings', () => {
    const code = v.generateCode();
    expect(v.hashCode(code)).toBe(v.hashCode(code.toLowerCase().replace(/-/g, '')));
    expect(v.hashCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encryption at rest', () => {
  it('roundtrips', () => {
    const code = v.generateCode();
    expect(v.decryptCode(v.encryptCode(code))).toBe(code);
  });
  it('uses a fresh IV each time', () => {
    const code = v.generateCode();
    expect(v.encryptCode(code)).not.toBe(v.encryptCode(code));
  });
  it('detects tampering', () => {
    const [iv, tag, ct] = v.encryptCode(v.generateCode()).split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => v.decryptCode([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });
  it('fails loudly without VOUCHER_SECRET', () => {
    const saved = process.env.VOUCHER_SECRET;
    delete process.env.VOUCHER_SECRET;
    try {
      expect(() => v.encryptCode(v.generateCode())).toThrow(/VOUCHER_SECRET/);
    } finally {
      process.env.VOUCHER_SECRET = saved;
    }
  });
});

describe('publicView expiry', () => {
  const base = { status: 'active', credits: 500, book_cents: 5100, kind: 'gift', expires_at: null };
  const now = new Date('2026-10-25T12:00:00Z');
  it('never-expiring active voucher stays active', () => {
    expect(v.publicView(base, now).status).toBe('active');
  });
  it('past expires_at on an active voucher reads as expired', () => {
    expect(v.publicView({ ...base, expires_at: '2026-10-01T00:00:00Z' }, now).status).toBe('expired');
  });
  it('future expires_at stays active', () => {
    expect(v.publicView({ ...base, expires_at: '2027-01-01T00:00:00Z' }, now).status).toBe('active');
  });
  it('redeemed stays redeemed after expiry', () => {
    expect(v.publicView({ ...base, status: 'redeemed', expires_at: '2026-01-01T00:00:00Z' }, now).status).toBe('redeemed');
  });
  it('exposes only the public fields', () => {
    expect(Object.keys(v.publicView(base, now)).sort()).toEqual(['bookCents', 'credits', 'expiresAt', 'kind', 'status']);
  });
});

// Scripted fake pool: one voucher row and one user row; records statements.
function fakePool(voucher: any, userCredits: number) {
  const state = { voucher: { ...voucher }, credits: userCredits, tx: [] as any[], ended: [] as string[] };
  const client = {
    async query(sql: string, params: any[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) { state.ended.push(sql); return { rows: [] }; }
      if (/FROM vouchers WHERE code_hash/.test(sql)) return { rows: state.voucher.status ? [state.voucher] : [] };
      if (/SELECT credits FROM users/.test(sql)) return { rows: [{ credits: state.credits }] };
      if (/UPDATE users SET credits/.test(sql)) { state.credits = params[0]; return { rows: [] }; }
      if (/INSERT INTO credit_transactions/.test(sql)) { state.tx.push(params); return { rows: [] }; }
      if (/UPDATE vouchers SET status='redeemed'/.test(sql)) {
        state.voucher.status = 'redeemed';
        state.voucher.redeemed_by_user_id = params[0];
        return { rows: [] };
      }
      throw new Error('unexpected sql: ' + sql);
    },
    release() {},
  };
  return { state, pool: { connect: async () => client } };
}

describe('redeem state machine', () => {
  const code = v.generateCode();
  const row = { id: 7, status: 'active', credits: 500, book_cents: 5100, expires_at: null };

  it('active -> redeemed credits the user and writes the ledger row', async () => {
    const { pool, state } = fakePool(row, 200);
    const r = await v.redeem(pool, { code, userId: 'u1' });
    expect(r).toEqual({ credits: 500, balanceAfter: 700, bookCents: 5100 });
    expect(state.credits).toBe(700);
    expect(state.voucher.status).toBe('redeemed');
    expect(state.tx[0].slice(0, 4)).toEqual(['u1', 500, 700, 'voucher_7']);
    expect(state.ended).toContain('COMMIT');
  });
  it('second redeem fails with VOUCHER_REDEEMED and changes nothing', async () => {
    const { pool, state } = fakePool({ ...row, status: 'redeemed' }, 700);
    await expect(v.redeem(pool, { code, userId: 'u2' })).rejects.toMatchObject({ code: 'VOUCHER_REDEEMED' });
    expect(state.credits).toBe(700);
    expect(state.tx).toHaveLength(0);
    expect(state.ended).toContain('ROLLBACK');
  });
  it('expired voucher fails with VOUCHER_EXPIRED', async () => {
    const { pool, state } = fakePool({ ...row, expires_at: '2020-01-01T00:00:00Z' }, 0);
    await expect(v.redeem(pool, { code, userId: 'u1' })).rejects.toMatchObject({ code: 'VOUCHER_EXPIRED' });
    expect(state.credits).toBe(0);
  });
  it('void voucher fails with VOUCHER_VOID', async () => {
    const { pool } = fakePool({ ...row, status: 'void' }, 0);
    await expect(v.redeem(pool, { code, userId: 'u1' })).rejects.toMatchObject({ code: 'VOUCHER_VOID' });
  });
  it('unknown or malformed code fails with VOUCHER_NOT_FOUND', async () => {
    const { pool } = fakePool({ status: '' }, 0);
    await expect(v.redeem(pool, { code, userId: 'u1' })).rejects.toMatchObject({ code: 'VOUCHER_NOT_FOUND' });
    await expect(v.redeem(pool, { code: 'garbage', userId: 'u1' })).rejects.toMatchObject({ code: 'VOUCHER_NOT_FOUND' });
  });
  it('unlimited-credit user (-1) stays unlimited, ledger still written', async () => {
    const { pool, state } = fakePool(row, -1);
    const r = await v.redeem(pool, { code, userId: 'admin' });
    expect(r.balanceAfter).toBe(-1);
    expect(state.credits).toBe(-1);
    expect(state.tx[0][2]).toBe(-1);
  });
});

describe('voucher book coupon math (softcover 0, hardcover surcharge)', () => {
  const surcharge = CREDIT_CONFIG.VOUCHER.HARDCOVER_SURCHARGE_CENTS;
  it('softcover: coupon equals the whole list total, customer pays 0', () => {
    expect(v.bookCouponCents({ listTotalCents: 5100, hardcover: false })).toBe(5100);
  });
  it('hardcover: customer pays exactly the surcharge, whatever the list price', () => {
    for (const total of [3500, 5100, 6600]) {
      expect(total - v.bookCouponCents({ listTotalCents: total, hardcover: true })).toBe(surcharge);
    }
  });
  it('never negative for a total below the surcharge', () => {
    expect(v.bookCouponCents({ listTotalCents: 500, hardcover: true })).toBe(0);
  });
  it('config keeps the owner numbers', () => {
    expect(CREDIT_CONFIG.VOUCHER.GIFT).toEqual({ priceCents: 5900, credits: 500, bookCents: 5100 });
    expect(CREDIT_CONFIG.VOUCHER.MAX_BOOK_PAGES).toBe(50);
    expect(surcharge).toBe(1000);
  });
});

describe('PDF card', () => {
  it('renders a one-page PDF in every language', async () => {
    for (const language of ['de', 'en', 'fr', 'it', 'de-ch', 'it-ch']) {
      const code = v.generateCode();
      const buf: Buffer = await v.renderVoucherPdf({ code, url: v.redemptionUrl(code), credits: 500, expiresAt: '2027-10-25', language });
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect((buf.toString('latin1').match(/\/Type \/Page\n/g) || []).length).toBe(1);
    }
  });
});
