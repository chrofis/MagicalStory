import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { checkUndeclaredLettering } from '../../server/lib/letteringCheck.js';
import FIXTURE from './fixtures/lettering-job_1790100385959_1nitlympp.json';

/**
 * Real blind-inventory output (Lab 1405) for two pages of dragon run 6.
 * p6 carries a full caption that scored 100 with zero findings; p1 carries
 * street signage nobody asked for in a Zurich scene, including a British banner.
 */
const PAGES: any = FIXTURE.pages;

describe('writing nobody asked for becomes a finding', () => {
  it('p6: the leaked mood caption is CRITICAL', () => {
    const f = checkUndeclaredLettering({ lettering: PAGES['6'].lettering, declared: [] });
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe('rendered_text');
    expect(f[0].severity).toBe('CRITICAL');
    expect(f[0].source).toBe('lettering-check');
    expect(f[0].description).toContain('TENSE BUT QUIET STANDOFF');
    expect(f[0].character).toBeNull();
  });

  it('p1: every readable undeclared sign is reported', () => {
    const f = checkUndeclaredLettering({ lettering: PAGES['1'].lettering, declared: [] });
    expect(f.map((x: any) => x.severity)).toEqual(['CRITICAL', 'CRITICAL', 'CRITICAL']);
    expect(f.map((x: any) => x.description).join(' ')).toMatch(/TAXI[\s\S]*BUTTERCUP[\s\S]*BRITISH/);
  });
});

describe('declared text is allowed — text is no longer forbidden outright', () => {
  it('a string the page declares is silent', () => {
    const f = checkUndeclaredLettering({ lettering: PAGES['6'].lettering, declared: ['Tense but quiet standoff'] });
    expect(f).toEqual([]);
  });

  it('an ABC page keeps its letters however the describer spaces them', () => {
    const lettering = [{ text: 'A B C', surface: 'wooden blocks', position: 'center-foreground', readable: true }];
    expect(checkUndeclaredLettering({ lettering, declared: ['ABC'] })).toEqual([]);
  });

  it('a declared word quoted inside a longer run still counts as declared', () => {
    const lettering = [{ text: 'BÄCKEREI – offen', surface: 'shop sign', position: 'left', readable: true }];
    expect(checkUndeclaredLettering({ lettering, declared: ['Bäckerei'] })).toEqual([]);
  });

  it('declaring one string does not license another', () => {
    const f = checkUndeclaredLettering({ lettering: PAGES['1'].lettering, declared: ['TAXI'] });
    expect(f.map((x: any) => x.description).join(' ')).not.toContain('"TAXI"');
    expect(f).toHaveLength(2);
  });
});

describe('severity follows the evaluator\'s own D-23 classes', () => {
  it('unreadable scribble is MINOR', () => {
    const lettering = [{ text: 'xkq~~', surface: 'poster', position: 'background', readable: false }];
    const f = checkUndeclaredLettering({ lettering, declared: [] });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('MINOR');
  });

  it('nothing at all without lettering', () => {
    expect(checkUndeclaredLettering({ lettering: [], declared: ['ABC'] })).toEqual([]);
    expect(checkUndeclaredLettering({})).toEqual([]);
  });
});
