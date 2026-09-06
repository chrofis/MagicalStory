import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import {
  runInCacheScope,
  setStyledAvatar,
  hasStyledAvatar,
  clearStyledAvatarCache,
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
