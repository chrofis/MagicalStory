/**
 * HEIGHT DECIDES (owner, 2026-09-23): "if we have height then height decides;
 * if no height we estimate it based on age and gender."
 *
 * Fixture: the cast of staging job_1790100385959_1nitlympp — entered heights,
 * and Julian's photo read as a toddler while his age and height say otherwise.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');

const CAST = [
  { name: 'Levin', age: '5', gender: 'male', height: '110', physical: { apparentAge: 'preschooler' } },
  { name: 'Julian', age: '3', gender: 'male', height: '102', physical: { apparentAge: 'toddler' } },
  { name: 'Max', age: '3', gender: 'male', height: '98', physical: { apparentAge: 'preschooler' } },
  { name: 'Kiaan', age: '3', gender: 'male', height: '102', physical: { apparentAge: 'preschooler' } },
];
const BUCKETS = ['infant', 'toddler', 'preschooler', 'kindergartner', 'young-school-age', 'school-age', 'preteen',
  'young-teen', 'teenager', 'young-adult', 'adult', 'middle-aged', 'senior', 'elderly'];

describe('height decides the order', () => {
  it('the entered centimetres order the cast, whatever the photo bucket', () => {
    const line = PB.buildRelativeHeightDescription(CAST);
    expect(line.indexOf('Max (shortest)')).toBeGreaterThan(-1);
    expect(line.indexOf('Julian')).toBeLessThan(line.indexOf('Levin'));
    expect(line.indexOf('Max')).toBeLessThan(line.indexOf('Julian'));
  });

  it('no height: age and gender estimate it; the photo bucket never does', () => {
    expect(PB.estimateHeightFromAgeGender({ age: '4', gender: 'male' })).toBeGreaterThan(0);
    expect(PB.estimateHeightFromAgeGender({ gender: 'male', physical: { apparentAge: 'teenager' } })).toBeNull();
    expect(PB.estimateHeightFromAgeGender({ gender: 'male', apparentAge: 'teenager' })).toBeNull();
  });
});

describe('no age marker states a size against another bucket', () => {
  it.each(BUCKETS)('%s', (bucket) => {
    const m = PB.getAgeMarkers(bucket);
    expect(m.length).toBeGreaterThan(20);
    expect(m).toMatch(/heads tall/);
    expect(m).not.toMatch(/(smaller|taller|shorter|bigger|larger) than/i);
  });
});
