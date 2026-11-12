// Regression: the Visual Bible kept an invented secondary that is really a roster
// child, because filterMainCharactersFromVisualBible compared the raw name field.
// Roster names carry relationship text after a comma; the writer names the secondary
// "Noah" or "Aurelia Schwester von Aria". Prod job_1794479943880_pvykbjtwx,
// job_1794498448758_ryuv0q8lb, job_1794506785522_17d2hnvd9 (2026-11-12).
// bugs.json vb-secondary-duplicates-cast-named-with-relationship.
import { describe, it, expect } from 'vitest';
import { filterMainCharactersFromVisualBible } from '../../server/lib/visualBible.js';
import { buildCastIndex, resolveEntity } from '../../server/lib/castResolver.js';

const names = (vb: any) => vb.secondaryCharacters.map((s: any) => s.name);
const vbOf = (...n: string[]) => ({ secondaryCharacters: n.map((name, i) => ({ id: `CHR00${i + 1}`, name })) });

describe('filterMainCharactersFromVisualBible with relationship text in roster names', () => {
  it('drops a secondary named by the short name of a comma roster entry', () => {
    const roster = [
      { id: 1, name: 'Noah, Freund von Louis und Tobias, Bruder von Tilo' },
      { id: 2, name: 'Tobias, Freund von Noah' },
    ];
    const vb = vbOf('Mia', 'Noah', 'Tobias');
    filterMainCharactersFromVisualBible(vb, roster);
    expect(names(vb)).toEqual(['Mia']);
  });

  it('drops "Aurelia Schwester von Aria" (comma lost) for roster "Aurelia, Schwester von Aria", keeps Thalassa', () => {
    const roster = [
      { id: 1, name: 'Aria Freundin von Emilija und Amalia' },
      { id: 2, name: 'Aurelia, Schwester von Aria' },
    ];
    const vb = vbOf('Thalassa', 'Aurelia Schwester von Aria');
    filterMainCharactersFromVisualBible(vb, roster);
    expect(names(vb)).toEqual(['Thalassa']);
  });

  it('keeps a secondary "Louis" when the roster only mentions Louis in Noah\'s relationship text', () => {
    const vb = vbOf('Louis');
    filterMainCharactersFromVisualBible(vb, [{ id: 1, name: 'Noah, Freund von Louis' }]);
    expect(names(vb)).toEqual(['Louis']);
  });

  it('keeps a different person whose name merely contains the roster name', () => {
    const vb = vbOf("Mia's mother", 'Mia Baker');
    filterMainCharactersFromVisualBible(vb, [{ id: 1, name: 'Mia, Schwester von Tilo' }]);
    expect(names(vb)).toEqual(["Mia's mother", 'Mia Baker']);
  });

  it('still drops an exact (case-insensitive) match', () => {
    const vb = vbOf('NOAH');
    filterMainCharactersFromVisualBible(vb, [{ id: 1, name: 'Noah' }]);
    expect(names(vb)).toEqual([]);
  });
});

describe('castResolver: comma-less spelling of a roster name field', () => {
  it('resolves to the roster entry, not to the secondary spelled that way', () => {
    const idx = buildCastIndex(
      { characters: [{ id: 1, name: 'Aurelia, Schwester von Aria' }] },
      { secondaryCharacters: [{ id: 'CHR002', name: 'Aurelia Schwester von Aria' }] },
    );
    expect(resolveEntity('Aurelia Schwester von Aria', idx)?.kind).toBe('cast');
  });
});
