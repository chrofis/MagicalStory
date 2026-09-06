/**
 * VB-ID LEAK — regression suite.
 *
 * Raw Visual Bible ids (CHR/ANI/ART/LOC/VEH/CLO + digits, optionally a `.N`
 * vantage suffix) must never reach a model in free text it is asked to write
 * from. The leak has been "fixed" five times, each time by adding
 * `sanitizeVbIdsInPrompt` to one more GENERATION prompt, and each time it came
 * back through a path nobody had sanitised.
 *
 * The fixture is real staging data from `job_1788641639919_mpjwlzkf1` — the
 * story where the feedback consolidator was shown
 * `"objects": ["LOC006","ART001","ART007","LOC005.1"]` and copied that array
 * verbatim into `scene_fix.preserve`.
 */
import { describe, it, expect } from 'vitest';
import fixture from './fixtures/vb-id-leak-job_1788641639919.json';

const { assertNoVbIds, findVbIds, scrubVbIds, formatInteractionsBlock } =
  require('../../server/lib/vbIdGuard');
const { sanitizeVbIdsInPrompt } = require('../../server/lib/promptBuilders');
const { buildFeedbackInput } = require('../../server/lib/feedbackConsolidator');
const { buildLandmarkComplianceBlock } = require('../../server/lib/landmarkProtection');

const VB: any = fixture.visualBible;

describe('vbIdGuard.findVbIds', () => {
  it('matches the dotted vantage form as one id, not an id plus a stray suffix', () => {
    expect(findVbIds('objects: ["LOC006", "ART001", "LOC005.1"]'))
      .toEqual(['LOC006', 'ART001', 'LOC005.1']);
  });

  it('assertNoVbIds throws with the offending ids named', () => {
    expect(() => assertNoVbIds('keep LOC006 out', 'x')).toThrow(/LOC006/);
    expect(() => assertNoVbIds('nothing to see here', 'x')).not.toThrow();
  });
});

describe('sanitizeVbIdsInPrompt — vantage suffixes', () => {
  it('resolves LOC005.1 to the location, leaving no dangling ".1"', () => {
    const out = sanitizeVbIdsInPrompt('The scene is staged at LOC005.1 at dusk.', VB, 8);
    assertNoVbIds(out, 'sanitised vantage line');
    expect(out).toContain('The chestnut path to the Holzbrücke');
    // The old pattern matched only `LOC005` and glued the leftover onto the
    // substituted name — the exact token an image model letters onto the page.
    expect(out).not.toContain('Holzbrücke.1');
    expect(out).not.toMatch(/\.\d\b/);
  });

  it('falls back to the parent location for a vantage the bible does not list', () => {
    const out = sanitizeVbIdsInPrompt('Framed from LOC005.9.', VB, 8);
    assertNoVbIds(out, 'unknown vantage');
    expect(out).toContain('The chestnut path to the Holzbrücke');
  });

  it('still resolves the bare id and orphans to a generic noun', () => {
    // (The prop-NAME pass then rewrites "log pile" to ART007's type — a
    // pre-existing behaviour of the name substitution, not part of this fix.)
    expect(sanitizeVbIdsInPrompt('at LOC006', VB, 8)).toMatch(/^at Inside the .+ gap$/);
    const orphan = sanitizeVbIdsInPrompt('holding the ART099', VB, 8);
    assertNoVbIds(orphan, 'orphan id');
    expect(orphan).toContain('object');
  });
});

describe('feedback consolidator input — p8 of job_1788641639919_mpjwlzkf1', () => {
  const build = (visualBible: any) => buildFeedbackInput({
    sceneDescription: fixture.p8Brief,
    // The findings the evaluators actually produced for this page, in the
    // shape buildFeedbackInput renders them.
    semanticIssues: [
      { severity: 'MAJOR', type: 'object_presence', item: 'ART001',
        problem: 'Red hat placed outside the log pile instead of in front of the foot' },
    ],
    characterDescriptions: { Lily: 'a preschooler girl', Ethan: 'a young school-age boy' },
    landmarkProtection: { protect: true, landmarkPresent: true,
      names: ['The chestnut path to the Holzbrücke'] },
    visualBible,
  });

  it('LEAKED before the fix: the raw brief metadata reaches the model', () => {
    // The pre-fix behaviour, reproduced by withholding the bible.
    const leaked = build(null);
    expect(findVbIds(leaked)).toEqual(
      expect.arrayContaining(['LOC006', 'ART001', 'ART007', 'LOC005.1']));
  });

  it('is free of VB ids once the bible is passed', () => {
    assertNoVbIds(build(VB), 'consolidator input');
  });

  it('keeps the scene contract intact — the objects list still names things', () => {
    const clean = build(VB);
    expect(clean).toContain('knitted from chunky red wool');   // ART001 resolved
    expect(clean).toMatch(/Inside the .*gap/);                 // LOC006 resolved
    expect(clean).toContain('---METADATA---');                 // structure preserved
    expect(clean).toContain('"objects"');                      // the field survives
  });

  it('the landmark-protection block carries no echoable word list', () => {
    const clean = build(VB);
    // The six nouns the model copied straight into scene_fix.preserve.
    for (const w of ['skyline', 'masts', 'antennas']) {
      expect(clean.toLowerCase()).not.toContain(w);
    }
    expect(clean).toContain('The chestnut path to the Holzbrücke');
  });
});

describe('inpaint edit instruction — p8', () => {
  it('is free of VB ids after the chokepoint sanitise', () => {
    // The shape images.js assembles from the consolidated plan before
    // sanitizeVbIdsInPrompt runs on it.
    const instruction = [
      '1. Restage inside LOC006 with the timber frame of LOC005.1 behind.',
      '2. For the preschooler girl: place ART001 in front of her right foot.',
      '3. Keep ART007 visible behind the figures.',
    ].join('\n');
    expect(findVbIds(instruction).length).toBe(4);
    assertNoVbIds(sanitizeVbIdsInPrompt(instruction, VB, 8), 'inpaint instruction');
  });
});

describe('page image prompt — p3', () => {
  it('the stored brief is free of VB ids after the buildImagePrompt chokepoint', () => {
    expect(findVbIds(fixture.p3Brief).length).toBeGreaterThan(0);
    assertNoVbIds(sanitizeVbIdsInPrompt(fixture.p3Brief, VB, 3), 'p3 image prompt');
  });
});

describe('shared INTERACTIONS_BLOCK builder', () => {
  const interactions = [
    { character: 'Lily', object: 'ART001', where: 'sits with her hat in front of her right foot' },
    { character: 'Ethan', object: 'Lily', where: "grips Lily's left wrist" },
  ];

  it('resolves ids when a bible is available', () => {
    const block = formatInteractionsBlock(interactions, VB);
    assertNoVbIds(block, 'interactions block (with bible)');
    expect(block).toContain('knitted from chunky red wool');
  });

  it('falls back to a generic noun when the evaluator has no bible', () => {
    const block = formatInteractionsBlock(interactions, null);
    assertNoVbIds(block, 'interactions block (no bible)');
    expect(block).toContain('the object');
    expect(block).toContain("grips Lily's left wrist");
  });

  it('returns the sentinel for an empty list', () => {
    expect(formatInteractionsBlock([], VB)).toBe('(none declared)');
    expect(formatInteractionsBlock(null, VB)).toBe('(none declared)');
  });
});

describe('scrubVbIds', () => {
  it('never leaves an id behind, with or without a bible', () => {
    const text = 'LOC005.1 holds ART007 next to CHR002 and VEH001 and CLO003.';
    assertNoVbIds(scrubVbIds(text, VB), 'scrubbed (bible)');
    assertNoVbIds(scrubVbIds(text, null), 'scrubbed (no bible)');
  });
});

describe('landmark compliance block', () => {
  it('names the landmark without enumerating structures', () => {
    const block = buildLandmarkComplianceBlock({
      protect: true, landmarkPresent: true, names: ['The Stadtturm square'],
    });
    expect(block).toContain('The Stadtturm square');
    for (const w of ['skyline', 'masts', 'antennas', 'signage']) {
      expect(block.toLowerCase()).not.toContain(w);
    }
  });
});
