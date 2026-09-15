import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { probe, renderVerdict, resolveTargets, evaluateTargets, ENVIRONMENTS } =
  require('../../scripts/admin/check-push-idle.js');

/**
 * THE TWO READERS MUST NOT DISAGREE.
 *
 * `.githooks/pre-push` (gate 8) and the by-hand status check CLAUDE.md points at
 * are the same file in two modes. On 2026-09-13, twice:
 *
 *   $ node scripts/admin/check-push-idle.js; echo EXIT=$?
 *   ✓ staging is idle — commit 129cb7a6
 *   EXIT=0
 *   $ git push origin staging
 *   ✗ PUSH BLOCKED — staging is busy • testlab: 1 experiment(s) running
 *
 * Same endpoint, same probe, same rendering — opposite verdicts on the exit code
 * and on stdout, because manual mode hard-coded exit 0 and sent its bad news to
 * stderr. These tests pin the AGREEMENT, not the wording.
 *
 * FIXTURES ARE REAL. The idle body was captured live on 2026-09-14:
 *   GET https://staging.magicalstory.ch/api/health/busy
 *   → 200 {"busy":false,"reasons":[],"env":"staging","commit":"5de87541"}
 * The busy `reasons` strings are the ones the server actually emits — see
 * server/lib/idleShutdown.js (`${name}: ...` from busyReport(), with the probe
 * texts `N job(s) in flight` and `N experiment(s) running`) — and the testlab
 * line is quoted verbatim from the blocked push above. The 500 body is
 * server.js's own catch: `{busy:true, reasons:[...]}` with no `env`/`commit`.
 */

const LIVE_IDLE = { busy: false, reasons: [], env: 'staging', commit: '5de87541' };
const LIVE_BUSY_TESTLAB = {
  busy: true,
  reasons: ['testlab: 1 experiment(s) running'],
  env: 'staging',
  commit: '129cb7a6',
};
const LIVE_BUSY_STORY = {
  busy: true,
  reasons: ['story-jobs: 1 job(s) in flight'],
  env: 'production',
  commit: 'a79c8bee',
};
const SERVER_CATCH_500 = { busy: true, reasons: ['busy check failed: connection terminated'] };

const staging = ENVIRONMENTS['refs/heads/staging'];
const ROOT = join(__dirname, '..', '..');

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function stubFetch(impl: () => any) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const r = impl();
    if (r instanceof Error) throw r;
    return r;
  }));
}

function networkError(code: string) {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

/** Both readers, same server answer: hook verdict and manual verdict. */
async function bothModes() {
  const hook = await evaluateTargets([staging], { manual: false });
  const manual = await evaluateTargets([staging], { manual: true });
  return { hook, manual };
}

afterEach(() => vi.unstubAllGlobals());

describe('a busy environment blocks BOTH readers', () => {
  it('a running Test Lab experiment: the hook blocks and the manual check fails too', async () => {
    stubFetch(() => jsonResponse(200, LIVE_BUSY_TESTLAB));
    const { hook, manual } = await bothModes();
    expect(hook.blocked).toBe(true);
    // The exact regression: manual used to fold this to exit 0.
    expect(manual.blocked).toBe(true);
  });

  it('a running story generation blocks both readers', async () => {
    stubFetch(() => jsonResponse(200, LIVE_BUSY_STORY));
    const { hook, manual } = await bothModes();
    expect(hook.blocked).toBe(true);
    expect(manual.blocked).toBe(true);
  });

  it('the manual report names the busy work ON STDOUT, where the ✓ lines are', async () => {
    stubFetch(() => jsonResponse(200, LIVE_BUSY_TESTLAB));
    const { manual } = await bothModes();
    const stdout = manual.lines.filter(([s]: [string, string]) => s === 'log')
      .map(([, t]: [string, string]) => t).join('\n');
    // A stdout-only capture (agent, pipe, log file) must see the bad news.
    expect(stdout).toContain('testlab: 1 experiment(s) running');
    expect(stdout).toContain('BUSY');
  });

  it('an idle environment clears both readers', async () => {
    stubFetch(() => jsonResponse(200, LIVE_IDLE));
    const { hook, manual } = await bothModes();
    expect(hook.blocked).toBe(false);
    expect(manual.blocked).toBe(false);
  });
});

describe('the gate never fails open', () => {
  it('server 500 from its own busy-check catch is not idle', async () => {
    stubFetch(() => jsonResponse(500, SERVER_CATCH_500));
    const { hook, manual } = await bothModes();
    expect(hook.blocked).toBe(true);
    expect(manual.blocked).toBe(true);
  });

  it('a 200 with an unreadable body is not idle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); },
    })));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('unknown');
    expect(r.verdict).not.toBe('idle');
  });

  it('a 200 whose body lost the `busy` field is not idle', async () => {
    stubFetch(() => jsonResponse(200, { status: 'ok', env: 'staging' }));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('unknown');
  });

  it('a rate-limited 429 is not idle', async () => {
    stubFetch(() => jsonResponse(429, { error: 'Too many requests' }));
    const { hook, manual } = await bothModes();
    expect(hook.blocked).toBe(true);
    expect(manual.blocked).toBe(true);
  });

  it('a timeout is not idle', async () => {
    stubFetch(() => networkError('UND_ERR_HEADERS_TIMEOUT'));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('unknown');
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])(
    'REGRESSION: a DNS failure (%s) is OUR network, not a stopped container — it blocks',
    async (code) => {
      // These two were classed with ECONNREFUSED as "container is down →
      // idle", so a flaky laptop resolver printed a green ✓ over a production
      // generation in flight. A name that never resolved proves nothing.
      stubFetch(() => networkError(code));
      const r = await probe(staging.base);
      expect(r.verdict).toBe('unknown');
      const { hook, manual } = await bothModes();
      expect(hook.blocked).toBe(true);
      expect(manual.blocked).toBe(true);
    },
  );

  it('a DNS failure aggregated across IPv4+IPv6 attempts still blocks', async () => {
    stubFetch(() => Object.assign(new TypeError('fetch failed'), {
      cause: { errors: [{ code: 'ENOTFOUND' }, { code: 'ENOTFOUND' }] },
    }));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('unknown');
  });
});

describe('positive evidence of a stopped deployment still passes', () => {
  // Staging shuts itself down to stop paying for idle RAM (idleShutdown.js).
  // Blocking on that would make a sleeping environment unpushable.
  it.each([502, 503])('Railway edge %i = the deployment is stopped, nothing can be running', async (status) => {
    stubFetch(() => jsonResponse(status, {}));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('idle');
  });

  it('ECONNREFUSED = the name resolved and nothing is listening', async () => {
    stubFetch(() => networkError('ECONNREFUSED'));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('idle');
  });

  it('404 = the route is missing — unknown, blocks in both modes (the bootstrap allowance is gone, 2026-09-15)', async () => {
    stubFetch(() => jsonResponse(404, {}));
    const r = await probe(staging.base);
    expect(r.verdict).toBe('unknown');
    expect(renderVerdict(staging, r, { manual: true }).blocked).toBe(true);
    expect(renderVerdict(staging, r, { manual: false }).blocked).toBe(true);
  });

  it('no verdict other than idle can let a push through', () => {
    for (const verdict of ['busy', 'unknown', 'ungated', 'anything-else']) {
      expect(renderVerdict(staging, { verdict, reasons: [], detail: 'd' }, { manual: false }).blocked).toBe(true);
    }
  });
});

describe('WIRING GUARD: the divergence cannot come back', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'admin', 'check-push-idle.js'), 'utf8');

  it('the exit code is derived from `blocked` alone, with no mode in the expression', () => {
    const line = source.split('\n').find(l => l.includes('process.exitCode =') && l.includes('blocked'));
    expect(line, 'no exitCode assignment derived from `blocked` found').toBeTruthy();
    // `(!manual && blocked) ? 1 : 0` is the exact expression that made the
    // status check exit 0 over a busy environment.
    expect(line).not.toMatch(/manual/);
  });

  it('every verdict blocks identically in both modes', () => {
    for (const verdict of ['idle', 'busy', 'unknown']) {
      const result = { verdict, reasons: ['x'], detail: 'd' };
      expect(
        renderVerdict(staging, result, { manual: false }).blocked,
        `${verdict} diverges between hook and manual`,
      ).toBe(renderVerdict(staging, result, { manual: true }).blocked);
    }
  });

  it('main() folds the results through the one shared resolver, not its own loop', () => {
    expect(source).toMatch(/const \{ blocked, lines \} = await evaluateTargets\(targets, \{ manual \}\)/);
  });

  it('the hook still forwards git\'s arguments, so hook mode is detectable at all', () => {
    // Without "$@" the hook looks like a by-hand run: it would report every
    // environment instead of gating the pushed one.
    const hookSrc = readFileSync(join(ROOT, '.githooks', 'pre-push'), 'utf8');
    expect(hookSrc).toMatch(/check-push-idle\.js" "\$@"/);
  });

  it('a hook run on a feature branch gates nothing and a manual run gates everything', () => {
    expect(resolveTargets([], { manual: false })).toHaveLength(0);
    expect(resolveTargets([], { manual: true }).length).toBeGreaterThan(0);
  });
});
