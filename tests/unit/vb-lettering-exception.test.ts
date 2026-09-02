import { describe, it, expect, beforeAll } from 'vitest';

// The bug this file locks down: `sanitizeVbIdsInPrompt` substitutes every
// artifact/vehicle/clothing NAME with the entry's `type`, so a story-language
// prop name can't be lettered onto the prop (decisions.md 2026-08-24, "A prop's
// NAME is the thing that gets painted on it"). It substituted blindly — including
// INSIDE a Visual Bible clause that declares the name as painted lettering on the
// object. Staging job_1788295892348_l028ggiq7a p1: the vehicle entry says its
// name is painted in faded gold letters on the stern transom; the sanitiser
// rewrote the name inside that clause, so the prompt ordered the model to paint
// the TYPE STRING across the transom in gold. The render came back garbled.
//
// The exception is derived from the VB entry (its own name inside its own
// lettering clause), never pattern-matched out of the outgoing prompt.

// The second bug locked down here: reference-sheet cells are described in ONE
// prompt to ONE generation call, so the same lettering clause bled ACROSS cells
// — the map cell of that story came back with legible handwriting copied from
// the ship's stern clause, although its own description says its script is
// illegible. Declared-lettering entries are therefore quarantined into solo
// calls, and a multi-cell prompt carries a no-lettering backstop line.

// @ts-expect-error - JS module without types
import { sanitizeVbIdsInPrompt, vbDeclaredLetteringNames } from '../../server/lib/promptBuilders.js';
// @ts-expect-error - JS module without types
import { buildReferenceSheetBatches } from '../../server/lib/referenceSheets.js';
import { createRequire } from 'node:module';

// Neutral fixture. VEH001 declares its name as painted lettering; VEH002 has a
// lettering clause that does NOT name the vessel; ART001 is a plain prop whose
// name is only a label (the 2026-08-24 motivating shape).
const visualBible = {
  mainCharacters: [{ id: 'CHR001', name: 'Nora' }],
  animals: [],
  artifacts: [
    {
      id: 'ART001',
      name: 'Alte Seekarte',
      type: 'hand-drawn chart on aged parchment',
      description:
        'a single sheet of aged parchment roughly 40 cm wide, ivory-yellow with brown water-stain patches near the edges, all writing is illegible weathered script',
    },
  ],
  vehicles: [
    {
      id: 'VEH001',
      name: 'Nordwind',
      type: 'two-masted wooden sailing ship, brigantine-style',
      description:
        "a two-masted wooden sailing ship roughly 25 metres long, the hull painted deep forest green, the ship's name 'Nordwind' painted in faded gold letters on the stern transom, two tall wooden masts with off-white canvas sails",
    },
    {
      id: 'VEH002',
      name: 'Sturmklinge',
      type: 'two-masted wooden sailing ship, topsail schooner-style',
      description:
        "a two-masted wooden sailing ship slightly longer and narrower than the Nordwind, the hull painted flat black, the ship's name in small weathered dark red letters on the stern transom, no figurehead at the bow",
    },
  ],
  clothing: [],
  locations: [],
  secondaryCharacters: [],
};

describe('vbDeclaredLetteringNames', () => {
  it('exempts only the name the VB draws onto its own element', () => {
    const exempt = vbDeclaredLetteringNames(visualBible);
    expect(exempt.has('nordwind')).toBe(true);
    // Lettering clause exists, but it never names the vessel — nothing declared.
    expect(exempt.has('sturmklinge')).toBe(false);
    // A cross-reference to 'Nordwind' inside VEH002's description must not
    // qualify VEH002.
    expect(exempt.has('alte seekarte')).toBe(false);
    expect(exempt.size).toBe(1);
  });

  it('returns an empty set for a missing or malformed visual bible', () => {
    expect(vbDeclaredLetteringNames(null).size).toBe(0);
    expect(vbDeclaredLetteringNames({}).size).toBe(0);
    expect(vbDeclaredLetteringNames({ vehicles: 'not an array' }).size).toBe(0);
  });
});

describe('sanitizeVbIdsInPrompt — VB-lettering exception', () => {
  it('(a) keeps a declared-lettering name intact', () => {
    const out = sanitizeVbIdsInPrompt(
      'Nora stands at the rail of the Nordwind as the harbour slides past.',
      visualBible,
      1
    );
    expect(out).toContain('Nordwind');
    expect(out).not.toContain('brigantine-style');
  });

  it('(b) still substitutes a name the VB never declared as lettering', () => {
    const out = sanitizeVbIdsInPrompt(
      'The Sturmklinge closes from windward while Nora unrolls the Alte Seekarte.',
      visualBible,
      2
    );
    expect(out).not.toContain('Sturmklinge');
    expect(out).toContain('topsail schooner-style');
    expect(out).not.toContain('Alte Seekarte');
    expect(out).toContain('hand-drawn chart on aged parchment');
    // Character names are identity anchors and are never touched.
    expect(out).toContain('Nora');
  });

  it('(c) round-trips the stern-lettering clause without corrupting it', () => {
    const sternClause =
      "the ship's name 'Nordwind' painted in faded gold letters on the stern transom";
    const out = sanitizeVbIdsInPrompt(
      `A wide stern view of VEH001. ${sternClause}.`,
      visualBible,
      1
    );
    expect(out).toContain(sternClause);
    // The VB id itself is still resolved away — only the NAME is exempt.
    expect(out).not.toContain('VEH001');
  });

  it('leaves the 2026-08-24 protection in place when no entry declares lettering', () => {
    const plainBible = { ...visualBible, vehicles: [visualBible.vehicles[1]] };
    const out = sanitizeVbIdsInPrompt(
      'Nora hides the Alte Seekarte aboard the Sturmklinge.',
      plainBible,
      4
    );
    expect(out).not.toContain('Alte Seekarte');
    expect(out).not.toContain('Sturmklinge');
  });
});

describe('buildReferenceSheetBatches — lettering quarantine', () => {
  // What generateReferenceSheet works on: VB entries flattened with a type.
  const el = (entry: any, type: string) => ({ ...entry, type, pageCount: 3 });
  const plainProps = Array.from({ length: 4 }, (_, i) => ({
    id: `ART10${i}`,
    name: `Requisite ${i}`,
    type: 'artifact',
    description: 'a plain wooden object with no markings of any kind',
    pageCount: 2,
  }));

  it('puts a declared-lettering entry in its own batch and leaves the rest batched', () => {
    const needsReference = [
      el(visualBible.artifacts[0], 'artifact'),   // illegible script — batchable
      ...plainProps,
      el(visualBible.vehicles[0], 'vehicle'),     // declares its name as stern lettering
      el(visualBible.vehicles[1], 'vehicle'),     // lettering clause, but unnamed — batchable
    ];
    const batches = buildReferenceSheetBatches(needsReference, visualBible, 4);
    const names = batches.map((b: any[]) => b.map(e => e.name));

    // Six batchable elements → two balanced batches of three; the lettering
    // vehicle rides alone, last.
    expect(names.map(n => n.length)).toEqual([3, 3, 1]);
    expect(names[2]).toEqual(['Nordwind']);
    expect(names.flat()).toHaveLength(needsReference.length);
    expect(new Set(names.flat()).size).toBe(needsReference.length);
    // The poisoned pairing must not recur: the map never shares with the ship.
    const mapBatch = batches.find((b: any[]) => b.some(e => e.name === 'Alte Seekarte'));
    expect(mapBatch.some((e: any) => e.name === 'Nordwind')).toBe(false);
  });

  it('keeps the balanced distribution unchanged when nothing declares lettering', () => {
    const needsReference = [...plainProps, el(visualBible.artifacts[0], 'artifact')];
    const batches = buildReferenceSheetBatches(needsReference, visualBible, 4);
    expect(batches.map((b: any[]) => b.length)).toEqual([3, 2]);
  });

  it('tolerates a missing visual bible and an unnamed element', () => {
    const batches = buildReferenceSheetBatches([{ id: 'ART900' }, ...plainProps], null, 4);
    expect(batches.map((b: any[]) => b.length)).toEqual([3, 2]);
  });
});

describe('buildReferenceSheetPrompt — cross-cell backstop', () => {
  const guard = 'Each cell shows only its own element';
  // Templates are read from prompts/ at boot, not at import — and the loader
  // has to run in the SAME CommonJS registry the builder resolves through, so
  // both come from one createRequire.
  const cjs = createRequire(import.meta.url);
  let build: any;
  beforeAll(async () => {
    await cjs('../../server/services/prompts.js').loadPromptTemplates();
    build = cjs('../../server/lib/referenceSheets.js').buildReferenceSheetPrompt;
  });

  it('carries the no-lettering line on a multi-cell prompt', () => {
    const prompt = build(
      [{ ...visualBible.artifacts[0], type: 'artifact' }, { ...visualBible.vehicles[1], type: 'vehicle' }],
      'soft watercolor',
      visualBible
    );
    expect(prompt).toContain(guard);
    expect(prompt).toContain('no lettering or readable words anywhere');
  });

  it('omits it on a solo cell, so a declared-lettering element can render its own', () => {
    const prompt = build(
      [{ ...visualBible.vehicles[0], type: 'vehicle' }],
      'soft watercolor',
      visualBible
    );
    expect(prompt).not.toContain(guard);
    expect(prompt).not.toMatch(/\{[A-Z_]+\}/);
  });

  // A one-element call inherits a sheet template. Asked for "cells separated by
  // thick black gridlines", a solo render painted a black grid across the ship
  // — which would ride onto every page using that reference.
  it('strips every gridline instruction from a solo prompt', () => {
    const prompt = build(
      [{ ...visualBible.vehicles[0], type: 'vehicle' }],
      'soft watercolor',
      visualBible
    );
    // Only the NEGATIVE mention survives ("no gridlines"); nothing asks for one.
    expect(prompt).not.toMatch(/separated by[^.]*gridlines/i);
    expect(prompt).not.toMatch(/gridlines separate/i);
    expect(prompt).not.toMatch(/^Row 1:/m);
    expect(prompt).toContain('no gridlines, borders or dividing lines');
  });

  it('keeps the gridline instructions on a multi-cell prompt', () => {
    const prompt = build(
      [{ ...visualBible.artifacts[0], type: 'artifact' }, { ...visualBible.vehicles[1], type: 'vehicle' }],
      'soft watercolor',
      visualBible
    );
    expect(prompt).toMatch(/thick,? perfectly straight black gridlines/);
    expect(prompt).toContain('- Equal-sized cells separated by thick straight black gridlines');
    expect(prompt).not.toMatch(/\{[A-Z_]+\}/);
  });
});
