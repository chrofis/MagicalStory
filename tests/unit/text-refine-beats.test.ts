import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import { extractRefinablePages } from '../../server/lib/textRefine.js';

/**
 * The beats stage stopped writing beat prose (owner ruling 2026-09-02, Lab
 * #973): a page's stored `outlineExtract` is its PLAN line and nothing else,
 * and the arc is what the refiner judges the text against. Stored stories
 * written before that carry "BEAT: …/PLAN: …" and must keep loading.
 *
 * The unified-mode guard is the one that must not regress: that field holds the
 * scene expansion's own JSON there, and mistaking it for a plan line feeds the
 * refiner machine data as if it were the story's division.
 */
describe('extractRefinablePages — plan line extraction', () => {
  it('extracts the PLAN line from a plan-only outlineExtract', () => {
    const scenes = [{
      pageNumber: 11,
      text: 'shipped page text',
      sceneDescription: 'illustration prose\n\n---METADATA---\n{}',
      outlineExtract: 'PLAN: wide — the main character and a guard — the door swings open — the way through is open',
    }];
    const [page] = extractRefinablePages(scenes);
    expect(page.planLine).toContain('the door swings open');
    expect(page.planLine).not.toContain('PLAN:');
  });

  it('extracts the PLAN line from a legacy BEAT + PLAN outlineExtract', () => {
    const scenes = [{
      pageNumber: 11,
      text: 'shipped page text',
      sceneDescription: 'illustration prose',
      outlineExtract:
        'BEAT: Water seeps toward the chest, not toward any person.\n' +
        'PLAN: wide — the main character — water reaches the chest — the chest is no longer dry',
    }];
    const [page] = extractRefinablePages(scenes);
    expect(page.planLine).toContain('the chest is no longer dry');
    expect(page.planLine).not.toContain('Water seeps');
  });

  it('leaves planLine empty for a unified-mode page (outlineExtract is scene-intent JSON, no marker)', () => {
    const scenes = [{
      pageNumber: 1,
      text: 'shipped page text',
      sceneDescription: 'illustration prose',
      outlineExtract: '{"sceneIntent":"a character does something"}',
    }];
    const [page] = extractRefinablePages(scenes);
    expect(page.planLine).toBe('');
  });

  it('leaves planLine empty when outlineExtract is absent', () => {
    const scenes = [{ pageNumber: 3, text: 'shipped page text', sceneDescription: 'prose' }];
    const [page] = extractRefinablePages(scenes);
    expect(page.planLine).toBe('');
  });
});
