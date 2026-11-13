/**
 * Pipeline review 2026-11-13, finding 3: the story data handed to the book review dropped
 * `mainCharacters`, so mainCharactersText fell back to the FIRST listed character and the review
 * judged the plot and buy questions against the wrong child. Three places dropped it: the
 * repair story data (buildRepairStoryData), the two auditStoryBook projections in
 * repairPipeline.js, and the admin re-run inputs (bookReviewRerun.js).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const prompts = require_('../../server/services/prompts.js');
const { buildRepairStoryData } = require_('../../server/lib/repairStoryData.js');
const ROOT = path.resolve(__dirname, '../..');

beforeAll(async () => { await prompts.loadPromptTemplates(); });

// The sibling is listed first; the story is about Lea (c2).
const inputData = {
  characters: [{ id: 'c1', name: 'Ben', age: 9 }, { id: 'c2', name: 'Lea', age: 6 }],
  mainCharacters: ['c2'],
  layout: { imageAspect: '1:1' }, artStyle: 'pixar', language: 'de',
};

describe('the review names the declared main character, not the first listed one', () => {
  it('buildRepairStoryData carries mainCharacters', () => {
    const sd = buildRepairStoryData({ inputData, sceneDescriptions: [], rawImages: [], textPositionOf: () => null } as any);
    expect(sd.mainCharacters).toEqual(['c2']);
  });

  it('the review projection built from it fills MAIN_CHARACTERS with Lea', () => {
    const sd = buildRepairStoryData({ inputData, sceneDescriptions: [], rawImages: [], textPositionOf: () => null } as any);
    // the same fields repairPipeline.js hands to auditStoryBook
    const projection = { id: 's1', visualBible: null, characters: sd.characters || [], mainCharacters: sd.mainCharacters, sceneImages: [] };
    expect(bookAudit.bookAuditStoryFill(projection).MAIN_CHARACTERS).toBe('Lea');
  });

  it('without the field the old bug is visible (Ben), so the field is what fixes it', () => {
    const projection = { id: 's1', characters: inputData.characters, sceneImages: [] };
    expect(bookAudit.bookAuditStoryFill(projection).MAIN_CHARACTERS).toBe('Ben');
  });

  it('both auditStoryBook projections in repairPipeline.js pass mainCharacters', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/repairPipeline.js'), 'utf8');
    const calls = [...src.matchAll(/return auditStoryBook\(\s*\{([^}]*)\}/g)];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[1]).toMatch(/mainCharacters: storyData\?\.mainCharacters/);
  });

  it('the admin re-run carries the stored mainCharacters', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/bookReviewRerun.js'), 'utf8');
    expect(src).toMatch(/mainCharacters: stored\.mainCharacters/);
  });
});
