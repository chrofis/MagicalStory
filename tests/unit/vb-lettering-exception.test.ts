import { describe, it, expect } from 'vitest';

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

// @ts-expect-error - JS module without types
import { sanitizeVbIdsInPrompt, vbDeclaredLetteringNames } from '../../server/lib/promptBuilders.js';

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
