/**
 * Era-aware landmark protection (owner ruling 2026-09-05).
 *
 * Evidence: staging story job_1788614817116_vxnu60yjg page 2 rendered the
 * Uetliberg Fernsehturm and Uto Kulm spire faithfully from the attached
 * landmark photo ("Oppidum Uetliberg Rampart"). The story has NO era anywhere,
 * so the era guard is empty (present day) — yet the three-stage compliance
 * judge emitted a MAJOR `object_presence` "unrequested modern infrastructure"
 * finding whose fix was "Remove transmission towers and replace background …".
 * It reached Grok as an unmasked whole-frame edit and the erased version
 * scored 83 against the faithful original's 55.
 *
 * Rule: landmark attached + era NOT historical  → finding dropped, name seeded
 *       landmark attached + era historical      → finding kept
 *       no landmark                             → unchanged
 */
import { describe, it, expect } from 'vitest';

const {
  resolveSceneEra,
  landmarkNames,
  computeLandmarkProtection,
  buildLandmarkComplianceBlock,
  isRemovalShapedFix,
  filterProtectedRemovals,
  seedPreserveWithLandmarks,
} = require('../../server/lib/landmarkProtection');

const LANDMARK = 'Oppidum Uetliberg Rampart';
const photos = [{ name: LANDMARK, photoData: 'data:image/jpeg;base64,xx' }];

/** The finding exactly as stored on job_1788614817116_vxnu60yjg page 2. */
const storedFinding = {
  type: 'object_presence',
  severity: 'MAJOR',
  description:
    'Setting includes unrequested modern infrastructure: red-white transmission tower and smaller grey-red tower in background',
  fix: 'Remove transmission towers and replace background with a historically appropriate landscape consistent with ancient earthwork',
  source: 'three-stage',
};

describe('landmarkProtection — era classification', () => {
  it('reuses buildEraGuard: null / present day / contemporary are NOT historical', () => {
    for (const era of [null, '', '  ', 'present day', 'Present Day, Zurich', 'contemporary', 'modern day']) {
      expect(computeLandmarkProtection({ landmarkPhotos: photos, era }).eraIsHistorical).toBe(false);
    }
  });

  it('a real era IS historical and carries the era guard text', () => {
    const p = computeLandmarkProtection({ landmarkPhotos: photos, era: 'medieval Switzerland, ~1300' });
    expect(p.eraIsHistorical).toBe(true);
    expect(p.eraGuard).toContain('medieval Switzerland, ~1300');
    expect(p.protect).toBe(false);
  });

  it('reads the era from scene metadata, including fullData', () => {
    expect(resolveSceneEra({ era: '1920s New York' })).toBe('1920s New York');
    expect(resolveSceneEra({ fullData: { era: '1920s New York' } })).toBe('1920s New York');
    expect(resolveSceneEra(null)).toBeNull();
    expect(resolveSceneEra({})).toBeNull();
  });

  it('dedupes landmark names and ignores unnamed refs', () => {
    expect(landmarkNames([{ name: LANDMARK }, { name: LANDMARK }, { name: '' }, null])).toEqual([LANDMARK]);
    expect(landmarkNames(null)).toEqual([]);
  });
});

describe('landmarkProtection — the guard', () => {
  it('present-day + landmark → the object_presence removal is DROPPED', () => {
    const prot = computeLandmarkProtection({ landmarkPhotos: photos, era: null });
    expect(prot.protect).toBe(true);
    const { kept, dropped } = filterProtectedRemovals([storedFinding], prot, { pageNumber: 2, quiet: true });
    expect(dropped).toHaveLength(1);
    expect(kept).toHaveLength(0);
  });

  it('historical + landmark → the same finding is KEPT', () => {
    const prot = computeLandmarkProtection({ landmarkPhotos: photos, era: 'medieval Switzerland, ~1300' });
    expect(prot.protect).toBe(false);
    const { kept, dropped } = filterProtectedRemovals([storedFinding], prot, { pageNumber: 2, quiet: true });
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('no landmark → unchanged, whatever the era', () => {
    for (const era of [null, 'medieval Switzerland, ~1300']) {
      const prot = computeLandmarkProtection({ landmarkPhotos: [], era });
      const { kept, dropped } = filterProtectedRemovals([storedFinding], prot, { quiet: true });
      expect(kept).toEqual([storedFinding]);
      expect(dropped).toHaveLength(0);
    }
  });

  it('only removal-shaped object_presence is dropped — other findings survive a protected page', () => {
    const prot = computeLandmarkProtection({ landmarkPhotos: photos, era: null });
    const others = [
      { type: 'object_presence', severity: 'MODERATE', description: "Stone lacks the prompt's blue-golden glow", fix: 'Repaint the stone with a blue-golden glow' },
      { type: 'clothing', severity: 'MAJOR', description: 'Wrong jacket', fix: 'Remove the jacket and paint the described coat' },
      { type: 'missing_character', severity: 'CRITICAL', description: 'Second child absent', fix: 'Add the second child' },
    ];
    const { kept, dropped } = filterProtectedRemovals(others, prot, { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(3);
  });

  it('classifies on the fix (the edit instruction), never on the description', () => {
    expect(isRemovalShapedFix({ fix: 'Remove transmission towers' })).toBe(true);
    expect(isRemovalShapedFix({ fix: 'Replace the background with a meadow' })).toBe(true);
    expect(isRemovalShapedFix({ fix: 'Repaint the tower in the art style' })).toBe(false);
    // Description alone never triggers it.
    expect(isRemovalShapedFix({ description: 'Remove the tower', fix: '' })).toBe(false);
  });
});

describe('landmarkProtection — injected blocks', () => {
  it('protected page: the compliance block names the landmark and forbids the removal axes', () => {
    const block = buildLandmarkComplianceBlock(computeLandmarkProtection({ landmarkPhotos: photos, era: null }));
    expect(block).toContain('LANDMARK ELEMENTS — PRESENT BY DESIGN');
    expect(block).toContain(LANDMARK);
    expect(block).toMatch(/never report .*unrequested/i);
    expect(block).toMatch(/anachronistic/i);
    expect(block).toMatch(/never ask for it to be removed/i);
  });

  it('historical page: the compliance block carries the era guard, so modern infrastructure stays a finding', () => {
    const block = buildLandmarkComplianceBlock(
      computeLandmarkProtection({ landmarkPhotos: photos, era: 'medieval Switzerland, ~1300' }));
    expect(block).toContain('medieval Switzerland, ~1300');
    expect(block).toMatch(/remains a legitimate finding/i);
    expect(block).not.toContain('PRESENT BY DESIGN');
  });

  it('no landmark: no block at all', () => {
    expect(buildLandmarkComplianceBlock(computeLandmarkProtection({ landmarkPhotos: [], era: null }))).toBe('');
  });

  it('seeds scene_fix.preserve with the landmark name on a protected page only', () => {
    const plan: any = { scene_fix: { severity: 'MAJOR', instruction: '', preserve: ['the ridge path', 'the two children'] } };
    const added = seedPreserveWithLandmarks(plan, computeLandmarkProtection({ landmarkPhotos: photos, era: null }));
    expect(added).toEqual([LANDMARK]);
    expect(plan.scene_fix.preserve.some((p: string) => p.includes(LANDMARK))).toBe(true);

    const historical: any = { scene_fix: { preserve: [] } };
    expect(seedPreserveWithLandmarks(historical, computeLandmarkProtection({ landmarkPhotos: photos, era: '1300' }))).toEqual([]);
    expect(historical.scene_fix.preserve).toEqual([]);
  });

  it('seeding is idempotent', () => {
    const prot = computeLandmarkProtection({ landmarkPhotos: photos, era: null });
    const plan: any = { scene_fix: { preserve: [] } };
    seedPreserveWithLandmarks(plan, prot);
    seedPreserveWithLandmarks(plan, prot);
    expect(plan.scene_fix.preserve).toHaveLength(1);
  });
});

describe('landmarkProtection — offline replay of job_1788614817116_vxnu60yjg page 2', () => {
  it('the stored finding is dropped and the preserve list gains the landmark', () => {
    // The page as stored: landmark attached, no era anywhere.
    const prot = computeLandmarkProtection({
      landmarkPhotos: [{ name: LANDMARK }],
      era: resolveSceneEra({ era: null, fullData: { era: null } }),
    });
    const { kept, dropped } = filterProtectedRemovals([storedFinding], prot, { pageNumber: 2, quiet: true });
    expect(dropped.map((d: any) => d.description)).toEqual([storedFinding.description]);
    expect(kept).toHaveLength(0);

    // The consolidator's actual scene_fix.preserve from that page: six prose
    // items, no landmark.
    const plan: any = {
      scene_fix: {
        severity: 'MAJOR',
        instruction: 'Remove red-white transmission tower and grey-red tower from background.',
        preserve: [
          'the two children on the ridge path',
          'the grassy earthwork bank',
          'the beech trees along the crest',
          'the warm late-afternoon light',
          'the watercolour brushwork',
          'the calm sky in the upper left',
        ],
      },
    };
    const added = seedPreserveWithLandmarks(plan, prot);
    expect(added).toEqual([LANDMARK]);
    expect(plan.scene_fix.preserve).toHaveLength(7);
    expect(plan.scene_fix.preserve[6]).toContain(LANDMARK);
  });
});
