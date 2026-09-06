import { describe, it, expect } from 'vitest';

// The defect this file locks down (staging job_1788641639919_mpjwlzkf1):
//
// `englishEntityRef` built a VB entity's English image-facing reference by
// taking up to 12 words of the description with NO clause awareness, so every
// consumer of that ref — the sanitizeVbIdsInPrompt id→ref map, the
// consolidator input sanitising (15ebbbc59), the cover hint's
// `_artifactDescsEn` (coverIterate:58) and the id map at coverIterate:1521 —
// received a phrase cut mid-clause:
//
//   ART001 → "small hat knitted from chunky red wool, dome-shaped at the
//             crown with"        ← ends on a preposition
//   ART007 → "stack of split logs roughly a metre and a half tall and"
//                                ← ends on a conjunction, inside a half-stated
//                                  measurement
//
// The REQUIRED OBJECTS label (cb50250bb) had already solved this with its own
// private trimmer; the fix moves that logic into ONE shared helper
// (`clauseRef` in visualBible.js) that both call.
//
// Fixtures are ART001 / ART007 / ART008 verbatim from that story.

// @ts-expect-error - JS module without types
import { englishEntityRef, clauseRef } from '../../server/lib/visualBible.js';

const ART001 = {
  id: 'ART001',
  name: "Lily's red woollen hat",
  type: "children's knitted hat",
  description:
    'A small hat knitted from chunky red wool, dome-shaped at the crown with a wide turned-back brim of two finger-widths, roughly ten centimetres tall when the brim is turned up, the knit stitches visible as raised ridges across the surface, slightly misshapen from wear',
};

const ART007 = {
  id: 'ART007',
  name: 'Log pile',
  type: 'stacked firewood',
  description:
    'A stack of split logs roughly a metre and a half tall and two metres wide, the logs cut to lengths of about thirty centimetres and stacked in horizontal rows with the sawn end grain facing outward, pale cream-yellow cut faces against dark rough bark',
};

const ART008 = {
  id: 'ART008',
  name: 'Copper-coloured fallen leaves',
  type: 'autumn leaves',
  description:
    'Fallen horse chestnut and plane tree leaves in deep copper, burnt orange, and dull gold tones, roughly palm-sized, lying flat or curled at the edges on the ground, scattered unevenly across stone paving and earth',
};

const ENTRIES = [ART001, ART007, ART008];

// The exact words the old chop left refs ending on.
const FORBIDDEN_END =
  /\b(?:with|and|of|or|the|a|an|in|on|at|for|to|its|his|her|their|roughly|about|approximately|around|nearly|almost)$/i;
const BARE_COLOUR_END =
  /\b(?:red|orange|yellow|green|blue|purple|pink|brown|black|white|grey|gray|silver|gold|golden|copper|bronze|amber|cream|beige|tan|navy|dark|light|pale|deep|bright)$/i;

describe('englishEntityRef is a whole clause, never a mid-phrase chop', () => {
  it('no ref ends on a conjunction, preposition, article or approximator', () => {
    for (const entry of ENTRIES) {
      const ref = englishEntityRef(entry, 'object');
      expect(ref, `${entry.id}: ${ref}`).not.toMatch(FORBIDDEN_END);
    }
  });

  it('no ref ends on a bare colour or material modifier', () => {
    for (const entry of ENTRIES) {
      const ref = englishEntityRef(entry, 'object');
      expect(ref, `${entry.id}: ${ref}`).not.toMatch(BARE_COLOUR_END);
    }
  });

  it('every ref still carries its head noun', () => {
    expect(englishEntityRef(ART001, 'object')).toMatch(/\bwool\b/);
    expect(englishEntityRef(ART007, 'object')).toMatch(/\blogs\b/);
    expect(englishEntityRef(ART008, 'object')).toMatch(/\bleaves\b/);
  });

  it('reproduces the two measured defects and shows them gone', () => {
    expect(englishEntityRef(ART001, 'object')).toBe('small hat knitted from chunky red wool');
    expect(englishEntityRef(ART007, 'object')).toBe('stack of split logs');
    expect(englishEntityRef(ART008, 'object')).toBe('Fallen horse chestnut and plane tree leaves');
  });

  it('falls back to the pool-generic noun with no usable description', () => {
    // Contract relied on by tests/manual/test-cover-prompt-builder.js.
    expect(englishEntityRef({ name: 'Goldene Medaille' }, 'object')).toBe('object');
    expect(englishEntityRef(null, 'vehicle')).toBe('vehicle');
  });

  it('keeps the leading article stripped and the following case untouched', () => {
    // "A small hat …" → lowercase lead; "Fallen horse …" keeps its capital.
    expect(englishEntityRef(ART001, 'object').startsWith('small')).toBe(true);
    expect(englishEntityRef(ART008, 'object').startsWith('Fallen')).toBe(true);
  });
});

describe('the type field is preferred for a non-English story', () => {
  it('uses the short English type when the story language is not English', () => {
    expect(englishEntityRef(ART001, 'object', { language: 'de-ch' })).toBe("children's knitted hat");
    expect(englishEntityRef(ART007, 'object', { language: 'fr' })).toBe('stacked firewood');
  });

  it('keeps the description clause for an English story and when no language is threaded', () => {
    expect(englishEntityRef(ART007, 'object', { language: 'en-gb' })).toBe('stack of split logs');
    expect(englishEntityRef(ART007, 'object')).toBe('stack of split logs');
  });

  it('ignores a long type and a bare pool-category type', () => {
    const longType = { ...ART007, type: 'a very tall stack of seasoned split firewood logs' };
    expect(englishEntityRef(longType, 'object', { language: 'de' })).toBe('stack of split logs');
    const poolType = { ...ART007, type: 'artifact' };
    expect(englishEntityRef(poolType, 'object', { language: 'de' })).toBe('stack of split logs');
  });
});

describe('clauseRef edge cases the VB pools actually produce', () => {
  it('absorbs a one-token opening clause instead of returning it alone', () => {
    // Location descriptions open with a bare "indoor," / "outdoor," token.
    expect(clauseRef('indoor, ground-floor flat interior. Colors: warm cream walls')).toBe(
      'indoor, ground-floor flat interior'
    );
  });

  it('strips the landmark "[scope, season, time]" tag', () => {
    expect(
      clauseRef('[whole, green, day] Covered wooden bridge with characteristic twin oval windows spanning turquoise river; stone structures')
    ).toBe('Covered wooden bridge with characteristic twin oval windows spanning turquoise river');
  });

  it('keeps a COMPLETE measurement clause but drops one a word cap cut into', () => {
    expect(clauseRef('A single horse chestnut roughly four centimetres across, its outer shell split open')).toBe(
      'single horse chestnut roughly four centimetres across'
    );
    // A 12-word clause fits the cap, so it survives whole …
    expect(clauseRef('A wide cylindrical ceramic mug roughly nine centimetres tall and eight centimetres across, plain white')).toBe(
      'wide cylindrical ceramic mug roughly nine centimetres tall and eight centimetres across'
    );
    // … but ART007's 15-word clause is cut mid-measurement, so the whole
    // measurement tail goes and the ref keeps the noun phrase before it.
    expect(clauseRef(ART007.description)).toBe('stack of split logs');
  });

  it('extends past a trailing modifier to the noun it qualifies (the label cap, maxWords 6)', () => {
    expect(clauseRef('small hat knitted from chunky red wool', { maxWords: 6, hardCap: 10 })).toBe(
      'small hat knitted from chunky red wool'
    );
  });

  it('returns an empty string for empty input', () => {
    expect(clauseRef('')).toBe('');
    expect(clauseRef(null)).toBe('');
  });
});
