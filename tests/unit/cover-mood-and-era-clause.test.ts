import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED 2026-09-21.
//
// (A11) The cover hint's `mood` is authored in ENGLISH on every story — the
// Art Director's all-pages prompt ends "All output in English. Prose and all
// metadata fields must be in English.", and a stored de-ch story's hint holds
// "joyful autumn discovery". The old English-only gate therefore threw the
// writer's mood away for every non-English book and kept it for none of the
// stories it was written for.
//
// (A12) The landmark fidelity block's EXCLUDE clause points at "the STORY ERA
// rule". That rule only exists in the prompt when buildEraGuard emitted one.
// On a present-day story the guard returns '' and the clause dangles.

function cover() {
  return require_('../../server/lib/coverIterate.js');
}
function builders() {
  return require_('../../server/lib/promptBuilders.js');
}

const HINT = {
  mood: 'joyful autumn discovery',
  objects: ['LOC001'],
  characterDetails: {
    Levin: { name: 'Levin', position: 'center foreground', holds: 'nothing', priority: 'high' },
  },
};
const VB = { locations: [{ id: 'LOC001', name: 'Town Square', isRealLandmark: true, features: 'paved plaza', colors: 'grey stone' }] };
const CHARS = [{ name: 'Levin', age: 6, gender: 'male' }];

describe('cover mood reaches the prompt whatever the story language', () => {
  it('a German story keeps the English-authored mood', () => {
    const scene = cover().buildCoverSceneFromHint(HINT, VB, CHARS, { language: 'de-ch' });
    expect(scene).toContain('Joyful autumn discovery.');
  });

  it('an English story is unchanged', () => {
    const scene = cover().buildCoverSceneFromHint(HINT, VB, CHARS, { language: 'en' });
    expect(scene).toContain('Joyful autumn discovery.');
  });

  it('every language produces the same mood sentence', () => {
    const langs = ['en', 'de-ch', 'fr', 'it', 'es'];
    const firsts = langs.map(l => cover().buildCoverSceneFromHint(HINT, VB, CHARS, { language: l }).split('. ')[0]);
    expect(new Set(firsts).size).toBe(1);
  });

  it('a hint with no mood emits no mood sentence', () => {
    const scene = cover().buildCoverSceneFromHint({ ...HINT, mood: '' }, VB, CHARS, { language: 'de-ch' });
    expect(scene.startsWith('A portrait')).toBe(true);
  });
});

describe('the EXCLUDE clause never cites an era rule the prompt does not state', () => {
  const LM = { name: 'Lindenhof' };

  it('a historical era keeps the clause', () => {
    const block = builders().buildLandmarkFidelityBlock(LM, { era: 'medieval Switzerland, ~1300' });
    expect(builders().buildEraGuard('medieval Switzerland, ~1300')).not.toBe('');
    expect(block).toContain('STORY ERA rule');
  });

  it('a present-day era drops the clause', () => {
    expect(builders().buildEraGuard('present day')).toBe('');
    const block = builders().buildLandmarkFidelityBlock(LM, { era: 'present day' });
    expect(block).not.toContain('STORY ERA rule');
    expect(block).not.toContain('modern surroundings');
    expect(block).toContain('**EXCLUDE:** Separate props sit in open space');
  });

  it('no era at all drops the clause', () => {
    const block = builders().buildLandmarkFidelityBlock(LM);
    expect(block).not.toContain('STORY ERA rule');
  });

  it('the wide-view branch follows the same rule', () => {
    const wide = { name: 'Lindenhof', photoType: 'view-from' };
    expect(builders().buildLandmarkFidelityBlock(wide, { era: 'present day' })).not.toContain('STORY ERA rule');
    expect(builders().buildLandmarkFidelityBlock(wide, { era: '1920s New York' })).toContain('STORY ERA rule');
  });

  it('the era guard itself carries the photo exclusion, so the rule and its consequence never separate', () => {
    expect(builders().buildEraGuard('1920s New York')).toMatch(/reference photo is present-day/i);
  });
});
