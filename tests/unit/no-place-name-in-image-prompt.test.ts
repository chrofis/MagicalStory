/**
 * NO PLACE NAME IN AN IMAGE PROMPT (docs/decisions.md 2026-10-09).
 *
 * Staging trials job_1791531511694_j945yhw9a p6 ("Kirche Rohrdorf"),
 * job_1791496201302_6vgktllu5 p2 ("Fislisbach (Stadt)") and
 * job_1791551303368_hle970nmc p2 ("Kirche Rohrdorf") each carried a painted
 * caption that was an exact match to the name in the prompt's "Setting:" line.
 * The place is identified by its reference photo and described by what it looks
 * like; its proper NAME is text the model letters onto the page.
 * Pins behaviour, never prompt wording. Archetypal fixtures.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { buildTextFromJson } = require_('../../server/lib/sceneMetadata');
const { englishLocationRef } = require_('../../server/lib/visualBible');
const { labelOf } = require_('../../server/lib/vbLabel');

const REAL: any = {
  id: 'LOC001', name: 'Hollin Chapel (Town)', isRealLandmark: true,
  setting: 'outdoor meadow beside a modern chapel',
  features: 'plain white chapel with a detached tall bell pillar',
  colors: 'white concrete, green grass',
  signatureElement: 'tall bell pillar standing apart from the chapel',
};
const INVENTED: any = {
  id: 'LOC002', name: 'Foggy Summit', isRealLandmark: false,
  setting: 'outdoor hilltop', features: 'flat rocky hilltop in fog',
};
const VB: any = { locations: [REAL, INVENTED], mainCharacters: [], secondaryCharacters: [], animals: [], artifacts: [], vehicles: [], clothing: [] };

describe('the Setting line of a JSON scene (trial and iterate prompts)', () => {
  it('carries no place name when the description says what the place looks like', () => {
    const line = buildTextFromJson({ setting: { location: 'Hollin Chapel (Town) [LOC001]', description: 'Meadow edge with leaf piles, plain white chapel' } });
    expect(line).toBe('Setting: Meadow edge with leaf piles, plain white chapel');
  });
  it('keeps the location only when there is no description (the prompt-level mask then swaps the name)', () => {
    expect(buildTextFromJson({ setting: { location: 'Hollin Chapel (Town) [LOC001]' } })).toBe('Setting: Hollin Chapel');
  });
});

describe('englishLocationRef / labelOf are name-free', () => {
  it('describes the place: setting kind, then its visual fields', () => {
    const ref = englishLocationRef(REAL);
    expect(ref).toContain('outdoor meadow beside a modern chapel');
    expect(ref).toContain('detached tall bell pillar');
    expect(ref).not.toContain('Hollin');
  });
  it('a place with nothing visual yields null, never its name', () => {
    expect(englishLocationRef({ name: 'Hollin Chapel' })).toBeNull();
  });
  it('labelOf never returns a location name, real or invented', () => {
    expect(labelOf(REAL)).not.toContain('Hollin');
    expect(labelOf(INVENTED)).not.toContain('Foggy');
  });
});

describe('sanitizeVbIdsInPrompt keeps a real place name out of the prompt', () => {
  it('resolves the location id to its description, not its name', () => {
    const out = PB.sanitizeVbIdsInPrompt('Ana runs across the meadow at LOC001.', VB, 3);
    expect(out).toContain('bell pillar');
    expect(out).not.toContain('Hollin');
  });
  it('masks the name where the Art Director wrote it into prose or an Objects line', () => {
    const out = PB.sanitizeVbIdsInPrompt(
      'Ana kneels in front of the white Hollin Chapel, scooping leaves.\nObjects: Yellow jacket: in arms; hollin chapel: background',
      VB, 3);
    expect(out).not.toMatch(/hollin/i);
    expect(out).toContain('Ana kneels in front of the white');
    expect(out).toContain('Yellow jacket: in arms');
  });
  it('swallows a repeated noun instead of doubling it', () => {
    const v: any = { ...VB, locations: [{ ...REAL, label: 'stone square', name: 'Oakhill' }] };
    expect(PB.sanitizeVbIdsInPrompt('Ana stands on the Oakhill square.', v, 3)).toBe('Ana stands on the stone square.');
  });
  it('leaves quoted required text alone (a cover title may contain a place name)', () => {
    const p = 'Paint "The Secret of Hollin Chapel" in the upper third of the canvas.';
    expect(PB.sanitizeVbIdsInPrompt(p, VB, -1)).toBe(p);
  });
  it('does not touch an invented place name, which is the story\'s own descriptive wording', () => {
    expect(PB.sanitizeVbIdsInPrompt('Ana climbs the Foggy Summit.', VB, 3)).toBe('Ana climbs the Foggy Summit.');
  });
  it('leaves a name shorter than four characters alone', () => {
    const v: any = { ...VB, locations: [{ ...REAL, name: 'Zoo' }] };
    expect(PB.sanitizeVbIdsInPrompt('Ana visits the Zoo.', v, 3)).toBe('Ana visits the Zoo.');
  });
});

describe('the landmark fidelity block names no place', () => {
  it('both branches cite the photo, neither prints the name', () => {
    for (const photoType of [null, 'exterior', 'distant', 'view-from']) {
      const block = PB.buildLandmarkFidelityBlock({ name: 'Hollin Chapel', photoType });
      expect(block).toContain('reference photo');
      expect(block).not.toContain('Hollin');
    }
    expect(PB.buildLandmarkFidelityBlock({})).toBe('');
  });
});
