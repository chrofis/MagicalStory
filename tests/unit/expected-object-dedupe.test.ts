import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveExpectedObjectLabels } = require('../../server/lib/bboxDetection');

// The merge at images.js:2605-2611 feeds this resolver from TWO sources:
// scene metadata (VB ids) and the page prompt's REQUIRED OBJECTS bold names.
// Until parseVisualBibleObjects was fixed (3f46e79bc) the second source was
// always empty, so a spelling divergence between them could not fire. These
// tests pin that one element = one expectation, and that two real elements
// whose names share words stay two.
const VB = {
  artifacts: [
    { id: 'ART003', name: 'hand mirror (turned away)', label: 'hand mirror' },
    { id: 'ART007', name: 'brass lantern', label: 'brass lantern' },
  ],
  animals: [
    // An animal leads in the prompt with `entry.name`, while the resolver
    // keys it by its authored label — the measured divergence.
    { id: 'ANI001', name: 'Mother Dragon', label: 'the mother dragon' },
    { id: 'ANI002', name: 'Funkli', label: 'the dragon hatchling' },
  ],
};

describe('resolveExpectedObjectLabels — one element, one expectation', () => {
  it('collapses an id and the prompt name carrying a trailing qualifier', () => {
    // sceneMetadata says ART003; the prompt lead says "hand mirror (turned away)".
    const out = resolveExpectedObjectLabels(['ART003', 'hand mirror (turned away)'], VB);
    expect(out).toEqual(['hand mirror']);
  });

  it('collapses the animal divergence (id label vs proper name in the prompt)', () => {
    const out = resolveExpectedObjectLabels(['ANI001', 'Mother Dragon'], VB);
    expect(out).toEqual(['the mother dragon']);
  });

  it('keeps two genuinely different elements whose names share words', () => {
    const out = resolveExpectedObjectLabels(
      ['ANI001', 'Mother Dragon', 'ANI002', 'Funkli'],
      VB
    );
    expect(out).toEqual(['the mother dragon', 'the dragon hatchling']);
  });

  it('still yields an expectation for an element present in only one source', () => {
    expect(resolveExpectedObjectLabels(['ART007'], VB)).toEqual(['brass lantern']);
    expect(resolveExpectedObjectLabels(['brass lantern'], VB)).toEqual(['brass lantern']);
    // An unknown name is its own entity and passes through unchanged.
    expect(resolveExpectedObjectLabels(['a stone bench'], VB)).toEqual(['a stone bench']);
  });
});
