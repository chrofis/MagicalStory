import { describe, it, expect } from 'vitest';

// ONE resolver, keyed by ENTRY. These tests pin the ladder (VB id → exact
// canonical name → unique whole-word subset) and the two failure modes it is
// allowed to have (unresolved, ambiguous) — never a first-match guess.
// Evidence: job_1789163494908_kc2joi4ax p9 (one person on the roster twice)
// and job_1787514666616_yw9qsv1vf p15 ("Sarah" landing on Rossa).

// @ts-expect-error - JS module without types
import {
  canonicalName,
  buildCastIndex,
  resolveEntity,
  sameEntity,
  dedupeByEntity,
  displayName,
  isNonHuman,
  kindLabel,
  lookupByName,
  flushResolverStats,
} from '../../server/lib/castResolver.js';

const STORY = {
  characters: [
    { id: 1789163494908, name: 'Julian' },
    { id: 1789163494909, name: 'Max' },
    { id: 1789163494910, name: 'Kiaan' },
    { id: 1789163494911, name: 'Sarah' },
  ],
};
const VB = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'Mother', description: 'a woman in her thirties' },
    { id: 'CHR002', name: 'Marroni Vendor', description: 'a chestnut seller' },
    { id: 'CHR003', name: 'Kapitänin Rossa', description: 'a captain in a blue tricorn' },
  ],
  animals: [
    { id: 'ANI001', name: 'Grey Tomcat', species: 'cat' },
    { id: 'ANI002', name: 'Mother Dragon', species: 'dragon' },
  ],
};
const idx = () => buildCastIndex(STORY, VB);

describe('canonicalName', () => {
  it('folds diacritics so one spelling reaches both pools', () => {
    expect(canonicalName('Kapitänin')).toBe(canonicalName('Kapitanin'));
    expect(canonicalName('Fünkli')).toBe('funkli');
  });

  it('strips a trailing parenthetical', () => {
    expect(canonicalName('Marroni Vendor (background)')).toBe('marroni vendor');
  });

  it('collapses whitespace and case', () => {
    expect(canonicalName('  Mother   Dragon ')).toBe('mother dragon');
  });

  it('returns empty for nothing', () => {
    expect(canonicalName(null)).toBe('');
    expect(canonicalName(undefined)).toBe('');
  });
});

describe('buildCastIndex', () => {
  it('indexes all three pools in pool order and skips unnamed entries', () => {
    const i = buildCastIndex({ characters: [{ id: 1, name: 'A' }, { id: 2 }] }, VB);
    expect(i.entries.map((e: any) => e.kind)).toEqual([
      'cast', 'secondary', 'secondary', 'secondary', 'animal', 'animal',
    ]);
  });

  it('tolerates null inputs and malformed pools', () => {
    expect(buildCastIndex(null, null).entries).toEqual([]);
    expect(buildCastIndex({ characters: 'nope' } as any, { animals: {} } as any).entries).toEqual([]);
  });
});

describe('resolveEntity — the ladder', () => {
  it('(1) resolves a bare VB id literal', () => {
    expect(resolveEntity('CHR002', idx()).name).toBe('Marroni Vendor');
    expect(resolveEntity('ani002', idx()).name).toBe('Mother Dragon');
  });

  it('(1) a dotted handle is a facet of its parent entry', () => {
    expect(resolveEntity('CHR001.2', idx()).id).toBe('CHR001');
  });

  it('(2) exact canonical name beats the subset rule', () => {
    expect(resolveEntity('kapitanin rossa', idx()).name).toBe('Kapitänin Rossa');
  });

  it('(2) a cast member outranks a secondary of the same canonical name', () => {
    const i = buildCastIndex(
      { characters: [{ id: 17, name: 'Mother' }] },
      { secondaryCharacters: [{ id: 'CHR001', name: 'Mother' }] },
    );
    const hit = resolveEntity('Mother', i);
    expect(hit.kind).toBe('cast');
    expect(hit.id).toBe('17');
  });

  it('(3) a dropped title resolves — and never onto a cast member', () => {
    const hit = resolveEntity('Rossa', idx());
    expect(hit.name).toBe('Kapitänin Rossa');
    expect(hit.name).not.toBe('Sarah');
  });

  it('(3) an added title resolves in the other direction', () => {
    expect(resolveEntity('kleiner Max', idx()).name).toBe('Max');
  });

  it('nested distinct entries stay distinct', () => {
    // "Mother" (CHR001) and "Mother Dragon" (ANI002) coexist on the real
    // story; the old whole-word-subset-with-first-match rule merged them.
    expect(resolveEntity('Mother', idx()).id).toBe('CHR001');
    expect(resolveEntity('Mother Dragon', idx()).id).toBe('ANI002');
    // "Dragon" has exactly ONE superset here, so the rule resolves it. It
    // would refuse only with a second dragon-named entry present.
    expect(resolveEntity('Dragon', idx()).id).toBe('ANI002');
    const two = buildCastIndex(STORY, {
      ...VB,
      animals: [...VB.animals, { id: 'ANI003', name: 'Baby Dragon', species: 'dragon' }],
    });
    expect(resolveEntity('Dragon', two)).toBeNull();
  });

  it('an unknown token resolves to nothing and is counted', () => {
    const i = idx();
    expect(resolveEntity('Gandalf', i)).toBeNull();
    expect(i.stats.unresolved).toEqual(['Gandalf']);
    expect(i.stats.refs).toBe(1);
  });

  it('an ambiguous token is refused, never guessed, and lists its candidates', () => {
    const i = buildCastIndex(
      { characters: [{ id: 1, name: 'Grossvater Felix' }] },
      { secondaryCharacters: [{ id: 'CHR001', name: 'Onkel Felix' }] },
    );
    expect(resolveEntity('Felix', i)).toBeNull();
    expect(i.stats.ambiguous).toEqual([
      { ref: 'Felix', candidates: ['Grossvater Felix', 'Onkel Felix'] },
    ]);
  });

  it('an empty ref is not a failed lookup', () => {
    const i = idx();
    expect(resolveEntity('   ', i)).toBeNull();
    expect(i.stats.refs).toBe(0);
    expect(i.stats.unresolved).toEqual([]);
  });

  it('warns through the caller log in the pinned shape', () => {
    const lines: string[] = [];
    const log = { warn: (s: string) => lines.push(s), info: (s: string) => lines.push(s) };
    const i = idx();
    resolveEntity('Gandalf', i, { log, pageLabel: 'p9 ' });
    expect(lines[0]).toBe('⚠️ [CAST-RESOLVE] p9 "Gandalf" unresolved');
  });

  it('never throws on a junk index', () => {
    expect(resolveEntity('x', null as any)).toBeNull();
  });
});

describe('sameEntity / dedupeByEntity', () => {
  it('two spellings of one person are the same entity', () => {
    expect(sameEntity('Vendor', 'Marroni Vendor', idx())).toBe(true);
    expect(sameEntity('Mother', 'Mother Dragon', idx())).toBe(false);
  });

  it('falls back to canonical equality when neither side resolves', () => {
    expect(sameEntity('Gandalf', 'gandalf', idx())).toBe(true);
    expect(sameEntity('Gandalf', 'Saruman', idx())).toBe(false);
  });

  it('collapses the p9 roster from five names to four', () => {
    const roster = ['Julian', 'Max', 'Kiaan', 'Vendor', 'Marroni Vendor'];
    expect(dedupeByEntity(roster, idx())).toEqual(['Julian', 'Max', 'Kiaan', 'Vendor']);
  });

  it('keeps unresolvable names, deduped canonically, in order', () => {
    expect(dedupeByEntity(['Ghost', 'ghost ', 'Julian', ''], idx()))
      .toEqual(['Ghost', 'Julian']);
  });
});

describe('presentation helpers', () => {
  it('displayName is the name, never an id', () => {
    expect(displayName(resolveEntity('CHR002', idx()))).toBe('Marroni Vendor');
    expect(displayName(null)).toBe('');
  });

  it('isNonHuman is true only for animals', () => {
    expect(isNonHuman(resolveEntity('ANI001', idx()))).toBe(true);
    expect(isNonHuman(resolveEntity('CHR001', idx()))).toBe(false);
    expect(isNonHuman(resolveEntity('Julian', idx()))).toBe(false);
  });

  it('kindLabel names the pool, with the species when known', () => {
    expect(kindLabel(resolveEntity('ANI001', idx()))).toBe('animal, cat');
    expect(kindLabel(resolveEntity('CHR001', idx()))).toBe('secondary character');
    expect(kindLabel(resolveEntity('Julian', idx()))).toBeNull();
    expect(kindLabel({ kind: 'animal', entry: {} } as any)).toBe('animal');
  });
});

describe('lookupByName', () => {
  const reqs = { 'Kapitänin Rossa': { top: 'blue coat' }, Julian: { top: 'red jumper' } };

  it('finds an exact key', () => {
    expect(lookupByName(reqs, 'Julian', idx()).value.top).toBe('red jumper');
  });

  it('finds a key whose spelling only matches canonically', () => {
    expect(lookupByName(reqs, 'kapitanin rossa', idx()).key).toBe('Kapitänin Rossa');
  });

  it('finds a key by the short form the prose uses', () => {
    expect(lookupByName(reqs, 'Rossa', idx()).value.top).toBe('blue coat');
  });

  it('returns null for a key nothing matches, and for a null map', () => {
    expect(lookupByName(reqs, 'Gandalf', idx())).toBeNull();
    expect(lookupByName(null, 'Julian', idx())).toBeNull();
  });
});

describe('flushResolverStats', () => {
  it('says nothing when nothing was resolved', () => {
    const lines: string[] = [];
    flushResolverStats(idx(), { info: (s: string) => lines.push(s) }, 'p1 ');
    expect(lines).toEqual([]);
  });

  it('emits one line with both failure lists', () => {
    const lines: string[] = [];
    const i = idx();
    resolveEntity('Julian', i);
    resolveEntity('Gandalf', i);
    flushResolverStats(i, { info: (s: string) => lines.push(s) }, 'p9 ');
    expect(lines).toEqual(['[CAST-RESOLVE] p9 2 refs, 1 unresolved (Gandalf), 0 ambiguous ()']);
  });
});

describe('byte-identity with the rules being replaced', () => {
  // The name fixtures of tests/unit/one-roster.test.ts and
  // tests/unit/extra-character-type.test.ts: every name those suites resolve
  // today must resolve to the same entry here, or this module is not a
  // drop-in for them.
  const ONE_ROSTER_VB = {
    secondaryCharacters: [
      { id: 'CHR001', name: 'Frau Amrein', description: '55, tall, slim, silver bun, reading glasses', pages: [3, 4, 13, 15] },
      { id: 'CHR002', name: 'Lira', description: 'a mermaid with green scales', pages: [3, 5, 9] },
    ],
    animals: [{ id: 'ANI001', name: 'Tomcat', species: 'cat', description: 'a grey tomcat' }],
  };
  const ONE_ROSTER_CAST = { characters: [{ id: 1, name: 'Emma' }, { id: 2, name: 'Noah' }, { id: 3, name: 'Fiona' }, { id: 4, name: 'Sarah' }] };

  it('one-roster names each land on their own entry', () => {
    const i = buildCastIndex(ONE_ROSTER_CAST, ONE_ROSTER_VB);
    expect(resolveEntity('Emma', i).kind).toBe('cast');
    expect(resolveEntity('Noah', i).kind).toBe('cast');
    expect(resolveEntity('Fiona', i).kind).toBe('cast');
    expect(resolveEntity('Sarah', i).kind).toBe('cast');
    expect(resolveEntity('Frau Amrein', i).id).toBe('CHR001');
    expect(resolveEntity('CHR001', i).id).toBe('CHR001');
    expect(resolveEntity('Amrein', i).id).toBe('CHR001');   // the title-less prose form
    expect(resolveEntity('Lira', i).id).toBe('CHR002');
    expect(resolveEntity('Tomcat', i).id).toBe('ANI001');
    expect(resolveEntity('ANI001', i).id).toBe('ANI001');
    expect(resolveEntity('Ghost', i)).toBeNull();           // the suite's undeclared name
  });

  const EXTRA_VB = {
    secondaryCharacters: [{ id: 'CHR001', name: 'Frau Meier', age: 'adult', hair: 'grey bun' }],
    animals: [{ id: 'ANI001', name: 'Nia', species: 'dog', coloring: 'black and white' }],
    artifacts: [{ id: 'ART001', name: 'kite' }],
  };
  const EXTRA_CAST = { characters: [{ id: 1, name: 'Aaron' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Carl' }, { id: 4, name: 'Dan' }] };

  it('extra-character-type names resolve, by name AND by id', () => {
    const i = buildCastIndex(EXTRA_CAST, EXTRA_VB);
    for (const n of ['Aaron', 'Ben', 'Carl', 'Dan']) expect(resolveEntity(n, i).kind).toBe('cast');
    expect(resolveEntity('aaron', i).name).toBe('Aaron');   // the suite's case-only duplicate
    expect(resolveEntity('CHR001', i).name).toBe('Frau Meier');
    expect(resolveEntity('Frau Meier', i).id).toBe('CHR001');
    expect(resolveEntity('ANI001', i).name).toBe('Nia');
    expect(isNonHuman(resolveEntity('Nia', i))).toBe(true);
    // Artifacts are not a cast pool — a prop id must not resolve to a figure.
    expect(resolveEntity('ART001', i)).toBeNull();
  });
});
