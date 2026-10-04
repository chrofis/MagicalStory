/** P9 (code review 2026-10-04): a second account of the same inbox is a self-referral. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeEmailForSelfReferral: n } = require('../../server/lib/referral.js');

describe('normalizeEmailForSelfReferral', () => {
  it('collapses case, +tag and gmail dots to one canonical inbox', () => {
    expect(n('Roger.Fischer+shop@Gmail.com')).toBe('rogerfischer@gmail.com');
    expect(n('rogerfischer@googlemail.com')).toBe('rogerfischer@gmail.com');
  });
  it('keeps dots for other domains but still strips +tag', () => {
    expect(n('a.b+x@corp.ch')).toBe('a.b@corp.ch');
    expect(n('ab@corp.ch')).not.toBe(n('a.b@corp.ch'));
  });
  it('returns empty for a non-email so two missing emails never match', () => {
    expect(n(null)).toBe('');
    expect(n('nonsense')).toBe('');
  });
});
