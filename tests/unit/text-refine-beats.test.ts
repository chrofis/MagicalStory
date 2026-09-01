import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import { extractRefinablePages } from '../../server/lib/textRefine.js';

/**
 * Regression for job_1788215224103 p11 (2026-09-01): the text refiner's prompt
 * told it "the beats are the story's final form" but only ever received the
 * ARC — extractRefinablePages threw away outlineExtract's BEAT text entirely.
 * The refiner reinstated an arc detail (a trapped crewman) that the beat had
 * deliberately cut for safety ("not toward any person").
 */
describe('extractRefinablePages — beat extraction', () => {
  it('extracts the BEAT line from outlineExtract, dropping the PLAN line', () => {
    const scenes = [{
      pageNumber: 11,
      text: 'shipped page text',
      sceneDescription: 'illustration prose\n\n---METADATA---\n{}',
      outlineExtract:
        'BEAT: Water seeps toward the chest, not toward any person.\n' +
        'PLAN: wide — a crewman is trapped below the slab with water seeping in',
    }];
    const [page] = extractRefinablePages(scenes);
    expect(page.beat).toContain('not toward any person');
    expect(page.beat).not.toContain('PLAN:');
    expect(page.beat).not.toContain('crewman is trapped');
  });

  it('leaves beat empty for a unified-mode page (outlineExtract is scene-intent JSON, no BEAT marker)', () => {
    const scenes = [{
      pageNumber: 1,
      text: 'shipped page text',
      sceneDescription: 'illustration prose',
      outlineExtract: '{"sceneIntent":"a character does something"}',
    }];
    const [page] = extractRefinablePages(scenes);
    expect(page.beat).toBe('');
  });

  it('leaves beat empty when outlineExtract is absent', () => {
    const scenes = [{ pageNumber: 3, text: 'shipped page text', sceneDescription: 'prose' }];
    const [page] = extractRefinablePages(scenes);
    expect(page.beat).toBe('');
  });
});
