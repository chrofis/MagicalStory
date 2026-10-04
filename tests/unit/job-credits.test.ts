/**
 * Credit movements — behaviour pins (code review 2026-10-04: BILL-1 B1/B2/R2, P5, R1, A3).
 *
 * A scripted fake pg client plays the role of the DB; what is pinned is WHAT HAPPENS, not SQL text:
 * a debit that matches no row writes no ledger row, a refund and its status flip commit
 * together or not at all, and a job that is no longer in a transitionable state is not refunded.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - CJS module
import { chargeCredits, refundCharge, settleJobWithRefund } from '../../server/lib/jobCredits.js';

type Handler = (sql: string, params: any[]) => { rows: any[] } | undefined;

function fakePool(handler: Handler) {
  const log: string[] = [];
  const client = {
    query: async (sql: string, params: any[] = []) => {
      const trimmed = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(trimmed)) { log.push(trimmed.split(/\s/)[0]); return { rows: [] }; }
      const res = handler(sql, params);
      log.push(sql.includes('credit_transactions') ? 'LEDGER' : sql.includes('UPDATE users') ? 'USERS' : sql.includes('story_jobs') ? 'JOBS' : 'OTHER');
      if (res === undefined) throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
      return res;
    },
    release: () => log.push('RELEASE'),
  };
  return { log, pool: { connect: async () => client } };
}

describe('chargeCredits', () => {
  it('writes the ledger row with the real post-debit balance when the debit matched', async () => {
    let ledgerParams: any[] = [];
    const { pool, log } = fakePool((sql, params) => {
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 40 }] };
      if (sql.includes('credit_transactions')) { ledgerParams = params; return { rows: [] }; }
    });
    const r = await chargeCredits(pool, { userId: 'u1', cost: 10, transactionType: 'image_iteration', description: 'd' });
    expect(r).toEqual({ charged: true, credits: 40 });
    expect(ledgerParams.slice(0, 3)).toEqual(['u1', -10, 40]);
    expect(log).toContain('COMMIT');
  });

  it('writes NO ledger row and rolls back when the balance floor rejects the debit', async () => {
    const { pool, log } = fakePool((sql) => (sql.includes('UPDATE users') ? { rows: [] } : undefined));
    const r = await chargeCredits(pool, { userId: 'u1', cost: 10, transactionType: 'x', description: 'd' });
    expect(r.charged).toBe(false);
    expect(log).not.toContain('LEDGER');
    expect(log).toContain('ROLLBACK');
  });

  it('rolls the debit back when the ledger insert fails', async () => {
    const { pool, log } = fakePool((sql) => {
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 5 }] };
      throw new Error('ledger down');
    });
    await expect(chargeCredits(pool, { userId: 'u1', cost: 1, transactionType: 'x', description: 'd' })).rejects.toThrow('ledger down');
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });
});

describe('refundCharge', () => {
  it('credits and logs in one transaction; unlimited accounts get nothing', async () => {
    const unlimited = fakePool((sql) => (sql.includes('UPDATE users') ? { rows: [] } : undefined));
    expect(await refundCharge(unlimited.pool, { userId: 'u', amount: 2, description: 'd' })).toBeNull();
    expect(unlimited.log).not.toContain('LEDGER');
    const normal = fakePool((sql) => (sql.includes('UPDATE users') ? { rows: [{ credits: 12 }] } : { rows: [] }));
    expect(await refundCharge(normal.pool, { userId: 'u', amount: 2, description: 'd' })).toBe(12);
    expect(normal.log).toEqual(['BEGIN', 'USERS', 'LEDGER', 'COMMIT', 'RELEASE']);
  });
});

describe('settleJobWithRefund', () => {
  const describe_ = ({ refunded, progress }: any) => `refund ${refunded} @${progress}`;

  it('claims, credits and logs in ONE transaction when the status transition happened', async () => {
    let ledger: any[] = [];
    const { pool, log } = fakePool((sql, params) => {
      if (sql.includes('UPDATE story_jobs')) return { rows: [{ prev: 30, uid: 'u1', prog: 40, claimed: true }] };
      if (sql.includes('UPDATE users')) return { rows: [{ credits: 130 }] };
      if (sql.includes('credit_transactions')) { ledger = params; return { rows: [] }; }
    });
    const r = await settleJobWithRefund(pool, 'job1', { status: 'cancelled', statusIn: ['pending', 'processing'], describe: describe_ });
    expect(r).toMatchObject({ changed: true, refunded: 30, userId: 'u1' });
    expect(ledger).toEqual(['u1', 30, 130, 'job1', 'refund 30 @40']);
    expect(log).toEqual(['BEGIN', 'JOBS', 'USERS', 'LEDGER', 'COMMIT', 'RELEASE']);
  });

  it('refunds nothing and changes nothing when the guard no longer matches (finished / cancelled job)', async () => {
    const { pool, log } = fakePool((sql) => (sql.includes('UPDATE story_jobs') ? { rows: [] } : undefined));
    const r = await settleJobWithRefund(pool, 'job1', { status: 'cancelled', statusIn: ['pending', 'processing'], describe: describe_ });
    expect(r.changed).toBe(false);
    expect(r.refunded).toBe(0);
    expect(log).not.toContain('USERS');
    expect(log).not.toContain('LEDGER');
    expect(log).toContain('ROLLBACK');
  });

  it('a crash after the claim rolls the claim back (reservation is not lost)', async () => {
    const { pool, log } = fakePool((sql) => {
      if (sql.includes('UPDATE story_jobs')) return { rows: [{ prev: 30, uid: 'u1', prog: 10, claimed: true }] };
      throw new Error('connection lost');
    });
    await expect(settleJobWithRefund(pool, 'job1', { status: 'failed', describe: describe_ })).rejects.toThrow('connection lost');
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('status moves but nothing is refunded when the reservation was not claimed (progress too high)', async () => {
    const { pool, log } = fakePool((sql) => (sql.includes('UPDATE story_jobs') ? { rows: [{ prev: 30, uid: 'u1', prog: 100, claimed: false }] } : undefined));
    const r = await settleJobWithRefund(pool, 'job1', { status: 'failed', refundIfProgressBelow: 100, describe: describe_ });
    expect(r).toMatchObject({ changed: true, refunded: 0 });
    expect(log).not.toContain('LEDGER');
  });

  it('puts every requested guard into the single UPDATE', async () => {
    let seen = '';
    const { pool } = fakePool((sql) => { seen = sql; return { rows: [] }; });
    await settleJobWithRefund(pool, 'j', {
      status: 'failed', statusNotIn: ['cancelled'], progressBelow: 99, idleForMinutes: 15, describe: describe_,
    });
    expect(seen).toMatch(/FOR UPDATE/);
    expect(seen).toMatch(/status = ANY/);
    expect(seen).toMatch(/updated_at </);
  });
});

// Wiring pins: these defects were "the sibling route does it right, this one does not".
describe('route wiring (BILL-1 / pinning)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  it('no credit debit in regeneration.js / stories.js skips RETURNING', () => {
    for (const f of ['server/routes/regeneration.js', 'server/routes/stories.js']) {
      const src = read(f);
      const all = [...src.matchAll(/UPDATE users SET credits = credits - \$1 WHERE id = \$2 AND credits >= \$1([^'`]*)['`]/g)];
      for (const m of all) expect(m[1]).toContain('RETURNING credits');
    }
  });

  it('paid scene regenerate and edit pin the new version', () => {
    const src = read('server/routes/regeneration.js');
    const pin = /setActiveVersion\(id, `\$\{pageNumber\}`, .*pinned: true/;
    const regen = src.slice(src.indexOf("router.post('/:id/regenerate/image/:pageNum'"), src.indexOf("router.post('/:id/regenerate/cover/:coverType'"));
    expect(regen).toMatch(pin);
    const edit = src.slice(src.indexOf("router.post('/:id/edit/image/:pageNum'"));
    expect(edit.slice(0, 14000)).toMatch(pin);
  });

  it('character repair pre-check covers every requested page', () => {
    expect(read('server/routes/regeneration.js')).toMatch(/requestedRepairPages \* creditCost/);
  });
});
