/**
 * A paid story/trial run asks the owner first (owner, 2026-10-09: retest on stored
 * stories; a new run only after 20 green stage tests). Hooks run for subagents too.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { paidRunKind, decision } = require('../../scripts/admin/paid-run-guard-hook.js');

describe('paid-run guard hook', () => {
  it('catches every way a story or trial is started', () => {
    expect(paidRunKind('node scripts/admin/trial-showcase.js --entry=0 --idea=grounded')).toMatch(/trial/);
    expect(paidRunKind('node scripts/admin/rerun-story-on-staging.js job_1 --source=staging --pages=4 --yes')).toMatch(/rerun/);
    expect(paidRunKind('node scripts/test-scene-composite-smoke.js --pages=4 --skipEval=true')).toMatch(/smoke/);
    expect(paidRunKind('npm run showcase')).toMatch(/showcase/);
    expect(paidRunKind('curl -s -X POST https://staging.magicalstory.ch/api/trial/create-story -d {}')).toMatch(/create-story/);
  });
  it('lets dry runs, replays, Lab stages and DB reads through', () => {
    expect(paidRunKind('node scripts/admin/trial-showcase.js --entry=7 --dry-run')).toBeNull();
    expect(paidRunKind('node scripts/admin/rerun-story-on-staging.js job_1 --source=staging')).toBeNull();
    expect(paidRunKind('node scripts/test-scene-composite-smoke.js --pages=4 --dryRun')).toBeNull();
    expect(paidRunKind('node scripts/analysis/gaze-full-replay.js --days=21')).toBeNull();
    expect(paidRunKind('curl -s -X POST https://staging.magicalstory.ch/api/admin/testlab/experiments')).toBeNull();
    expect(paidRunKind('git push origin staging')).toBeNull();
  });
  it('asks, never silently blocks, and states the rule', () => {
    const d = decision('trial run');
    expect(d.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/20 successful stage tests/);
  });
});
