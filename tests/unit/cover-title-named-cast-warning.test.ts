import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// A creature or character the TITLE names that has a Visual Bible entry
// belongs in the front cover's objects (owner, 2026-09-23). The writer
// templates carry the rule; the code only WARNS when it was not followed, and
// never adds the entity itself. Motivating case: prod trial
// job_1790169018278_n57xpnufo — the title's squirrel was named only in the
// cover's prose, with no id in objects, so it got no definition or reference.

const require_ = createRequire(import.meta.url);
const { warnTitleNamedEntitiesMissingFromCover } = require_('../../server/lib/coverIterate');
const { addLogListener, removeLogListener } = require_('../../server/utils/logger');

// Archetypal fixture, not from any story.
const bible = () => ({
  animals: [{ id: 'ANI001', name: "l'Écureuil" }, { id: 'ANI002', name: 'owl', properName: 'Nox' }],
  secondaryCharacters: [{ id: 'CHR002', name: 'the Baker' }],
  artifacts: [{ id: 'ART001', name: 'lantern' }],
});

const captureWarns = (fn: () => any) => {
  const warns: string[] = [];
  const listener = (level: string, line: string) => { if (level === 'warn') warns.push(line); };
  addLogListener(listener);
  try { return { result: fn(), warns }; } finally { removeLogListener(listener); }
};

describe('warnTitleNamedEntitiesMissingFromCover', () => {
  it('flags a title-named animal missing from objects, case- and accent-insensitively', () => {
    const missing = warnTitleNamedEntitiesMissingFromCover({
      title: "The Hero and L'ECUREUIL of the Square", objects: [{ id: 'LOC001' }], visualBible: bible(),
    });
    expect(missing.map((m: any) => m.id)).toEqual(['ANI001']);
  });

  it('is silent when the entity is listed (string, object or dotted handle)', () => {
    for (const objects of [['LOC001', 'ANI001'], [{ id: 'ANI001' }], ['ANI001.2']]) {
      expect(warnTitleNamedEntitiesMissingFromCover({ title: "l'Écureuil", objects, visualBible: bible() })).toEqual([]);
    }
  });

  it('matches a proper name and a secondary character; ignores artifacts and partial words', () => {
    const ids = warnTitleNamedEntitiesMissingFromCover({
      title: 'Nox, the Baker and the lantern', objects: [], visualBible: bible(),
    }).map((m: any) => m.id);
    expect(ids.sort()).toEqual(['ANI002', 'CHR002']);
    expect(warnTitleNamedEntitiesMissingFromCover({ title: 'Noxious fumes', objects: [], visualBible: bible() })).toEqual([]);
  });

  it('never changes the objects list', () => {
    const objects = [{ id: 'LOC001' }];
    warnTitleNamedEntitiesMissingFromCover({ title: "l'Écureuil", objects, visualBible: bible() });
    expect(objects).toEqual([{ id: 'LOC001' }]);
  });

  it('logs one warning naming the missing entity', () => {
    const { warns } = captureWarns(() => warnTitleNamedEntitiesMissingFromCover({
      title: "l'Écureuil", objects: [], visualBible: bible(), label: 'T',
    }));
    expect(warns.some(w => w.includes('COVER-TITLE-CAST') && w.includes('ANI001'))).toBe(true);
  });
});
