import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// COVERS SHOW AN OBJECT AS THE STORY LEAVES IT (2026-09-23).
//
// No state's pages[] covers a cover (covers carry negative page numbers), so a
// cover that cited an object by its bare id fell to the DEFAULT state — the
// first row, which for a thing the story makes is its raw materials. Prod trial
// job_1790169018278_n57xpnufo: the front cover's own prose held the finished
// crown, its REQUIRED OBJECTS line said "a pile of loose unbound leaves lying
// flat", and a pile of leaves was painted on the ground.
//
// The same resolver picks the REQUIRED OBJECTS clause and the reference cell,
// so both are pinned here, plus the cover composite's prop image and the trial
// cover's reference grid, which never received any VB element at all.

const require_ = createRequire(import.meta.url);
const {
  resolveObjectState, elementRefCell, finalObjectState, isCoverPageNumber,
  getElementReferenceImagesByIds,
} = require_('../../server/lib/visualBible');
const { COVER_PAGE_NUMBERS } = require_('../../server/lib/coverKeys');
const { enrichCoverHintWithArtifacts } = require_('../../server/lib/coverIterate');
// @ts-expect-error - JS module without types
import { buildImagePrompt } from '../../server/lib/promptBuilders.js';

// Archetypal fixture: a thing the hero makes over the story.
const MADE = () => ({
  id: 'ART001',
  name: 'woven reed basket',
  type: 'basket',
  description: 'a small round basket woven from pale reeds',
  appearsInPages: [1, 2, 3, 4],
  states: [
    { id: 'ART001.1', name: 'loose reeds', delta: 'a bundle of loose unwoven reeds lying flat', pages: [1, 2], held: null,
      referenceImageUrl: 'https://r2/state1.jpg' },
    { id: 'ART001.2', name: 'finished basket', delta: 'reeds woven into a closed round basket', pages: [3, 4], held: null,
      referenceImageUrl: 'https://r2/state2.jpg' },
  ],
});

const bible = () => ({
  mainCharacters: [{ id: 'CHR001', name: 'Ada' }],
  secondaryCharacters: [], animals: [], vehicles: [], clothing: [], locations: [],
  artifacts: [MADE()],
});

const coverScene = (objects: string[]) =>
  `A portrait of a single character.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'cover',
    characters: [{ name: 'Ada', position: 'center', depth: 'foreground' }],
    shot: 'wide',
    objects,
  })}`;

const requiredObjectsBlock = (prompt: string) => {
  const m = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|$)/i);
  return m ? m[1] : '';
};

describe('isCoverPageNumber / finalObjectState', () => {
  it('recognises exactly the three cover numbers', () => {
    for (const n of Object.values(COVER_PAGE_NUMBERS)) expect(isCoverPageNumber(n)).toBe(true);
    expect(isCoverPageNumber(1)).toBe(false);
    expect(isCoverPageNumber(-4)).toBe(false);
    expect(isCoverPageNumber(null)).toBe(false);
  });
  it('the final state is the last row; a state-less entry has none', () => {
    expect(finalObjectState(MADE()).id).toBe('ART001.2');
    expect(finalObjectState({ id: 'ART009' })).toBeNull();
  });
});

describe('resolveObjectState on a cover', () => {
  it('a bare citation resolves to the FINAL state on every cover', () => {
    for (const n of Object.values(COVER_PAGE_NUMBERS)) {
      expect(resolveObjectState(MADE(), 'ART001', n, null, { silent: true }).state.id).toBe('ART001.2');
    }
  });
  it('a dotted handle the cover cites wins', () => {
    expect(resolveObjectState(MADE(), 'ART001.1', -1, null, { silent: true }).state.id).toBe('ART001.1');
  });
  it('story pages are unchanged: the bible page table decides', () => {
    expect(resolveObjectState(MADE(), 'ART001', 1, null, { silent: true }).state.id).toBe('ART001.1');
    expect(resolveObjectState(MADE(), 'ART001', 4, null, { silent: true }).state.id).toBe('ART001.2');
  });
});

describe('the cover prompt and its references name the same final state', () => {
  it('REQUIRED OBJECTS on the front cover carries the final delta, not the raw materials', () => {
    const block = requiredObjectsBlock(
      buildImagePrompt(coverScene(['ART001']), { language: 'en' }, null, bible(), COVER_PAGE_NUMBERS.frontCover, null, {}),
    );
    expect(block).toContain('woven into a closed round basket');
    expect(block).not.toContain('loose unwoven reeds');
  });
  it('the reference cell is the final state cell', () => {
    expect(elementRefCell(MADE(), 'ART001', -1).cell.referenceImageUrl).toBe('https://r2/state2.jpg');
    expect(getElementReferenceImagesByIds(bible(), ['ART001'], -1)[0].referenceImageUrl).toBe('https://r2/state2.jpg');
    // a page keeps its own declared state
    expect(getElementReferenceImagesByIds(bible(), ['ART001'], 1)[0].referenceImageUrl).toBe('https://r2/state1.jpg');
  });
  it('the cover composite prop image is the final state cell, and a dotted citation still wins', () => {
    const vb = bible();
    expect(enrichCoverHintWithArtifacts({ objects: ['ART001'] }, vb, { coverKey: 'frontCover' })._artifactImages.ART001)
      .toBe('https://r2/state2.jpg');
    expect(enrichCoverHintWithArtifacts({ objects: ['ART001.1'] }, vb, { coverKey: 'backCover' })._artifactImages.ART001)
      .toBe('https://r2/state1.jpg');
  });
  it('enrichCoverHintWithArtifacts refuses to guess which cover it is', () => {
    expect(() => enrichCoverHintWithArtifacts({ objects: ['ART001'] }, bible(), {})).toThrow(/coverKey/);
  });
});
