import { describe, it, expect } from 'vitest';

// A self-contradiction in one built page prompt, staging
// job_1790100385959_1nitlympp p12 (audit 08 S12): "eyes on <the square>" for
// children standing in that square — a looksAt naming the page's own location,
// sent to the illustrator and to the judges.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../server/lib/vbIdGuard');

describe('a gaze at the page\'s own place is no gaze', () => {
  it('drops a LOC the page cites, keeps anything else', () => {
    expect(guard.gazeTarget('LOC002.4', ['LOC002.4', 'ART001'])).toBe('');
    expect(guard.gazeTarget('LOC002', ['LOC002.4'])).toBe('');
    expect(guard.gazeTarget('LOC003', ['LOC002.4'])).toBe('LOC003');
    expect(guard.gazeTarget('ART001', ['ART001'])).toBe('ART001');
    expect(guard.gazeTarget('CharB', ['LOC002.4'])).toBe('CharB');
    expect(guard.gazeTarget('away', [])).toBe('away');
  });
  it('the judges read the same gaze the illustrator gets', () => {
    const meta = {
      objects: ['LOC002.4'],
      fullData: { characters: [{ name: 'A', looksAt: 'LOC002.4' }, { name: 'B', looksAt: 'A' }] },
    };
    const block = guard.formatInteractionsBlock([], null, guard.gazeCharacters(meta));
    expect(block).not.toMatch(/A looks at/);
    expect(block).toMatch(/B looks at A/);
  });
});
