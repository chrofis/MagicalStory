import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED (owner, 2026-09-21): "Secondaries have a VB entry and are
// compared with that." A Visual Bible secondary with a rendered reference-sheet
// cell is handed that cell as her identity reference in the page eval, is
// therefore reference-backed for the presence reconciliation, and an unmatched
// figure beside her name becomes a CRITICAL named after HER.
// Measured before the fix on staging job_1789853503332_riqncqg1i p10/p15: VB
// CHR001 had a sheet cell, the eval attached zero references for her, and the
// derivation reconciled the pair away as `unclaimed_cast_has_no_reference`.

const {
  vbCellReferencesForCast,
  derivePresenceFinding,
} = require_('../../server/lib/evalPipeline.js');
const { buildCastIndex } = require_('../../server/lib/castResolver.js');

const visualBible = {
  mainCharacters: [{ id: 'MC1', name: 'Max' }],
  secondaryCharacters: [
    {
      id: 'CHR001',
      name: 'Silvan',
      description: 'an older boy',
      referenceImageUrl: 'https://r2.example/chr001-cell.jpg',
      appearsInPages: [15],
    },
    { id: 'CHR002', name: 'Nele', description: 'a neighbour' }, // no cell
  ],
  animals: [{ id: 'ANI001', name: 'Bruno', species: 'dog', referenceImageUrl: 'https://r2.example/ani.jpg' }],
};
const storyData = { characters: [{ id: 'c1', name: 'Max' }] };
const index = buildCastIndex(storyData, visualBible);

describe('a VB secondary is judged against her visual-bible cell', () => {
  it('the cell is attached as a reference, labelled as a drawn cell', () => {
    const refs = vbCellReferencesForCast({
      castNames: ['Max', 'Silvan'],
      visualBible,
      castIndex: index,
      existing: [{ name: 'Max', photoUrl: 'https://r2.example/max.jpg' }],
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      name: 'Silvan',
      photoUrl: 'https://r2.example/chr001-cell.jpg',
      vbId: 'CHR001',
      vbCell: true,
    });
  });

  it('a secondary with no rendered cell stays reference-less', () => {
    const refs = vbCellReferencesForCast({ castNames: ['Nele'], visualBible, castIndex: index, existing: [] });
    expect(refs).toEqual([]);
  });

  it('a roster-backed name is never given a VB cell, and an animal is not a figure reference', () => {
    const refs = vbCellReferencesForCast({ castNames: ['Max', 'Bruno'], visualBible, castIndex: index, existing: [] });
    expect(refs).toEqual([]);
  });

  it('a name already referenced is not duplicated', () => {
    const refs = vbCellReferencesForCast({
      castNames: ['Silvan'],
      visualBible,
      castIndex: index,
      existing: [{ name: 'Silvan', photoUrl: 'https://r2.example/other.jpg' }],
    });
    expect(refs).toEqual([]);
  });

  it('being reference-backed turns the reconciled-away pair into a CRITICAL named after her', () => {
    const cast = { names: ['Max', 'Silvan'], count: 2, population: 'cast_only', crowdExpected: false, declared: true, nonHumanNames: [] };
    const args = {
      figures: [{ id: 1 }, { id: 2 }],
      matches: [
        { figure: 1, reference: 'Max', confidence: 0.9 },
        { figure: 2, reference: 'unmatched', confidence: 0 },
      ],
      cast,
      detectedFigureCount: 2,
      castIndex: index,
    };

    const before = derivePresenceFinding({ ...args, referenceNames: ['Max'] });
    expect(before.outcome).toBe('reconciled');
    expect(before.reason).toBe('unclaimed_cast_has_no_reference');
    expect(before.finding).toBeNull();

    const after = derivePresenceFinding({ ...args, referenceNames: ['Max', 'Silvan'] });
    expect(after.outcome).toBe('character_identity');
    expect(after.finding.severity).toBe('CRITICAL');
    expect(after.finding.character).toBe('Silvan');
  });
});
