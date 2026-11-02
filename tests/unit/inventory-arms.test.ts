/** Lab inventory_ab: params.arms runs a subset of the arms (a model comparison needs only `unified`). */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectInventoryArms } = require('../../server/lib/testlab.js');

const ALL = [{ key: 'split_p1' }, { key: 'split_stage1' }, { key: 'unified' }];

describe('selectInventoryArms', () => {
  it('runs every arm when no subset is asked for', () => {
    expect(selectInventoryArms(ALL, undefined)).toBe(ALL);
    expect(selectInventoryArms(ALL, [])).toBe(ALL);
  });
  it('runs only the named arms, in the order asked', () => {
    expect(selectInventoryArms(ALL, ['unified']).map(a => a.key)).toEqual(['unified']);
    expect(selectInventoryArms(ALL, ['unified', 'split_p1']).map(a => a.key)).toEqual(['unified', 'split_p1']);
  });
  it('throws on an unknown arm instead of silently running nothing', () => {
    expect(() => selectInventoryArms(ALL, ['unifed'])).toThrow(/Unknown inventory arm: unifed/);
  });
});
