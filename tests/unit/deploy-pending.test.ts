/**
 * The deploy-pending flag closes the push gate's build window.
 *
 * Measured 2026-09-25: the gate said idle (correctly) for two staging pushes,
 * then Test Lab experiments 1472 and 1477 were started 35 s and 4 s after the
 * pushes landed and died when Railway cut over 2-3 minutes later. The gate
 * checks one instant; the flag covers the minutes after it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dp = require('../../server/lib/deployPending.js');
const gate = require('../../scripts/admin/check-push-idle.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const T0 = Date.parse('2026-09-25T14:03:17Z');

/** A config table of one row, behind the same (sql, params) → rows contract as dbQuery. */
function fakeConfig() {
  const store = new Map<string, string>();
  const query = async (sql: string, params: any[]) => {
    if (/^SELECT/.test(sql)) return store.has(params[0]) ? [{ config_value: store.get(params[0]) }] : [];
    if (/^INSERT/.test(sql)) { store.set(params[0], params[1]); return []; }
    if (/^DELETE/.test(sql)) { if (store.get(params[0]) === params[1]) store.delete(params[0]); return []; }
    throw new Error(`unexpected sql ${sql}`);
  };
  return { store, query };
}

describe('the flag', () => {
  it('is live after set, and expires at its TTL', async () => {
    const { query } = fakeConfig();
    await dp.setDeployPending({ targetCommit: SHA_A, setBy: 't' }, { query, now: T0 });
    expect((await dp.getDeployPending({ query, now: T0 + 1000 })).targetCommit).toBe(SHA_A);
    expect(await dp.getDeployPending({ query, now: T0 + dp.TTL_MS - 1 })).not.toBeNull();
    expect(await dp.getDeployPending({ query, now: T0 + dp.TTL_MS })).toBeNull();
  });

  it('refuses a commit that is not a full sha', async () => {
    const { query } = fakeConfig();
    await expect(dp.setDeployPending({ targetCommit: 'a5a1fba6' }, { query, now: T0 })).rejects.toThrow(/full 40-char/);
  });

  it('clears when a container boots on the flagged commit', async () => {
    const { query, store } = fakeConfig();
    await dp.setDeployPending({ targetCommit: SHA_A }, { query, now: T0 });
    expect(await dp.clearDeployPendingAtBoot(SHA_A, { query, now: T0 + 120000 })).toBe('cleared');
    expect(store.size).toBe(0);
  });

  it('push A then push B: A booting does NOT reopen the window while B is coming', async () => {
    const { query } = fakeConfig();
    await dp.setDeployPending({ targetCommit: SHA_A }, { query, now: T0 });
    await dp.setDeployPending({ targetCommit: SHA_B }, { query, now: T0 + 60000 });
    expect(await dp.clearDeployPendingAtBoot(SHA_A, { query, now: T0 + 120000 })).toBe('kept');
    expect((await dp.getDeployPending({ query, now: T0 + 120000 })).targetCommit).toBe(SHA_B);
    expect(await dp.clearDeployPendingAtBoot(SHA_B, { query, now: T0 + 240000 })).toBe('cleared');
  });

  it('an expired row is removed at boot; boot never throws', async () => {
    const { query, store } = fakeConfig();
    await dp.setDeployPending({ targetCommit: SHA_A }, { query, now: T0 });
    expect(await dp.clearDeployPendingAtBoot(SHA_B, { query, now: T0 + dp.TTL_MS + 1 })).toBe('expired');
    expect(store.size).toBe(0);
    const broken = async () => { throw new Error('db down'); };
    expect(await dp.clearDeployPendingAtBoot(SHA_A, { query: broken })).toBe('error');
  });

  it('an unreadable row throws rather than reading as "no deploy pending"', () => {
    expect(() => dp.parseFlag('{not json', T0)).toThrow();
    expect(() => dp.parseFlag('{"targetCommit":"x"}', T0)).toThrow(/expiresAt/);
  });
});

describe('the Test Lab start routes refuse while it is set', () => {
  it('both START routes carry the guard', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/routes/admin/testlab.js'), 'utf8');
    expect(src).toMatch(/router\.post\('\/experiments', refuseWhileDeployPending,/);
    expect(src).toMatch(/router\.post\('\/sets\/:id\/run', refuseWhileDeployPending,/);
  });

  it('the refusal names the commit and when it ends', () => {
    const msg = dp.refusalMessage({ targetCommit: SHA_A, expiresAt: new Date(T0 + 90000).toISOString() }, T0);
    expect(msg).toContain('aaaaaaaa');
    expect(msg).toContain('90s');
  });

  it('boot clears it, and /api/health/busy reports it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    expect(src).toMatch(/\.clearDeployPendingAtBoot\(process\.env\.RAILWAY_GIT_COMMIT_SHA/);
    expect(src).toMatch(/deployPending = await require\('\.\/server\/lib\/deployPending'\)\.getDeployPending\(\)/);
  });
});

describe('the push gate sets it', () => {
  it('maps each gated ref to the commit it deploys', () => {
    const refs = gate.parseRefs(`refs/heads/x ${SHA_A} refs/heads/staging ${'0'.repeat(40)}\nrefs/heads/y ${SHA_B} refs/heads/feature ${'0'.repeat(40)}\n`);
    expect(gate.targetCommits(refs)).toEqual({ staging: SHA_A });
  });

  it('posts the commit with the admin token', async () => {
    let seen: any;
    const fetchFn = async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ ok: true, deployPending: { expiresAt: 'x' } }), { status: 200 }); };
    await gate.markDeployPending(gate.ENVIRONMENTS['refs/heads/staging'], SHA_A, { getToken: () => 'tok', fetchFn });
    expect(seen.url).toBe('https://staging.magicalstory.ch/api/admin/deploy-pending');
    expect(seen.init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(seen.init.body).commit).toBe(SHA_A);
  });

  it('fails loudly when the flag cannot be set — no push goes ahead unflagged', async () => {
    const env = gate.ENVIRONMENTS['refs/heads/staging'];
    const notFound = async () => new Response('Not Found', { status: 404 });
    await expect(gate.markDeployPending(env, SHA_A, { getToken: () => 'tok', fetchFn: notFound })).rejects.toThrow(/HTTP 404/);
    const noLogin = () => { throw Object.assign(new Error('x'), { stderr: 'login failed: 429' }); };
    await expect(gate.markDeployPending(env, SHA_A, { getToken: noLogin })).rejects.toThrow(/login failed: 429/);
  });

  it('a stopped container is marked down, so the gate does not try to flag it', async () => {
    // Railway's edge answers 502 for a stopped deployment.
    const http = require('http');
    const server = http.createServer((req: any, res: any) => { res.writeHead(502); res.end(); });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok()));
    try {
      const r = await gate.probe(`http://127.0.0.1:${server.address().port}`);
      expect(r.verdict).toBe('idle');
      expect(r.down).toBe(true);
    } finally {
      server.close();
    }
  });

  it('a live idle app is NOT marked down, so it gets flagged', async () => {
    const http = require('http');
    const server = http.createServer((req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ busy: false, reasons: [], deployPending: null }));
    });
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', () => ok()));
    try {
      const r = await gate.probe(`http://127.0.0.1:${server.address().port}`);
      expect(r.verdict).toBe('idle');
      expect(r.down).toBeFalsy();
    } finally {
      server.close();
    }
  });
});
