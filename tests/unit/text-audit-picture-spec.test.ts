import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveTextStagePictureSpec, buildTextStagePictureSpecs } = require('../../server/lib/sceneMetadata.js');
const { extractRefinablePages } = require('../../server/lib/textRefine.js');

// BEHAVIOUR PINNED: the arc-informed text auditor and the refine judge a page
// against THE SAME PICTURE SPEC THE WRITER WROTE IT FROM.
//
// History: the auditor once saw a 600-char head cut of the brief while the
// writer read it whole, and filed MISMATCH faults against events it could not
// see. Since 2026-09-23 (owner: keep clothing, but shrunk) every text-stage
// reader gets the compact spec built from the brief's METADATA — where, what
// happens, who wears what in short form — by one builder, so the three can
// never read different things.

const META = {
  sceneIntent: 'The grandmother lifts the copper lantern off its hook while the dog bolts for the gate.',
  characters: [{ name: 'Grandmother', clothing: 'standard', expression: 'calm, focused' }],
  interactions: [{ character: 'Grandmother', object: 'ART001', where: 'lifts the lantern off its hook', action: 'taking the lantern' }],
  objects: ['LOC001', 'ART001'],
};
const PROSE = 'Wide shot of a rain-dark courtyard at dusk. '.repeat(10) + 'The grandmother, in a long grey wool coat with brass buttons and black boots, lifts the lantern.';
const WITH_METADATA = `${PROSE}\n---METADATA---\n${JSON.stringify(META)}`;
const STORY = {
  visualBible: {
    locations: [{ id: 'LOC001', name: 'the courtyard' }],
    artifacts: [{ id: 'ART001', name: 'copper lantern' }],
  },
  clothingRequirements: { Grandmother: { standard: { used: true, description: 'A long grey wool coat with brass buttons, black trousers, and black boots.' } } },
};

const beatsScene = {
  pageNumber: 4,
  text: 'Grandmother reached up for the lantern, and the dog shot away into the rain.',
  sceneDescription: WITH_METADATA,
  outlineExtract: 'PLAN: the grandmother takes down the lantern as the dog bolts',
};

describe('one picture spec for the writer, the audit and the refine', () => {
  it('a beats page reaches the auditor as the compact spec, never the prose', () => {
    const [page] = extractRefinablePages([beatsScene], STORY);
    const spec = resolveTextStagePictureSpec(page);
    expect(spec).toContain('WHERE: the courtyard');
    expect(spec).toContain('lifts the copper lantern');
    expect(spec).toContain('Grandmother: wears long grey wool coat, black trousers, black boots');
    expect(spec).toContain('ALSO IN VIEW: copper lantern');
    expect(spec).not.toContain('brass buttons');
    expect(spec).not.toContain('Wide shot');
    expect(spec!.length).toBeLessThan(PROSE.length);
  });

  it('the auditor, the writer and the repairer read one identical spec', () => {
    const [page] = extractRefinablePages([beatsScene], STORY);
    const writerSpec = buildTextStagePictureSpecs([{ pageNumber: 4, brief: beatsScene.sceneDescription }], STORY).get(4);
    expect(resolveTextStagePictureSpec(page)).toBe(writerSpec);
  });

  it('METADATA is never shown to a text-stage reader', () => {
    expect(resolveTextStagePictureSpec({ sceneDescription: WITH_METADATA })).not.toContain('METADATA');
  });

  it('a brief with no METADATA gets no spec, and says so', () => {
    const spec = buildTextStagePictureSpecs([{ pageNumber: 1, brief: PROSE }], STORY).get(1);
    expect(spec).toBe('(no picture spec recorded for this page)');
  });
});

describe('Lab audit replay == production', () => {
  it('the replay resolves the same spec and plan line from the stored row that production does in flight', () => {
    const stored = { ...beatsScene, sceneIntent: 'a lantern, a dog' };
    const [replayPage] = extractRefinablePages([stored], STORY);
    const [productionPage] = extractRefinablePages([beatsScene], STORY);
    expect(resolveTextStagePictureSpec(replayPage)).toBe(resolveTextStagePictureSpec(productionPage));
    expect(replayPage.planLine).toBe(productionPage.planLine);
  });

  it('the replay call site passes the arc, its hints and the story records the spec is built from', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(new URL('../../server/lib/testlab.js', import.meta.url), 'utf8');
    expect(src).toContain('H.buildTextAuditPrompt(storyData, pages, arc, { arcHints: resolveReplayArcHints(storyData) })');
    expect(src).toContain('const pages = extractRefinablePages(storyData.sceneImages || [], { visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });');
  });
});
