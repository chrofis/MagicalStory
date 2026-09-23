import { describe, it, expect } from 'vitest';
// @ts-ignore — CommonJS module
import { checkUndeclaredLettering } from '../../server/lib/letteringCheck.js';

const item = (text: string, placement: string, spelling: string, surface = 'a sign') =>
  ({ text, surface, position: 'left-midground', placement, spelling });
const severities = (lettering: any[], declared: string[] = []) =>
  checkUndeclaredLettering({ lettering, declared }).map((f: any) => f.severity);

describe('writing that belongs on its object is allowed (owner, 2026-09-23)', () => {
  it('a correctly spelled word on a taxi is not a finding', () => {
    expect(severities([item('TAXI', 'fits', 'correct', 'a taxi roof sign')])).toEqual([]);
  });

  it('the same word misspelled is CRITICAL', () => {
    const f = checkUndeclaredLettering({ lettering: [item('TAXXI', 'fits', 'misspelled', 'a taxi roof sign')], declared: [] });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('CRITICAL');
    expect(f[0].type).toBe('rendered_text');
    expect(f[0].description).toContain('TAXXI');
  });

  it('scribble on a sign is MINOR', () => {
    expect(severities([item('xkq~~', 'fits', 'scribble')])).toEqual(['MINOR']);
  });
});

describe('writing that belongs to nothing is CRITICAL', () => {
  it('a caption laid over the picture is CRITICAL even when correctly spelled', () => {
    const f = checkUndeclaredLettering({ lettering: [item('QUIET MORNING', 'overlay', 'correct', 'white label box')], declared: [] });
    expect(f.map((x: any) => x.severity)).toEqual(['CRITICAL']);
    expect(f[0].description).toContain('caption');
    expect(f[0].character).toBeNull();
    expect(f[0].source).toBe('lettering-check');
  });

  it('a name painted on an animal is CRITICAL; misplaced scribble stays MINOR', () => {
    expect(severities([item('REX', 'misplaced', 'correct', 'the dog')])).toEqual(['CRITICAL']);
    expect(severities([item('xq~k', 'misplaced', 'scribble', 'a wall')])).toEqual(['MINOR']);
  });
});

describe('declared text is always allowed', () => {
  it('an ABC page keeps its letters however the describer spaces them', () => {
    expect(severities([item('A B C', 'misplaced', 'correct', 'wooden blocks')], ['ABC'])).toEqual([]);
  });

  it('a declared word quoted inside a longer run still counts as declared', () => {
    expect(severities([item('BÄCKEREI – offen', 'overlay', 'correct')], ['Bäckerei'])).toEqual([]);
  });

  it('declaring one string does not license another', () => {
    expect(severities([item('TAXI', 'overlay', 'correct'), item('HOTEL', 'overlay', 'correct')], ['TAXI'])).toEqual(['CRITICAL']);
  });
});

describe('an unclassified item raises nothing', () => {
  it('missing placement or spelling gives no finding', () => {
    expect(severities([{ text: 'BAKERY', surface: 'sign', position: 'left', readable: true }])).toEqual([]);
    expect(severities([item('BAKERY', 'fits', 'maybe')])).toEqual([]);
  });

  it('nothing at all without lettering', () => {
    expect(checkUndeclaredLettering({ lettering: [], declared: ['ABC'] })).toEqual([]);
    expect(checkUndeclaredLettering({})).toEqual([]);
  });
});
