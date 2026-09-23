import { describe, it, expect } from 'vitest';

// Two self-contradictions in one built page prompt, staging
// job_1790100385959_1nitlympp p12 (audit 08 S12):
//  - HEIGHT ORDER from stored centimetres put a toddler above a preschooler while
//    the AGE & PROPORTIONS block called the toddler "clearly smaller";
//  - "eyes on <the square>" for children standing in that square — a looksAt
//    naming the page's own location, sent to the illustrator and to the judges.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PB = require('../../server/lib/promptBuilders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../server/lib/vbIdGuard');

const child = (name: string, height: number, apparentAge: string) => ({ name, height: String(height), physical: { apparentAge } });

describe('HEIGHT ORDER agrees with the age block', () => {
  it('a younger age category is shorter whatever the centimetres say', () => {
    const out = PB.buildRelativeHeightDescription([
      child('A', 98, 'preschooler'), child('B', 102, 'toddler'), child('C', 104, 'preschooler'),
    ]);
    expect(out).toMatch(/B \(shortest\) -> A \(taller\) -> C/);
  });
  it('within one category the centimetres decide', () => {
    const out = PB.buildRelativeHeightDescription([child('A', 110, 'preschooler'), child('B', 100, 'preschooler')]);
    expect(out).toMatch(/B \(shortest\) -> A/);
  });
  it('adults keep the centimetre order', () => {
    const out = PB.buildRelativeHeightDescription([
      { name: 'Tall teen', height: '185', physical: { apparentAge: 'teenager' } },
      { name: 'Short adult', height: '158', physical: { apparentAge: 'adult' } },
    ]);
    expect(out).toMatch(/Short adult \(shortest\) -> Tall teen/);
  });
});

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
