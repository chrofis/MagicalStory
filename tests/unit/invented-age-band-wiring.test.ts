/**
 * I11 wiring — the band reaches the BIBLE prompt and the age reaches the
 * REFERENCE SHEET, and nothing reaches the page image prompt (owner's ruling,
 * 2026-09-06: "we already generate the secondary character and use it. Why plug
 * it into the image prompt? Tell the VB to add an age.").
 *
 * Evidence story: job_1788641639919_mpjwlzkf1 — commissioned for Lily (6) and
 * Ethan (9), bible invented CHR001 "The boy in the striped scarf" at
 * "a boy of about ten", rendered 11-12 on p5.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// One CommonJS graph: promptBuilders reads PROMPT_TEMPLATES from the same
// services/prompts instance the loader below fills. An ESM `import` of both
// gives two module instances and the templates never arrive.
const require = createRequire(import.meta.url);
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const { buildStoryBibleFromBeatsPrompt, buildSceneExpansionAllPrompt } = require('../../server/lib/promptBuilders.js');
const { characterAgeCue } = require('../../server/lib/referenceSheets.js');
const { buildCharacterDescription } = require('../../server/lib/visualBible.js');
const ageBand = require('../../server/lib/inventedAgeBand.js');
const { auditVisualBibleContract } = require('../../server/lib/outlineParser/shared.js');
const { applySecondaryAgeBand, commissionedChildBand } = ageBand;

// The commissioned cast, verbatim from story_jobs.input_data of that job.
const INPUT_DATA = {
  pages: 14,
  language: 'en-gb',
  characters: [
    { id: 1, name: 'Lily', age: '6' },
    { id: 2, name: 'Ethan', age: '9' },
    { id: 3, name: 'James', age: '42' },
    { id: 4, name: 'Rachel', age: '40' },
    { id: 5, name: 'Margaret', age: '70' },
  ],
  mainCharacters: [1, 2],
};
const BEATS = Array.from({ length: 14 }, (_, i) => ({ page: i + 1, planLine: `page ${i + 1}` }));

beforeAll(async () => {
  await loadPromptTemplates();
});

describe('bible prompt carries the commissioned children band', () => {
  it('fills every placeholder — no {TOKEN} survives the build', () => {
    const prompt = buildStoryBibleFromBeatsPrompt(INPUT_DATA, BEATS);
    expect(prompt).toBeTruthy();
    expect(prompt.match(/\{[A-Z_]{3,}\}/g)).toBeNull();
  });

  // The band rides with the Visual Bible, which the ALL-PAGES Art Director
  // authors since 2026-09-11 — so this assertion follows it there.
  it('states the 6-9 band and the peer contract for this story', () => {
    const prompt = buildSceneExpansionAllPrompt(INPUT_DATA, BEATS, {});
    expect(prompt).toContain('the commissioned children are 6-9');
    expect(prompt).toContain('peer: yes');
    // The age field is a number now, not prose.
    expect(prompt).toContain('"age": [age in years as a number]');
    expect(prompt).not.toContain("a boy of about eight'");
  });

  it('an all-adult commission gets no band at all', () => {
    const adults = { ...INPUT_DATA, characters: INPUT_DATA.characters.slice(2) };
    const prompt = buildSceneExpansionAllPrompt(adults, BEATS, {});
    expect(prompt).not.toContain('PEER AGES');
    expect(prompt.match(/\{[A-Z_]{3,}\}/g)).toBeNull();
    // The wardrobe stage still builds cleanly, with no leftover placeholders.
    expect(buildStoryBibleFromBeatsPrompt(adults, BEATS).match(/\{[A-Z_]{3,}\}/g)).toBeNull();
  });
});

describe('reference sheet cell carries the age', () => {
  it('a numeric age renders as "Age N" plus the commissioned sheets\' proportions phrasing', () => {
    const cue = characterAgeCue({ type: 'character', id: 'CHR001', age: 10, description: 'x' });
    expect(cue).toContain('Age 10:');
    expect(cue).toContain('heads tall');
  });

  it('a prose age from an older bible still yields the cue', () => {
    expect(characterAgeCue({ type: 'character', age: 'a boy of about ten' })).toContain('Age 10');
  });

  it('non-characters and unreadable ages add nothing', () => {
    expect(characterAgeCue({ type: 'artifact', age: 10 })).toBe('');
    expect(characterAgeCue({ type: 'character', age: null, description: 'a scarf' })).toBe('');
  });

  it('a numeric age reads as words in the description, never a bare number', () => {
    const desc = buildCharacterDescription({ age: 10, build: 'lean and upright' });
    expect(desc.startsWith('a 10-year-old')).toBe(true);
    // A prose age from an older bible is untouched.
    expect(buildCharacterDescription({ age: 'a boy of about ten' })).toBe('a boy of about ten');
  });
});

describe('post-check clamps an out-of-band peer (stubbed bible)', () => {
  const band = commissionedChildBand(INPUT_DATA.characters); // 6-9, tolerated 5-11

  it('clamps 14 to the band ceiling, flags the entry and rebuilds the description', () => {
    const secondaries = [
      { id: 'CHR001', name: 'The boy in the striped scarf', peer: 'yes', age: 14, build: 'a boy, lean', description: 'stale' },
      { id: 'CHR002', name: 'The keeper', peer: 'no', age: 55, description: 'keeper' },
    ];
    const applied = applySecondaryAgeBand(secondaries, band, buildCharacterDescription);
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe('CHR001');
    expect(applied[0].clampedTo).toBe(11); // max 9 + tolerance 2
    expect(secondaries[0].age).toBe(11);
    expect((secondaries[0] as any).secondaryAgeClamped).toEqual({ statedAge: 14, clampedTo: 11, band: [5, 11] });
    expect(secondaries[0].description).toBe('a 11-year-old. a boy, lean');
    // The non-peer adult is untouched.
    expect(secondaries[1].age).toBe(55);
    expect((secondaries[1] as any).secondaryAgeClamped).toBeUndefined();
  });

  it('an in-band peer is left alone, and no band means no change', () => {
    const inBand = [{ id: 'CHR001', peer: 'yes', age: 8, description: 'd' }];
    expect(applySecondaryAgeBand(inBand, band, buildCharacterDescription)).toHaveLength(0);
    expect(inBand[0].age).toBe(8);
    const wild = [{ id: 'CHR001', peer: 'yes', age: 30, description: 'd' }];
    expect(applySecondaryAgeBand(wild, null, buildCharacterDescription)).toHaveLength(0);
    expect(wild[0].age).toBe(30);
  });
});

describe('the numeric-age contract keeps the VB authoring audit quiet', () => {
  it('a new-format entry (numeric age, sex in build) states both sex and age', () => {
    // The audit reads STRING prose fields only, so a numeric `age` contributes
    // nothing on its own — the description built from it has to carry it.
    const entry: any = { id: 'CHR001', name: 'The boy in the striped scarf', appearsInPages: [3, 5], age: 10, build: 'a boy, slightly tall for his age, lean and upright' };
    entry.description = buildCharacterDescription(entry);
    const findings = auditVisualBibleContract({ secondaryCharacters: [entry] }, { pageCount: 14 });
    expect(findings.filter((f: any) => f.code === 'character-missing-sex-or-age')).toHaveLength(0);
  });
});
