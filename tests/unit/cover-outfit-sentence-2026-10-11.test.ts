/**
 * A cover brief dresses each figure like a page brief does (staging trials job_1791709770102_cnksoiyxt and job_1791700480532_ul7f67gii:
 * "[CLOTHING] page -3: the scene prose does not dress <hero> in their outfit" on every trial back cover, replayed 23/23 stored back
 * covers before the fix, 0/23 after).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withCoverOutfits } = require('../../server/lib/promptBuilders.js');
const { coverBriefWithObjects, buildCoverSceneFromHint, trialDefaultCoverHint } = require('../../server/lib/coverIterate.js');

const photos = [{ name: 'Serafin', clothingDescription: 'red striped shirt, brown vest, black boots.' }, { name: 'Mira', clothingDescription: null }];

describe('withCoverOutfits', () => {
  it('appends one "<name> wears <outfit>." sentence per figure that has an outfit, and none for one without', () => {
    expect(withCoverOutfits('A portrait.', photos)).toBe('A portrait. Serafin wears red striped shirt, brown vest, black boots.');
  });

  it('puts the sentence in the prose, before the METADATA tail of a cover brief', () => {
    const brief = coverBriefWithObjects('A portrait.', ['LOC001']);
    const out = withCoverOutfits(brief, photos);
    expect(out.indexOf('Serafin wears')).toBeLessThan(out.indexOf('---METADATA---'));
    expect(out.endsWith(brief.slice(brief.indexOf('---METADATA---')))).toBe(true);
  });

  it('leaves the writer\'s fenced JSON brief (the trial front cover) untouched', () => {
    const json = '```json\n{"scene":{"imageSummary":"x"}}\n```';
    expect(withCoverOutfits(json, photos)).toBe(json);
  });

  it('returns the brief unchanged when no figure has an outfit', () => {
    expect(withCoverOutfits('A portrait.', [{ name: 'A' }])).toBe('A portrait.');
    expect(withCoverOutfits('A portrait.', null)).toBe('A portrait.');
  });

  it('works on the trial default back-cover brief', () => {
    const hint = trialDefaultCoverHint('backCover', { characters: [{ name: 'Serafin', isMainCharacter: true }] });
    const prose = buildCoverSceneFromHint(hint, { locations: [] }, [], {});
    expect(withCoverOutfits(prose, photos)).toContain('Serafin wears red striped shirt');
  });
});
