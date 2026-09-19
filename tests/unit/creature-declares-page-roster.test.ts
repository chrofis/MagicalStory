/**
 * A NAMED CREATURE THAT DECLARES THIS PAGE IS EXPECTED CAST.
 *
 * `buildSecondaryExpectedForPage` reads a Visual Bible entry's own `pages[]` —
 * the strongest signal there is about who was staged on a page, stronger than
 * the scene metadata lists, which routinely omit a figure the prose and the
 * image prompt both carry. It read `vb.secondaryCharacters` ONLY, and never
 * `vb.animals`, although animal entries carry `pages[]` in exactly the same
 * shape.
 *
 * So a named creature the brief staged on a page could be absent from the
 * judge's EXPECTED CAST — it could not be reported absent, and drawing it could
 * read as a surplus figure. The two enrichment paths added on 2026-09-10 and
 * 2026-09-12 (`includeAnimals` on `buildSecondaryExpectedCharacters`, and
 * `collectSceneObjectFigureNames`) already cover a creature the scene metadata
 * lists or files in `objects[]`; this closes the third door.
 *
 * Measured by replaying the real roster builder over 1,392 stored staging
 * pages: 68 of them (4.9%) gain at least one creature, and no page loses a
 * name — "Nia" the dog on eight pages of job_1789147573901_m3uam0nxi, plus
 * "Fauchi", "Nebel", "Grosser Rabe"/"Kleiner Rabe", "Beni". Those are the pages
 * where the creature's `pages[]` declaration is its ONLY declaration: the scene
 * metadata does not list it and `objects[]` does not file its VB id, so neither
 * of the other two enrichment paths could reach it.
 *
 * The fix is an opt-in on the EXISTING builder, not a second roster. It stays
 * OFF by default because the other caller is the DETECTOR roster, where the
 * owner's 2026-08-19 ruling holds: DINO detects `person`, so an animal on a
 * detector roster is a guaranteed missing person.
 *
 * Fixtures are the real stored Visual Bible of job_1789348171785_9oxos7dwv
 * (the terrier mix "Nia", ANI001, pages [5,7,12,13,15,17]).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildSecondaryExpectedForPage } = require_('../../server/lib/promptBuilders');
const { buildExpectedCastBlock } = require_('../../server/lib/evalPipeline');

const fixture = require_('./fixtures/animal-cast-job_1789348171785_9oxos7dwv.json');
const VB = fixture.visualBible;
const NIA = VB.animals[0];          // terrier mix, pages [5,7,12,13,15,17]
const OFELI = VB.animals[1];        // small dragon

describe('buildSecondaryExpectedForPage and the animal pool', () => {
  it('ignores animals by default — the detector roster must not gain one', () => {
    const out = buildSecondaryExpectedForPage(VB, 7, []);
    expect(out.some((e: any) => e.name === NIA.name)).toBe(false);
    expect(out.some((e: any) => e.name === OFELI.name)).toBe(false);
  });

  it('returns an animal that declares the page when asked', () => {
    const out = buildSecondaryExpectedForPage(VB, 7, [], { includeAnimals: true });
    const nia = out.find((e: any) => e.name === NIA.name);
    expect(nia).toBeTruthy();
    expect(nia.description).toContain('terrier mix dog');
  });

  it('does NOT return an animal on a page it does not declare', () => {
    expect(NIA.pages).not.toContain(6);
    const out = buildSecondaryExpectedForPage(VB, 6, [], { includeAnimals: true });
    expect(out.some((e: any) => e.name === NIA.name)).toBe(false);
  });

  it('never double-lists a creature the caller already has', () => {
    const out = buildSecondaryExpectedForPage(VB, 7, [NIA.name], { includeAnimals: true });
    expect(out.some((e: any) => e.name === NIA.name)).toBe(false);
  });

  it('describes a creature from its OWN fields, not a human\'s', () => {
    // An animal entry has no hair/face/clothing. Before this, a creature whose
    // VB entry carried no prose `description` was silently dropped by the
    // `if (!desc) continue` guard — which is the gap, not a filter.
    const bare = { animals: [{ id: 'ANI009', name: 'Karu', species: 'small dragon', coloring: 'rusty red scales', pages: [6] }] };
    const out = buildSecondaryExpectedForPage(bare, 6, [], { includeAnimals: true });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Karu');
    expect(out[0].description).toContain('small dragon');
    expect(out[0].description).toContain('rusty red scales');
  });

  it('tolerates a malformed or missing animal pool', () => {
    expect(buildSecondaryExpectedForPage({}, 3, [], { includeAnimals: true })).toEqual([]);
    expect(buildSecondaryExpectedForPage({ animals: null }, 3, [], { includeAnimals: true })).toEqual([]);
    // Object-keyed pools are a real stored shape and must not throw.
    expect(() => buildSecondaryExpectedForPage({ animals: { a: NIA } }, 7, [], { includeAnimals: true })).not.toThrow();
  });
});

describe('the evaluator roster carries the creature', () => {
  // A page whose metadata names only the human cast — no `objects[]` entry for
  // the animal, which is the shape `collectSceneObjectFigureNames` needs. The
  // creature's OWN `pages[]` declaration is then the only thing that can put it
  // on the roster, and that is the path this change opens.
  const page = (pageNumber: number) => buildExpectedCastBlock({
    sceneCharacters: ['Levin', 'Julian'],
    sceneMetadata: { characters: ['Levin', 'Julian'], objects: ['LOC003'] },
    originalPrompt: '',
    visualBible: VB,
    evaluationType: 'scene',
    pageNumber,
    storyData: { characters: [{ name: 'Levin' }, { name: 'Julian' }], visualBible: VB },
  });

  it('puts a creature that declares the page on the roster', () => {
    const r = page(7);
    expect(NIA.pages).toContain(7);
    expect(r.names).toContain(NIA.name);
    expect(r.block).toContain(NIA.name);
  });

  it('leaves it off a page it does not declare', () => {
    expect(NIA.pages).not.toContain(6);
    expect(page(6).names).not.toContain(NIA.name);
  });

  it('labels it as an animal, so a human can never satisfy the entry', () => {
    // The kind label is what tells a judge the entry can never be satisfied —
    // or violated — by a person-figure.
    expect(page(7).block).toMatch(new RegExp(`${NIA.name} \\(animal[,)]`));
  });

  it('keeps it OUT of the people arithmetic — a creature is never a person', () => {
    const r = page(7);
    expect(r.nonHumanNames).toContain(NIA.name);
    // People-only count: the roster grew, the people count did not.
    const people = r.names.filter((n: string) => !r.nonHumanNames.includes(n));
    expect(people).toEqual(['Levin', 'Julian']);
  });

  it('never invents a creature on a story with no animals', () => {
    const r = buildExpectedCastBlock({
      sceneCharacters: ['Levin'],
      sceneMetadata: { characters: ['Levin'] },
      visualBible: { ...VB, animals: [] },
      pageNumber: 7,
      storyData: { characters: [{ name: 'Levin' }], visualBible: { ...VB, animals: [] } },
    });
    expect(r.names).toEqual(['Levin']);
    expect(r.nonHumanNames).toEqual([]);
  });
});
