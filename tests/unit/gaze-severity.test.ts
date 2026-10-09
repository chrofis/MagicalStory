import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { gazeSeverity, checkDeclaredGaze } from '../../server/lib/gazeCheck.js';
import FIXTURE from './fixtures/gaze-declared-vs-observed-job_1789853503332_riqncqg1i.json';

/**
 * The declared-gaze finding's severity follows how much the look matters to the page
 * (owner, 2026-10-09; decisions.md "Gaze severity follows the page's story"). The grade reads the
 * brief's STRUCTURED interaction rows only: CRITICAL = the look is the beat, MAJOR = part of a declared
 * interaction between the figure and the target, MINOR = the eyes only rest there.
 */
const NAMES: Record<string, string> = { ART001: 'large egg', ANI001: 'Zippi', CHR001: 'Mama' };
const resolveTarget = (id: string) => NAMES[id] ?? null;
const sev = (looksAt: string, interactions: any[], name = 'Kiaan') =>
  gazeSeverity({ name, looksAt, interactions, resolveTarget });

describe('gazeSeverity', () => {
  it('CRITICAL: a storyRelevant `watching` row pairs the figure with the target', () => {
    expect(sev('ART001', [{ character: 'Kiaan + Max', object: 'ART001', action: 'watching', storyRelevant: true }])).toBe('CRITICAL');
  });

  it('MAJOR: a watching row that is not the beat is still a declared interaction', () => {
    expect(sev('ART001', [{ character: 'Kiaan', object: 'ART001', action: 'watching', storyRelevant: false }])).toBe('MAJOR');
    expect(sev('ART001', [{ character: 'Kiaan', object: 'ART001', action: 'watching' }])).toBe('MAJOR');
  });

  it('MAJOR: a storyRelevant row whose act is not looking is a declared interaction, not the look itself', () => {
    expect(sev('ART001', [{ character: 'Kiaan', object: 'ART001', action: 'digging', storyRelevant: true, priority: 'essential' }])).toBe('MAJOR');
  });

  it('MINOR: no row pairs the figure with the target', () => {
    expect(sev('ART001', [])).toBe('MINOR');
    expect(sev('ART001', undefined as any)).toBe('MINOR');
    expect(sev('ART001', [{ character: 'Kiaan', object: 'LOC002', action: 'watching', storyRelevant: true }])).toBe('MINOR');
    expect(sev('ART001', [{ character: 'Max', object: 'ART001', action: 'watching', storyRelevant: true }])).toBe('MINOR');
  });

  it('co-actors of one row are not an interaction between each other', () => {
    expect(sev('Max', [{ character: 'Kiaan + Max', object: 'ART001', action: 'watching', storyRelevant: true }])).toBe('MINOR');
  });

  it('pairs through ids and names, in either direction', () => {
    // actor written as an id, gaze target written as the name the bible resolves it to
    expect(sev('Zippi', [{ character: 'Kiaan', object: 'ANI001', action: 'watching', storyRelevant: true }])).toBe('CRITICAL');
    // the figure is the row's OBJECT and the target is its actor
    expect(sev('Mama', [{ character: 'CHR001', object: 'Kiaan', action: 'speaking' }])).toBe('MAJOR');
    // a dotted state handle of the same element
    expect(sev('ART001.2', [{ character: 'Kiaan', object: 'ART001', action: 'watching', storyRelevant: true }])).toBe('CRITICAL');
  });

  it('the strongest row wins', () => {
    expect(sev('ART001', [
      { character: 'Kiaan', object: 'ART001', action: 'holding' },
      { character: 'Kiaan', object: 'ART001', action: 'watching', storyRelevant: true },
    ])).toBe('CRITICAL');
  });
});

describe('checkDeclaredGaze applies the grade to the finding', () => {
  const P6 = (FIXTURE as any).pages['6'];
  const run = (interactions: any[]) => checkDeclaredGaze({
    declared: P6.declared, inventory: P6.inventory, matches: P6.matches, resolveTarget: (id: string) => NAMES[id] ?? id, interactions,
  });

  it('an incidental look is MINOR', () => {
    const f = run([]);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('MINOR');
  });

  it('the beat of the page is CRITICAL', () => {
    const f = run([{ character: 'Kiaan', object: 'ART001', action: 'watching', storyRelevant: true }]);
    expect(f[0].severity).toBe('CRITICAL');
  });

  it('a declared interaction is MAJOR', () => {
    const f = run([{ character: 'Kiaan', object: 'ART001', action: 'examining' }]);
    expect(f[0].severity).toBe('MAJOR');
  });
});
