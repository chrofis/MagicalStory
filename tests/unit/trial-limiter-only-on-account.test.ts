/**
 * Regression (owner iPhone /try, 2026-10-09): the per-IP trialAvatarLimiter (max 2/day) fronted create-anonymous-account AND the
 * follow-up calls (update-photo, prepare-standard-body, prepare-standard-avatar). Since the body row starts at the photo, one trial
 * costs 3+ hits, so the body row and the sheet were refused with a silent 429 and never drawn. The limiter must front the account
 * creation only.
 */
import { describe, it, expect } from 'vitest';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-limiter';
const trialRouter = require('../../server/routes/trial.js');
const { trialAvatarLimiter } = require('../../server/middleware/rateLimit');

const handlersOf = (routePath: string, method: string) => {
  const layer = trialRouter.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  return layer.route.stack.map((s: any) => s.handle);
};

describe('trialAvatarLimiter placement', () => {
  it('fronts create-anonymous-account', () => {
    expect(handlersOf('/create-anonymous-account', 'post')).toContain(trialAvatarLimiter);
  });
  it.each([
    ['/update-photo', 'put'],
    ['/prepare-standard-body', 'post'],
    ['/prepare-standard-avatar', 'post'],
  ])('does not front %s', (route, method) => {
    expect(handlersOf(route, method)).not.toContain(trialAvatarLimiter);
  });
});
