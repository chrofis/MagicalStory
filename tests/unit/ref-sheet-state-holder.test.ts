import { describe, it, expect } from 'vitest';

const { objectLookOnly, expandElementStateCells } = require('../../server/lib/referenceSheets');

/**
 * A state cell draws the object, and no figure holding it. The two kinds of
 * holder were measured on one story and behave differently: an animal's paw
 * made the renderer grow the animal, and the resulting chimera became ground
 * truth for every downstream check; a bare pair of human hands did not.
 */
describe('object state cells drop the figure, keep plain hands', () => {
  const cast = ['Rösi', 'Bimo', 'Levin'];

  it('drops an animal holder and keeps how the object sits', () => {
    expect(objectLookOnly("gripped in Rösi's forepaws, partly above ground", cast))
      .toBe('partly above ground');
  });

  it('keeps hands, without whose hands they are', () => {
    expect(objectLookOnly("held edge-to-edge against the gap in Bimo's left wing by Levin's hands", cast))
      .toBe('held in a pair of human hands');
    expect(objectLookOnly("swinging from the keeper's hand, flame guttering", ['the keeper']))
      .toBe('held in a pair of human hands, flame guttering');
  });

  it('drops a clause saying hands are absent, not just one saying they are there', () => {
    expect(objectLookOnly('pressed flat against the plugged entrance, no hands visible on it', cast))
      .toBe('pressed flat against the plugged entrance');
  });

  it('leaves a delta about the object alone untouched', () => {
    // "held" names nobody, and flat-across-an-opening is real shape: this state
    // rendered the best page in the book and must survive verbatim.
    expect(objectLookOnly('held flat across a burrow entrance, blocking it', cast))
      .toBe('held flat across a burrow entrance, blocking it');
    expect(objectLookOnly('resting on a surface, untouched', cast))
      .toBe('resting on a surface, untouched');
    expect(objectLookOnly('torn along one edge, string trailing', ['Mira']))
      .toBe('torn along one edge, string trailing');
  });

  it('matches whole words only', () => {
    expect(objectLookOnly('lying on the handlebars', cast)).toBe('lying on the handlebars');
    expect(objectLookOnly('wedged in a pawpaw tree', cast)).toBe('wedged in a pawpaw tree');
  });

  it('falls back to the base look when nothing but the holder is left', () => {
    const cells = expandElementStateCells({
      id: 'ART002',
      name: 'a scale',
      description: 'a single scale, deep teal shading to ochre',
      states: [
        { id: 'ART002.1', name: 'carried up', delta: "gripped in Rösi's forepaws" },
        { id: 'ART002.2', name: 'at rest', delta: 'lying flat on stone' },
      ],
    }, cast);
    expect(cells).toHaveLength(2);
    expect(cells[0].description).toBe('a single scale, deep teal shading to ochre');
    expect(cells[0].description).not.toMatch(/paw|Rösi/i);
    expect(cells[1].description).toBe('a single scale, deep teal shading to ochre, lying flat on stone');
  });
});
