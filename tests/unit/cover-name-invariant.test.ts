import { describe, it, expect } from 'vitest';

// The cover NAME invariant: a Visual Bible entity whose name appears in the
// assembled cover scene description is either FULLY SENT (definition in KEY
// STORY ELEMENTS + reference image in the VB grid) or its name does not appear.
//
// Evidence: staging job_1788903616404_iqvhj4l8m front cover — ANI001 "Nia"
// (a dog) was pasted into the description via the outline's free-text
// `position` field, reached the model with no definition and no reference,
// and was painted as a fifth human child.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  matchVbEntitiesInText,
  stripEntityNameFromDescription,
  reconcileCoverSceneEntities,
  COVER_ELEMENT_REF_CAP,
} = require('../../server/lib/coverIterate');

const REF = { referenceImageUrl: 'https://r2.example/ref.png' };

const vb: any = {
  locations: [{ id: 'LOC001', name: 'Nia Valley', referencePhotoUrl: 'x' }],
  secondaryCharacters: [{ id: 'CHR009', name: 'Levin', ...REF }],
  animals: [
    { id: 'ANI001', name: 'Nia', description: 'a small brown dog', ...REF },
    { id: 'ANI002', name: 'Fenno', description: 'a green dragon', ...REF },
    { id: 'ANI003', name: 'Niamh', description: 'a cat', ...REF },
    { id: 'ANI004', name: 'Skarn', description: 'a wolf' }, // NO reference image
  ],
  artifacts: [
    { id: 'ART001', name: 'the scale', description: 'a golden scale', ...REF },
    { id: 'ART002', name: 'rope', description: 'a coil of rope' }, // generic, no ref
  ],
  vehicles: [],
};

const DESC =
  'A wide group portrait set before the castle. ' +
  'Max, a preschooler little boy, stands in the right of Levin, leaning forward with Nia beside him, eyes on the viewer.';

describe('matchVbEntitiesInText', () => {
  it('finds an animal named in the description', () => {
    const hits = matchVbEntitiesInText(DESC, vb).map((h: any) => h.id);
    expect(hits).toContain('ANI001');
  });

  it('is whole-word: "Nia" does not match inside "Niamh"', () => {
    const hits = matchVbEntitiesInText('Only Niamh appears.', vb).map((h: any) => h.id);
    expect(hits).toContain('ANI003');
    expect(hits).not.toContain('ANI001');
  });

  it('is case-insensitive', () => {
    expect(matchVbEntitiesInText('the FENNO soars.', vb).map((h: any) => h.id)).toContain('ANI002');
  });

  it('never matches locations, and skips entries with no name', () => {
    const withNameless = { ...vb, artifacts: [{ id: 'ART099' }, ...vb.artifacts] };
    const hits = matchVbEntitiesInText('A view over Nia Valley.', withNameless);
    expect(hits.every((h: any) => !String(h.id).startsWith('LOC'))).toBe(true);
  });

  it('flags entries with no reference image', () => {
    const hit = matchVbEntitiesInText('Skarn howls.', vb)[0];
    expect(hit.id).toBe('ANI004');
    expect(hit.hasReference).toBe(false);
  });
});

describe('reconcileCoverSceneEntities — injection side', () => {
  it('unions a named, reference-bearing entity into the element ids and leaves the prose intact', () => {
    const out = reconcileCoverSceneEntities({
      sceneDescription: DESC,
      visualBible: vb,
      elementIds: ['LOC001', 'ANI002', 'ART001'],
      label: 'TEST',
    });
    expect(out.elementIds).toContain('ANI001');   // (a) KEY STORY ELEMENTS gate
    expect(out.injected.map((i: any) => i.id)).toContain('ANI001');
    expect(out.injected[0].hasReference).toBe(true); // (b) grid-eligible
    expect(out.sceneDescription).toContain('Nia');
    expect(out.stripped).toHaveLength(0);
  });

  it('does not re-add an entity already in the element ids', () => {
    const out = reconcileCoverSceneEntities({
      sceneDescription: DESC, visualBible: vb, elementIds: ['ANI001'], label: 'TEST',
    });
    // Nia is already sent; Levin (also named in DESC, also ref-bearing) is
    // legitimately picked up — the invariant is per-entity, not all-or-nothing.
    expect(out.injected.map((i: any) => i.id)).not.toContain('ANI001');
    expect(out.injected.map((i: any) => i.id)).toEqual(['CHR009']);
    expect(out.sceneDescription).toBe(DESC);
  });
});

describe('reconcileCoverSceneEntities — strip fallback', () => {
  it('strips a proper name that has no reference image', () => {
    const desc = 'A portrait before the castle. Max stands in the centre with Skarn beside him, eyes on the viewer.';
    const out = reconcileCoverSceneEntities({ sceneDescription: desc, visualBible: vb, elementIds: [], label: 'TEST' });
    expect(out.sceneDescription).not.toMatch(/Skarn/i);
    expect(out.sceneDescription).toContain('Max stands in the centre');
    expect(out.stripped[0]).toMatchObject({ id: 'ANI004' });
  });

  it('strips when the element budget is already full', () => {
    const full = ['ART001', 'ANI002', 'CHR009', 'VEH001', 'ART003', 'ART004']; // 6 = cap
    expect(full.length).toBe(COVER_ELEMENT_REF_CAP);
    const out = reconcileCoverSceneEntities({ sceneDescription: DESC, visualBible: vb, elementIds: full, label: 'TEST' });
    expect(out.sceneDescription).not.toMatch(/\bNia\b/);
    expect(out.stripped.map((s: any) => s.id)).toContain('ANI001');
    expect(out.elementIds).not.toContain('ANI001');
  });

  it('locations do not consume the budget', () => {
    const withLocs = ['LOC001', 'LOC002', 'LOC003', 'LOC004', 'LOC005', 'LOC006', 'ART001'];
    const out = reconcileCoverSceneEntities({ sceneDescription: DESC, visualBible: vb, elementIds: withLocs, label: 'TEST' });
    expect(out.elementIds).toContain('ANI001');
    expect(out.sceneDescription).toContain('Nia');
  });

  it('leaves a generic lowercase noun in place (warn only)', () => {
    const desc = 'A portrait. Max stands in the centre holding a rope, eyes on the viewer.';
    const out = reconcileCoverSceneEntities({ sceneDescription: desc, visualBible: vb, elementIds: [], label: 'TEST' });
    expect(out.sceneDescription).toContain('rope');
    expect(out.stripped).toHaveLength(0);
  });

  it('token strip mode does not break a JSON description', () => {
    const json = '```json\n' + JSON.stringify({ characters: [{ name: 'Max', position: 'right of Levin with Skarn' }] }, null, 2) + '\n```';
    const out = reconcileCoverSceneEntities({
      sceneDescription: json, visualBible: vb, elementIds: [], label: 'TEST', stripMode: 'token',
    });
    expect(out.sceneDescription).not.toMatch(/Skarn/);
    const body = out.sceneDescription.replace(/^```json\n/, '').replace(/\n```$/, '');
    expect(() => JSON.parse(body)).not.toThrow();
  });
});

describe('stripEntityNameFromDescription', () => {
  it('drops the whole companion clause and stays grammatical', () => {
    const out = stripEntityNameFromDescription(DESC, 'Nia');
    expect(out).not.toMatch(/\bNia\b/);
    expect(out).toMatch(/eyes on the viewer\.$/);
    expect(out).not.toMatch(/,\s*,|\s,|\s\./);
  });

  it('always removes the name, even as a bare sentence subject', () => {
    expect(stripEntityNameFromDescription('Nia barks.', 'Nia')).not.toMatch(/\bNia\b/);
  });
});
