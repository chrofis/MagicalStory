import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import {
  runInCacheScope,
  setStyledAvatar,
  hasStyledAvatar,
  clearStyledAvatarCache,
  retainCacheScopeForHandoff,
} from '../../server/lib/styledAvatars.js';

// A trial shares ONE cache scope between the wizard's prepare-title prewarm
// and the story job (`trial-<userId>`). On staging job_1788682208484 the
// prewarm finished 35 s after the job had started, its end-of-handler clear
// wiped the costumed sheet the job was about to use, and every page rendered
// the standard hoodie. The guard: a scope is only cleared by its LAST active
// runner.
describe('styled avatar cache: shared-scope clear guard', () => {
  it('a runner leaving a scope does not clear it while another runner is still inside', async () => {
    const scope = 'trial-guard-test';
    let releaseJob: () => void = () => {};
    const jobGate = new Promise<void>(resolve => { releaseJob = resolve; });

    // "Story job": enters the scope first and stays until released.
    const job = runInCacheScope(scope, async () => {
      await jobGate;
      return hasStyledAvatar('noah', 'costumed', 'watercolor');
    });

    // "Prewarm": enters the same scope, writes the costumed sheet, then clears
    // on its way out — exactly what prepare-title does.
    await runInCacheScope(scope, async () => {
      setStyledAvatar('noah', 'costumed:pirate', 'watercolor', 'data:image/jpeg;base64,sheet');
      clearStyledAvatarCache();
      expect(hasStyledAvatar('noah', 'costumed', 'watercolor')).toBe(true);
    });

    releaseJob();
    expect(await job).toBe(true);
  });

  it('the last runner out of a scope clears it', async () => {
    const scope = 'trial-guard-test-2';
    await runInCacheScope(scope, async () => {
      setStyledAvatar('noah', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet');
      clearStyledAvatarCache();
      expect(hasStyledAvatar('noah', 'standard', 'watercolor')).toBe(false);
    });
  });
});

// The refcount guard above only covers an OVERLAP. The NORMAL trial ordering has
// none: the prewarm finishes and clears (it is the only runner in the scope), and
// the story job enters `trial-<userId>` a fraction of a second later to find it
// empty — so it pays for a second identical Grok 2×4 sheet + style transfer.
// Prod job_1788698812047_q5b1vuds7 recorded exactly that: two
// Amian/watercolor/standard records with byte-identical 4097-char prompts,
// 77 s and 58 s, starting 220 ms apart.
describe('styled avatar cache: prewarm → story job handoff', () => {
  it('a retained scope survives the prewarm and is claimed by the job (one generation)', async () => {
    const scope = 'trial-handoff-test';
    let generations = 0;

    // "Prewarm": generates the sheet, then exits the scope.
    await runInCacheScope(scope, async () => {
      generations++;
      setStyledAvatar('amian', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet');
      retainCacheScopeForHandoff(scope);
      clearStyledAvatarCache();
    });

    // Nobody is inside the scope now — this is where the old code had already
    // wiped the entry.
    // "Story job": enters afterwards and must find the sheet.
    const hit = await runInCacheScope(scope, async () => {
      if (!hasStyledAvatar('amian', 'standard', 'watercolor')) {
        generations++; // would be the duplicate Grok call
        setStyledAvatar('amian', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet2');
      }
      const found = hasStyledAvatar('amian', 'standard', 'watercolor');
      clearStyledAvatarCache();
      return found;
    });

    expect(hit).toBe(true);
    expect(generations).toBe(1);
  });

  it('the consumer frees the scope on its way out', async () => {
    const scope = 'trial-handoff-test-2';
    await runInCacheScope(scope, async () => {
      setStyledAvatar('amian', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet');
      retainCacheScopeForHandoff(scope);
      clearStyledAvatarCache();
    });
    await runInCacheScope(scope, async () => {
      expect(hasStyledAvatar('amian', 'standard', 'watercolor')).toBe(true);
      clearStyledAvatarCache();
      expect(hasStyledAvatar('amian', 'standard', 'watercolor')).toBe(false);
    });
    // And it stays freed for anyone entering later.
    await runInCacheScope(scope, async () => {
      expect(hasStyledAvatar('amian', 'standard', 'watercolor')).toBe(false);
    });
  });

  it('an abandoned trial (no job ever arrives) frees the entries after the TTL', async () => {
    const scope = 'trial-handoff-test-3';
    await runInCacheScope(scope, async () => {
      setStyledAvatar('amian', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet');
      retainCacheScopeForHandoff(scope, 20); // 20 ms stand-in for the 3 min TTL
      clearStyledAvatarCache();
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    await runInCacheScope(scope, async () => {
      expect(hasStyledAvatar('amian', 'standard', 'watercolor')).toBe(false);
    });
  });

  it('does not retain while another runner is still inside the scope', async () => {
    const scope = 'trial-handoff-test-4';
    let releaseJob: () => void = () => {};
    const jobGate = new Promise<void>(resolve => { releaseJob = resolve; });

    const job = runInCacheScope(scope, async () => {
      await jobGate;
      const found = hasStyledAvatar('amian', 'standard', 'watercolor');
      clearStyledAvatarCache(); // last runner out → really clears
      return found;
    });

    await runInCacheScope(scope, async () => {
      setStyledAvatar('amian', 'standard', 'watercolor', 'data:image/jpeg;base64,sheet');
      retainCacheScopeForHandoff(scope); // no-op: the job is already inside
      clearStyledAvatarCache();          // no-op: refcount guard
    });

    releaseJob();
    expect(await job).toBe(true);
    // The job's clear was the last one out, so nothing is parked behind a TTL.
    await runInCacheScope(scope, async () => {
      expect(hasStyledAvatar('amian', 'standard', 'watercolor')).toBe(false);
    });
  });
});
