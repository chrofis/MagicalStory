import { describe, it, expect } from 'vitest';

// Phase 1 of the presence-signal rewrite: there is ONE roster.
// buildExpectedCastBlock decides MEMBERSHIP; every detector-side builder
// resolves its name set through it and keeps its own identity prose.
// Evidence throughout: job_1789207854566_l43qgl34w.
const {
  buildExpectedCastBlock,
  resolveExpectedCastNames,
  reconcileDetectorCast,
} = require('../../server/lib/evalPipeline');

const VB = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'Frau Amrein', description: '55, tall, slim, silver bun, reading glasses', pages: [3, 4, 13, 15] },
    { id: 'CHR002', name: 'Lira', description: 'a mermaid with green scales', pages: [3, 5, 9] },
  ],
  animals: [{ id: 'ANI001', name: 'Tomcat', species: 'cat', description: 'a grey tomcat' }],
};

describe('buildExpectedCastBlock — the secondary that declares this page', () => {
  it('adds a VB secondary whose own pages[] names this page', () => {
    // The one input only the detector-side builder used to have.
    const r = buildExpectedCastBlock({
      sceneCharacters: [{ name: 'Emma' }, { name: 'Noah' }],
      visualBible: VB,
      pageNumber: 5,
    });
    expect(r.names).toContain('Lira');
    expect(r.names).toContain('Emma');
  });

  it('does not add that secondary on a page it does not declare', () => {
    const r = buildExpectedCastBlock({
      sceneCharacters: [{ name: 'Emma' }],
      visualBible: VB,
      pageNumber: 7,
    });
    expect(r.names).not.toContain('Lira');
  });

  it('adds nothing extra when the caller supplies no page number', () => {
    const r = buildExpectedCastBlock({ sceneCharacters: [{ name: 'Emma' }], visualBible: VB });
    expect(r.names).toEqual(['Emma']);
  });

  it('still reads objects[] — a figure filed as an object is still a figure', () => {
    // The 2026-09-12 input must survive the ONE ROSTER change.
    const r = buildExpectedCastBlock({
      sceneCharacters: [{ name: 'Fiona' }],
      visualBible: VB,
      sceneMetadata: { objects: ['LOC003', 'CHR001', 'ART004'] },
      pageNumber: 15,
    });
    expect(r.names.sort()).toEqual(['Fiona', 'Frau Amrein']);
  });

  it('an undeclared cast stays undeclared regardless of the new inputs', () => {
    const r = buildExpectedCastBlock({ sceneCharacters: null, visualBible: VB, pageNumber: 3 });
    // `crowdExpected` (2026-09-13) rides on every roster; an undeclared one
    // carries the safe default, because absent must always mean "no crowd".
    // `nonHumanNames` likewise — an undeclared roster names nobody, human or not.
    expect(r).toEqual({ block: '', names: [], count: 0, declared: false, crowdExpected: false, nonHumanNames: [] });
  });
});

describe('resolveExpectedCastNames', () => {
  it('exposes the roster as an ordered list and a lowercase lookup', () => {
    const r = resolveExpectedCastNames({ sceneCharacters: [{ name: 'Fiona' }, 'Sarah'] });
    expect(r.names).toEqual(['Fiona', 'Sarah']);
    expect(r.byLower.get('sarah')).toBe('Sarah');
    expect(r.declared).toBe(true);
  });
});

describe('reconcileDetectorCast', () => {
  const detector = [
    { name: 'Fiona', description: 'young-adult woman, soft jawline, blue tricorn' },
    { name: 'Sarah', description: 'blonde, red tricorn' },
  ];

  it('appends a roster name the detector lacks, described from the Visual Bible', () => {
    const auth = resolveExpectedCastNames({
      sceneCharacters: [{ name: 'Fiona' }, { name: 'Sarah' }],
      visualBible: VB,
      sceneMetadata: { objects: ['CHR001'] },
    });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.names.sort()).toEqual(['Fiona', 'Frau Amrein', 'Sarah']);
    expect(out.added).toEqual(['Frau Amrein']);
    const added = out.entries.find((e: any) => e.name === 'Frau Amrein');
    expect(added.description).toMatch(/silver bun|55/);
  });

  it('NEVER drops a detector entry the roster does not hold', () => {
    // p15: the detector's six names were right and the page roster's [Fiona]
    // was the stale one. Deleting on that basis blinds the identity call.
    const auth = resolveExpectedCastNames({ sceneCharacters: [{ name: 'Fiona' }] });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.names.sort()).toEqual(['Fiona', 'Sarah']);
    expect(out.added).toEqual([]);
  });

  it('never rewrites an existing entry description', () => {
    const auth = resolveExpectedCastNames({ sceneCharacters: [{ name: 'Fiona' }, { name: 'Sarah' }] });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.entries[0].description).toBe(detector[0].description);
    expect(out.entries[1].description).toBe(detector[1].description);
  });

  it('appends a roster name the Bible cannot describe, name-only', () => {
    const auth = resolveExpectedCastNames({ sceneCharacters: [{ name: 'Fiona' }, { name: 'Ghost' }] });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.names).toContain('Ghost');
    expect(out.entries.find((e: any) => e.name === 'Ghost').description).toBe('');
  });

  it('is a no-op when the roster was never declared', () => {
    const auth = resolveExpectedCastNames({ sceneCharacters: null });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.entries).toEqual(detector);
    expect(out.added).toEqual([]);
  });

  // ONE NAME-MATCHING RULE (2026-09-13). `have` held the DETECTOR spellings and
  // `missing` compared the ROSTER names to it by string, so a short form and a
  // long form of one person never met: job_1789163494908_kc2joi4ax p9 stored
  // expectedCharacters = ["Julian","Max","Kiaan","Vendor","Marroni Vendor"] —
  // one person, appended twice.
  it('a detector short form "Vendor" gains NOTHING when the roster holds "Marroni Vendor"', () => {
    const VB2 = {
      secondaryCharacters: [{ id: 'CHR009', name: 'Marroni Vendor', description: 'stooped, striped apron' }],
      animals: [],
    };
    const det = [
      { name: 'Julian', description: 'boy, red scarf' },
      { name: 'Vendor', description: 'stooped, striped apron' },
    ];
    const auth = resolveExpectedCastNames({
      sceneCharacters: [{ name: 'Julian' }],
      visualBible: VB2,
      sceneMetadata: { objects: ['CHR009'] },
    });
    expect(auth.names).toContain('Marroni Vendor');
    const out = reconcileDetectorCast(det, auth, { visualBible: VB2 });
    expect(out.added).toEqual([]);
    expect(out.names).toEqual(['Julian', 'Vendor']);
  });

  it('matches names case-insensitively so no duplicate is appended', () => {
    const auth = resolveExpectedCastNames({ sceneCharacters: ['fiona', 'SARAH'] });
    const out = reconcileDetectorCast(detector, auth, { visualBible: VB });
    expect(out.added).toEqual([]);
  });
});

describe('reconcileDetectorCast — the main cast reaches the resolver index', () => {
  // Three call sites built their index without `storyData`, so every
  // photo-backed name logged "unresolved" and two spellings of one person
  // could never meet (job_1789348171785_9oxos7dwv).
  const storyData = { characters: [{ name: 'Levin Meier' }, { name: 'Julian' }] };

  it('treats a long and a short spelling of a main character as one person', () => {
    const auth = resolveExpectedCastNames({
      sceneCharacters: [{ name: 'Levin' }],
      storyData,
    });
    const out = reconcileDetectorCast([{ name: 'Levin Meier', description: 'boy, red jacket' }],
      auth, { storyData });
    expect(out.names).toEqual(['Levin Meier']);
    expect(out.added).toEqual([]);
  });

  it('without the story the same two spellings are two people', () => {
    const auth = resolveExpectedCastNames({ sceneCharacters: [{ name: 'Levin' }] });
    const out = reconcileDetectorCast([{ name: 'Levin Meier', description: 'boy, red jacket' }], auth, {});
    expect(out.added).toEqual(['Levin']);
  });
});
