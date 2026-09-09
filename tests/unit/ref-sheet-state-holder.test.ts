import { describe, it, expect } from 'vitest';

const { objectLookOnly, expandElementStateCells } = require('../../server/lib/referenceSheets');

/**
 * A state cell of an object's reference sheet must draw the object and nothing
 * else. A delta that says who is holding the thing made the renderer supply the
 * body that hand/paw belongs to, and the resulting chimera became ground truth
 * for every downstream check.
 */
describe('object state cells drop the holder', () => {
  const cast = ['Rösi', 'Bimo', 'Levin'];

  it('drops the clause naming a holder and keeps how the object sits', () => {
    expect(objectLookOnly("gripped in Rösi's forepaws, partly above ground", cast))
      .toBe('partly above ground');
    expect(objectLookOnly("held edge-to-edge against the gap in Bimo's left wing by Levin's hands", cast))
      .toBe('');
    // "held" alone names nobody, and how the object sits — flat, spanning an
    // opening — is exactly what the cell should show. This state rendered the
    // book's best page, so it must survive untouched.
    expect(objectLookOnly('held flat across a burrow entrance, blocking it', cast))
      .toBe('held flat across a burrow entrance, blocking it');
  });

  it('leaves a delta about the object alone untouched', () => {
    expect(objectLookOnly('resting on a surface, untouched', cast))
      .toBe('resting on a surface, untouched');
    expect(objectLookOnly('pressed flat against the plugged entrance, no hands visible on it', cast))
      .toBe('pressed flat against the plugged entrance');
  });

  it('generalises to objects from other stories', () => {
    // A lantern and a kite — nothing to do with the page that motivated this.
    expect(objectLookOnly('swinging from the keeper\'s hand, flame guttering', ['the keeper']))
      .toBe('flame guttering');
    expect(objectLookOnly('torn along one edge, string trailing', ['Mira']))
      .toBe('torn along one edge, string trailing');
  });

  it('falls back to the base look when the delta is only a holder', () => {
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
    expect(cells[1].description).toBe('a single scale, deep teal shading to ochre, lying flat on stone');
  });
});
