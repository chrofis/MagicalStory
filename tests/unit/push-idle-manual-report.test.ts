import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderVerdict, resolveTargets, parseRefs, ENVIRONMENTS, isHookInvocation } =
  require('../../scripts/admin/check-push-idle.js');

const staging = ENVIRONMENTS['refs/heads/staging'];
const prod = ENVIRONMENTS['refs/heads/master'];
const text = (r: any) => r.lines.map(([, t]: [string, string]) => t).join('\n');

/**
 * Run by hand the gate printed nothing and exited 0 — which reads as "idle, all
 * clear" while the environment may be busy or unreachable. CLAUDE.md advertises
 * it as THE manual status check, so the interactive path must report.
 * The hook path is untouched: it gates every push in the repo.
 */

describe('which environments get reported', () => {
  it('hook mode: only the environments the pushed refs deploy to', () => {
    const refs = parseRefs('refs/heads/staging abc refs/heads/staging def\n');
    expect(resolveTargets(refs, { manual: false })).toEqual([staging]);
  });

  it('hook mode: a feature branch or tag deploys nothing, so nothing is gated', () => {
    const refs = parseRefs('refs/heads/feature/x abc refs/heads/feature/x def\n');
    expect(resolveTargets(refs, { manual: false })).toEqual([]);
  });

  it('hook mode: a branch deletion (all-zero local sha) deploys nothing', () => {
    const refs = parseRefs('(delete) 0000000000000000000000000000000000000000 refs/heads/staging def\n');
    expect(resolveTargets(refs, { manual: false })).toEqual([]);
  });

  it('hook mode: pushing both branches at once gates both, deduplicated', () => {
    const refs = parseRefs(
      'refs/heads/staging a refs/heads/staging b\n'
      + 'refs/heads/master c refs/heads/master d\n'
      + 'refs/heads/staging a refs/heads/staging b\n',
    );
    expect(resolveTargets(refs, { manual: false })).toEqual([staging, prod]);
  });

  it('manual mode: every known environment is reported, with no refs at all', () => {
    expect(resolveTargets([], { manual: true })).toEqual(Object.values(ENVIRONMENTS));
    expect(resolveTargets([], { manual: true }).length).toBeGreaterThan(0);
  });
});

describe('hook-mode output is unchanged', () => {
  it('idle passes and says so', () => {
    const r = renderVerdict(staging, { verdict: 'idle', reasons: [], detail: 'commit abc' });
    expect(r.blocked).toBe(false);
    expect(text(r)).toContain('staging is idle');
  });

  it('ungated warns but does not block — the fix can only ship by pushing', () => {
    const r = renderVerdict(prod, { verdict: 'ungated', reasons: [], detail: 'not deployed' });
    expect(r.blocked).toBe(false);
    expect(text(r)).toContain('NOT CHECKED');
  });

  it('busy blocks, on stderr, listing every reason', () => {
    const r = renderVerdict(staging, { verdict: 'busy', reasons: ['story job 7', 'testlab 12'], detail: 'commit abc' });
    expect(r.blocked).toBe(true);
    expect(r.lines.every(([s]: [string, string]) => s === 'error')).toBe(true);
    expect(text(r)).toContain('PUSH BLOCKED');
    expect(text(r)).toContain('story job 7');
    expect(text(r)).toContain('testlab 12');
    expect(text(r)).toContain('--no-verify');
  });

  it('unknown blocks too — unknown is not idle', () => {
    const r = renderVerdict(prod, { verdict: 'unknown', reasons: [], detail: 'HTTP 500' });
    expect(r.blocked).toBe(true);
    expect(text(r)).toContain('PUSH BLOCKED');
    expect(text(r)).toContain('HTTP 500');
  });
});

describe('manual mode reports status instead of saying nothing', () => {
  it('a busy environment is named as busy, with its reasons, and never as a blocked push', () => {
    const r = renderVerdict(staging, { verdict: 'busy', reasons: ['story job 7'] , detail: 'commit abc' }, { manual: true });
    expect(text(r)).toContain('staging');
    expect(text(r)).toContain('story job 7');
    expect(text(r)).not.toContain('PUSH BLOCKED');
    expect(text(r)).not.toContain('--no-verify');
  });

  it('an unreachable environment produces output rather than silence', () => {
    const r = renderVerdict(prod, { verdict: 'unknown', reasons: [], detail: 'could not reach https://magicalstory.ch (ETIMEDOUT)' }, { manual: true });
    expect(text(r).trim().length).toBeGreaterThan(0);
    expect(text(r)).toContain('ETIMEDOUT');
    expect(text(r)).not.toContain('PUSH BLOCKED');
  });

  it('idle still reads the same in both modes', () => {
    const hook = renderVerdict(staging, { verdict: 'idle', reasons: [], detail: 'commit abc' });
    const manual = renderVerdict(staging, { verdict: 'idle', reasons: [], detail: 'commit abc' }, { manual: true });
    expect(text(manual)).toBe(text(hook));
  });
});

describe('hook vs manual is decided by argv, not stdin', () => {
  it('git passes the remote name and URL, so a hook run has extra argv', () => {
    expect(isHookInvocation(['node', 'check-push-idle.js', 'origin', 'https://github.com/x/y.git'])).toBe(true);
  });

  it('a by-hand run passes no arguments', () => {
    expect(isHookInvocation(['node', 'check-push-idle.js'])).toBe(false);
  });

  it('REGRESSION: a non-interactive by-hand run is MANUAL, not a zero-ref hook run', () => {
    // An agent shell, a CI step and `node check-push-idle.js < /dev/null` all
    // have a non-TTY stdin. Keyed on isTTY they resolved zero targets and
    // exited 0 printing nothing; keyed on argv they report.
    expect(isHookInvocation(['node', 'check-push-idle.js'])).toBe(false);
    expect(resolveTargets([], { manual: true }).length).toBeGreaterThan(0);
  });

  it('a manual run never gates: zero refs still resolve every environment', () => {
    const manualTargets = resolveTargets([], { manual: true });
    const hookTargets = resolveTargets([], { manual: false });
    expect(hookTargets).toHaveLength(0);
    expect(manualTargets.length).toBeGreaterThan(0);
  });
});
