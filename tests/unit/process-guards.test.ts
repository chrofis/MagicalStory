import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const guards: any = nodeRequire('../../server/lib/processGuards.js');
const emailMod: any = nodeRequire('../../email.js');

function deps() {
  return {
    log: { error: vi.fn() },
    recordFailure: vi.fn(),
    sendAdminAlert: vi.fn().mockResolvedValue(null),
  };
}

describe('processGuards', () => {
  beforeEach(() => guards._resetForTests());

  it('registers each handler exactly once, even when installed twice', () => {
    const proc: any = new EventEmitter();
    const d = deps();
    expect(guards.installProcessGuards({ ...d, proc, exit: vi.fn() })).toBe(true);
    expect(guards.installProcessGuards({ ...d, proc, exit: vi.fn() })).toBe(false);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
  });

  it('refuses to install without its dependencies (no silent no-op)', () => {
    expect(() => guards.installProcessGuards({})).toThrow(/required/);
  });

  it('unhandledRejection logs the stack, records a failure and alerts the admin', async () => {
    const d = deps();
    const err = new Error('boom');
    const r = await guards.handleProcessFailure('unhandledRejection', err, d);
    expect(r.alerted).toBe(true);
    expect(d.log.error.mock.calls[0][0]).toContain('boom');
    expect(d.log.error.mock.calls[0][0]).toContain('at ');            // stack present
    expect(d.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'process_unhandledRejection', summary: 'unhandledRejection: boom',
    }));
    expect(d.sendAdminAlert).toHaveBeenCalledTimes(1);
    expect(d.sendAdminAlert.mock.calls[0][4]).toContain('boom');
  });

  it('dedupes the admin alert for the same message inside the window, but still records', async () => {
    const d = deps();
    const t0 = 1_000_000;
    const a = await guards.handleProcessFailure('unhandledRejection', new Error('loop'), { ...d, now: t0 });
    const b = await guards.handleProcessFailure('unhandledRejection', new Error('loop'), { ...d, now: t0 + 1000 });
    const c = await guards.handleProcessFailure('unhandledRejection', new Error('other'), { ...d, now: t0 + 2000 });
    const later = await guards.handleProcessFailure('unhandledRejection', new Error('loop'), { ...d, now: t0 + 11 * 60_000 });
    expect([a.alerted, b.alerted, c.alerted, later.alerted]).toEqual([true, false, true, true]);
    expect(d.sendAdminAlert).toHaveBeenCalledTimes(3);
    expect(d.recordFailure).toHaveBeenCalledTimes(4);
  });

  it('a failing alert sender never throws out of the guard', async () => {
    const d = deps();
    d.sendAdminAlert.mockRejectedValue(new Error('smtp down'));
    const r = await guards.handleProcessFailure('unhandledRejection', 'plain string reason', d);
    expect(r.alerted).toBe(false);
    expect(d.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ summary: 'unhandledRejection: plain string reason' }));
  });

  it('uncaughtException alerts, then exits non-zero', async () => {
    const proc: any = new EventEmitter();
    const d = deps();
    const exit = vi.fn();
    guards.installProcessGuards({ ...d, proc, exit });
    proc.emit('uncaughtException', new Error('fatal'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(d.sendAdminAlert).toHaveBeenCalledTimes(1);
    expect(d.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'process_uncaughtException' }));
  });

  it('unhandledRejection does not exit', async () => {
    const proc: any = new EventEmitter();
    const d = deps();
    const exit = vi.fn();
    guards.installProcessGuards({ ...d, proc, exit });
    proc.emit('unhandledRejection', new Error('recoverable'));
    await vi.waitFor(() => expect(d.sendAdminAlert).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();
  });

  it('server.js installs the guards before listening (source pin)', () => {
    const src = readFileSync(resolve(__dirname, '../../server.js'), 'utf8');
    const install = src.indexOf("require('./server/lib/processGuards').installProcessGuards(");
    const listen = src.indexOf('app.listen(PORT');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(listen);
  });
});

describe('sendAdminStoryFailureAlert HTML escaping', () => {
  it('escapes the error message', () => {
    expect(emailMod.escapeHtml('<script>alert("x")</script> & \'q\''))
      .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(emailMod.escapeHtml(undefined)).toBe('');
  });

  it('the alert template interpolates the escaped message (source pin)', () => {
    const src = readFileSync(resolve(__dirname, '../../email.js'), 'utf8');
    expect(src).toContain('${escapeHtml(errorMessage)}</pre>');
    expect(src).not.toContain('${errorMessage}</pre>');
  });
});
