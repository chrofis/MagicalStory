import { describe, it, expect } from 'vitest';

const { looksAtPhrase } = require('../../server/lib/promptBuilders');
const { formatInteractionsBlock } = require('../../server/lib/vbIdGuard');

/**
 * `looksAt` is the one field that means gaze. Hands live in interactions[];
 * nothing infers where a character looks from what they hold.
 */
describe('looksAt', () => {
  // An artifact id renders from its DESCRIPTION (a name is story-language); a
  // person from their name. The scrubber's contract, mirrored here.
  const vb = { artifacts: [{ id: 'ART001', name: 'Treasure Chart', description: 'a hand-drawn navigational chart on ivory parchment' }], secondaryCharacters: [{ id: 'CHR001', name: 'Malva Grimm' }] };

  it('phrases a person, an object id, the camera and away', () => {
    expect(looksAtPhrase('Malva Grimm', vb)).toBe('eyes on Malva Grimm');
    expect(looksAtPhrase('ART001', vb)).toMatch(/^eyes on .*chart/);
    expect(looksAtPhrase('ART001', vb)).not.toMatch(/ART001/);
    expect(looksAtPhrase('camera', vb)).toBe('eyes on the viewer');
    expect(looksAtPhrase('away', vb)).toBe('eyes turned away from everyone in the frame');
    expect(looksAtPhrase('', vb)).toBe('');
  });

  it('never lets a raw bible id through to an image model', () => {
    expect(looksAtPhrase('CHR001', vb)).not.toMatch(/CHR001/);
    expect(looksAtPhrase('CHR001', vb)).toBe('eyes on Malva Grimm');
  });

  it('the judges see a declared gaze beside the hands', () => {
    const block = formatInteractionsBlock(
      [{ character: 'Fiona', object: 'ART001', where: 'presses the map flat against her coat' }],
      vb,
      [{ name: 'Fiona', looksAt: 'CHR001' }, { name: 'Malva Grimm', looksAt: 'ART001' }],
    );
    expect(block).toMatch(/- Fiona \+ .*chart.*: presses the map flat against her coat/);
    expect(block).toContain('- Fiona looks at Malva Grimm');
    expect(block).toMatch(/- Malva Grimm looks at .*chart/);
    expect(block).not.toMatch(/ART001|CHR001/);
  });

  it('a page with gazes but no contacts is still a declared block', () => {
    expect(formatInteractionsBlock([], vb, [{ name: 'Fiona', looksAt: 'camera' }])).toBe('- Fiona looks at camera');
    expect(formatInteractionsBlock([], vb, null)).toBe('(none declared)');
  });
});
