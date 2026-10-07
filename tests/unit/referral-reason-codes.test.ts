/**
 * A rejected promo code is explained in the customer's language. Until 2026-10-07 BookBuilder
 * printed the server's English `reason` ("Code not found", "You have already used a referral
 * code") to German, French and Italian customers. The server now sends a stable REFERRAL_* code
 * the client localises through apiErrors.ts; `reason` stays English for the logs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { localizedApiError, KNOWN_API_ERROR_CODES } from '../../client/src/utils/apiErrors';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(__dirname, '../..');

// Fake DB: one code owner (u-owner, MagicAnna123), buyers by id.
const buyers: Record<string, { referred_by: string | null; email: string; paid: boolean }> = {
  'u-new': { referred_by: null, email: 'new@example.ch', paid: false },
  'u-used': { referred_by: 'MagicX1', email: 'used@example.ch', paid: false },
  'u-paid': { referred_by: null, email: 'paid@example.ch', paid: true },
  'u-owner': { referred_by: null, email: 'anna@example.ch', paid: false },
};
const pool = {
  query: async (sql: string, params: any[]) => {
    if (sql.includes('LOWER(referral_code)')) {
      return String(params[0]).toLowerCase() === 'magicanna123'
        ? { rows: [{ id: 'u-owner', referral_code: 'MagicAnna123', email: 'anna@example.ch' }] } : { rows: [] };
    }
    if (sql.includes('SELECT referred_by, email FROM users')) return { rows: [buyers[params[0]]] };
    if (sql.includes('FROM orders')) return { rows: buyers[params[0]]?.paid ? [{ 1: 1 }] : [] };
    throw new Error('unexpected: ' + sql.slice(0, 50));
  },
};
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-referral-codes';
const database = require('../../server/services/database');
database.getPool = () => pool;
const { validateReferralCodeForUser: validate } = require('../../server/routes/print.js');

describe('validateReferralCodeForUser rejection codes', () => {
  it('names every rejection with a stable code', async () => {
    expect(await validate('', 'u-new')).toMatchObject({ valid: false, code: 'REFERRAL_CODE_REQUIRED' });
    expect(await validate('   ', 'u-new')).toMatchObject({ valid: false, code: 'REFERRAL_CODE_REQUIRED' });
    expect(await validate('NoSuchCode1', 'u-new')).toMatchObject({ valid: false, code: 'REFERRAL_CODE_NOT_FOUND' });
    expect(await validate('MagicAnna123', 'u-owner')).toMatchObject({ valid: false, code: 'REFERRAL_OWN_CODE' });
    expect(await validate('MagicAnna123', 'u-used')).toMatchObject({ valid: false, code: 'REFERRAL_ALREADY_USED' });
    expect(await validate('MagicAnna123', 'u-paid')).toMatchObject({ valid: false, code: 'REFERRAL_FIRST_ORDER_ONLY' });
  });
  it('accepts the code whatever its case or surrounding whitespace', async () => {
    const r = await validate('  magicanna123 ', 'u-new');
    expect(r).toMatchObject({ valid: true, referrerUserId: 'u-owner', storedCode: 'MagicAnna123', discountChf: 10 });
  });
  it('every code the server can send is localised in all four languages, never the English reason', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/print.js'), 'utf8');
    const codes = [...new Set([...src.matchAll(/code: '(REFERRAL_[A-Z_]+)'/g)].map(m => m[1]))];
    expect(codes.length).toBeGreaterThanOrEqual(5);
    for (const code of codes) {
      expect(KNOWN_API_ERROR_CODES, code).toContain(code);
      for (const l of ['de', 'fr', 'it']) {
        expect(localizedApiError({ code }, l), `${code}/${l}`).not.toBe(localizedApiError({ code }, 'en'));
      }
    }
    const builder = fs.readFileSync(path.join(ROOT, 'client/src/pages/BookBuilder.tsx'), 'utf8');
    expect(builder).not.toMatch(/setPromoError\(result\.reason/);
    expect(builder).toMatch(/setPromoError\(localizedApiError\(\{ code: result\.code \}, language\)\)/);
  });
});
