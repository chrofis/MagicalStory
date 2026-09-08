/**
 * The VB element budget — owner ruling 2026-09-06: never more than three
 * packable Visual Bible elements on a page, least important dropped.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const {
  VB_ELEMENT_BUDGET,
  rankPageElements,
  checkVbElementBudget,
  buildVbElementFindings,
  truncateSceneObjects,
  truncateBriefToBudget,
} = require('../../server/lib/vbElementBudget');

/** A bible whose entries all sit on page 3, one per packable type. */
function bible(overrides: any = {}) {
  return {
    secondaryCharacters: [
      { id: 'CHR001', name: 'the ferryman', appearsInPages: [3, 4, 5] },
      { id: 'CHR002', name: 'the neighbour', appearsInPages: [3] },
    ],
    animals: [{ id: 'ANI001', name: 'the goat', appearsInPages: [3] }],
    artifacts: [
      { id: 'ART001', name: 'the lantern', appearsInPages: [3, 7] },
      { id: 'ART002', name: 'the rope coil', appearsInPages: [3] },
    ],
    vehicles: [{ id: 'VEH001', name: 'the cart', appearsInPages: [3] }],
    locations: [
      { id: 'LOC001', name: 'the invented mill', appearsInPages: [3] },
      { id: 'LOC002', name: 'a real bridge', isRealLandmark: true, appearsInPages: [3] },
    ],
    ...overrides,
  };
}

describe('rankPageElements', () => {
  it('ranks by the reference-selection priority order, locations excluded', () => {
    const ranked = rankPageElements(3, { objects: [] }, bible());
    expect(ranked.map((e: any) => e.id)).toEqual([
      'CHR001', 'CHR002', 'ANI001', 'ART001', 'ART002', 'VEH001',
    ]);
    // Locations are not elements (owner, 2026-09-08): the real landmark ships
    // as a photograph, the invented one is the plate the cast stands in.
    expect(ranked.map((e: any) => e.id)).not.toContain('LOC001');
    expect(ranked.map((e: any) => e.id)).not.toContain('LOC002');
  });

  it('pins a recurring creature ahead of every other type', () => {
    const vb = bible({
      animals: [{ id: 'ANI001', name: 'the dragon', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8], referenceImageUrl: 'r2://dragon.png' }],
    });
    const ranked = rankPageElements(3, { objects: [] }, vb);
    expect(ranked[0].id).toBe('ANI001');
    expect(ranked[0].recurring).toBe(true);
  });

  it('breaks a type tie on focal, then asked-for, then story weight', () => {
    const vb = {
      artifacts: [
        { id: 'ART001', name: 'the lantern', appearsInPages: [3] },
        { id: 'ART002', name: 'the rope coil', appearsInPages: [3, 4, 5] },
        { id: 'ART003', name: 'the key', appearsInPages: [3] },
      ],
    };
    // ART003 is handled on the page (focal); ART001 is only named in objects[];
    // ART002 is neither, but the book comes back to it three times.
    const metadata = {
      objects: ['ART001', 'ART003'],
      interactions: [{ character: 'the child', object: 'ART003', action: 'holds' }],
    };
    expect(rankPageElements(3, metadata, vb).map((e: any) => e.id))
      .toEqual(['ART003', 'ART001', 'ART002']);
  });

  it('never counts a location, neither through appearsInPages nor through objects[]', () => {
    const vb = { locations: [{ id: 'LOC009', name: 'the invented cellar', appearsInPages: [8] }] };
    expect(rankPageElements(8, { objects: ['LOC009'] }, vb)).toEqual([]);
    expect(rankPageElements(8, { objects: [] }, vb)).toEqual([]);
  });
});

describe('checkVbElementBudget', () => {
  it('is silent at exactly three', () => {
    const vb = {
      secondaryCharacters: [{ id: 'CHR001', name: 'the ferryman', appearsInPages: [3] }],
      artifacts: [
        { id: 'ART001', name: 'the lantern', appearsInPages: [3] },
        { id: 'ART002', name: 'the rope coil', appearsInPages: [3] },
      ],
    };
    expect(rankPageElements(3, { objects: [] }, vb)).toHaveLength(VB_ELEMENT_BUDGET);
    expect(checkVbElementBudget(3, { objects: [] }, vb)).toBeNull();
  });

  it('names the count, the ranking and exactly the elements to drop at five', () => {
    const vb = {
      secondaryCharacters: [{ id: 'CHR001', name: 'the ferryman', appearsInPages: [3] }],
      animals: [{ id: 'ANI001', name: 'the goat', appearsInPages: [3] }],
      artifacts: [{ id: 'ART001', name: 'the lantern', appearsInPages: [3] }],
      vehicles: [{ id: 'VEH001', name: 'the cart', appearsInPages: [3] }, { id: 'VEH002', name: 'the barge', appearsInPages: [3] }],
      // Not an element: the invented location is the plate, and never counts.
      locations: [{ id: 'LOC001', name: 'the invented mill', appearsInPages: [3] }],
    };
    const f: any = checkVbElementBudget(3, { objects: [] }, vb);
    expect(f.type).toBe('vb_element_overflow');
    expect(f.requested).toEqual(['CHR001', 'ANI001', 'ART001', 'VEH001', 'VEH002']);
    expect(f.kept).toEqual(['CHR001', 'ANI001', 'ART001']);
    expect(f.dropped).toEqual(['VEH001', 'VEH002']);
    expect(f.detail).toContain('references 5 Visual Bible elements');
    expect(f.detail).toContain('keep at most 3');
    expect(f.detail).toContain('the cart (VEH001, vehicle)');
    expect(f.detail).not.toContain('LOC001');
  });

  it('reaches the scene review as a sent brief fault', () => {
    const { REVIEWABLE, renderFindingsBlock } = require('../../server/lib/sceneBriefCheck');
    expect(REVIEWABLE.has('vb_element_overflow')).toBe(true);
    const f: any = checkVbElementBudget(3, { objects: [] }, bible());
    const block = renderFindingsBlock(new Map([[3, [f]]]));
    expect(block).toContain('[vb_element_overflow]');
    expect(block).toContain('keep at most 3');
  });
});

describe('buildVbElementFindings', () => {
  it('returns one finding per overflowing page, in page order', () => {
    const vb = bible();
    const findings = buildVbElementFindings(
      [{ pageNumber: 9, objects: [] }, { pageNumber: 3, objects: [] }],
      vb,
    );
    expect(findings.map((f: any) => f.pageNumber)).toEqual([3]);
  });
});

describe('truncation (strike two)', () => {
  const vb = {
    secondaryCharacters: [{ id: 'CHR001', name: 'the ferryman', appearsInPages: [3] }],
    animals: [{ id: 'ANI001', name: 'the goat', appearsInPages: [3] }],
    artifacts: [{ id: 'ART001', name: 'the lantern', appearsInPages: [3] }],
    vehicles: [{ id: 'VEH001', name: 'the cart', appearsInPages: [3] }],
  };

  it('drops the lowest-ranked ids from objects[] and keeps the rest verbatim', () => {
    const metadata = { objects: ['CHR001', 'ANI001', 'ART001', 'VEH001'] };
    const out: any = truncateSceneObjects(metadata, vb, 3);
    expect(out.dropped).toEqual(['VEH001']);
    expect(out.objects).toEqual(['CHR001', 'ANI001', 'ART001']);
  });

  it('rewrites the brief text so the packer never sees a fourth element', () => {
    const brief = 'The ferryman lifts the lantern.\n\n---METADATA---\n'
      + JSON.stringify({ characters: [{ name: 'Mara' }], objects: ['CHR001', 'ANI001', 'ART001', 'VEH001'] });
    const out: any = truncateBriefToBudget(brief, vb, 3);
    expect(out.kept).toEqual(['CHR001', 'ANI001', 'ART001']);
    expect(out.brief).toContain('The ferryman lifts the lantern.');
    const meta = JSON.parse(out.brief.split('---METADATA---')[1]);
    expect(meta.objects).toEqual(['CHR001', 'ANI001', 'ART001']);
    expect(meta.characters).toEqual([{ name: 'Mara' }]);
    // Re-running is idempotent on the brief: VEH001 is gone from objects[], so
    // nothing further is removed. The element still counts (the bible's own
    // appearsInPages puts it on the page) — that half is bounded by the
    // page-gen selection cap, which is the same VB_ELEMENT_BUDGET.
    const again: any = truncateBriefToBudget(out.brief, vb, 3);
    expect(again.dropped).toEqual(['VEH001']);
    expect(JSON.parse(again.brief.split('---METADATA---')[1]).objects)
      .toEqual(['CHR001', 'ANI001', 'ART001']);
  });
});

describe('the Art Director prompts carry the injected budget', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });

  it('fills {VB_ELEMENT_BUDGET} in both scene-expansion templates', () => {
    const { buildSceneExpansionPrompt, buildSceneExpansionAllPrompt } = require('../../server/lib/promptBuilders');
    const characters = [{ name: 'Mara', age: 7 }];
    const one = buildSceneExpansionPrompt(3, 'PLAN: wide — Mara — she pushes off — the boat moves', characters, 'de');
    expect(one).toBeTruthy();
    expect(one).not.toContain('{VB_ELEMENT_BUDGET}');
    expect(one).toContain('At most 3 Visual Bible elements per page');

    const all = buildSceneExpansionAllPrompt(
      { characters, language: 'de' },
      [{ pageNumber: 1, planLine: 'wide — Mara — she pushes off — the boat moves' }],
      {},
    );
    expect(all).toBeTruthy();
    expect(all).not.toContain('{VB_ELEMENT_BUDGET}');
    expect(all).toContain('At most 3 Visual Bible elements per page');
  });
});
