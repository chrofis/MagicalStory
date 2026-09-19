import { describe, it, expect } from 'vitest';

// A page whose only cast is a Visual Bible SECONDARY character — no main cast at
// all — gets an empty-scene backdrop plate like any other page. Owner ruling,
// 2026-09-14: consistency over saving the image call.
//
// The hazard this pins is the empty-vs-absent trap. Such a page stores
// `sceneCharacters: []` — the key is PRESENT and EMPTY — next to a populated
// `sceneCharacterClothing` naming the secondary. Anything that decided "does
// this page need a plate?" by truthiness on `sceneCharacters` would read cast 0
// and route the page down the deliberate cast-0 no-plate branch, silently
// stripping the style anchor from a page that has a figure to place on it.
// `pageCastSize()` must keep reading the Art Director's roster
// (`sceneMetadata.fullData.characters`), which DOES list the secondary.
//
// Evidence: staging story job_1789337998754_apslnsq1z pages 13/15/19 — the
// fixture is those three rows pulled verbatim. Each stores `sceneCharacters: []`,
// `sceneCharacterClothing: {"Lantern man": "standard"}`, one entry in
// fullData.characters, a ~5.7-5.9k-char emptyScenePrompt, and
// `hasEmptySceneImage: true` — i.e. the plate was generated in production.
// Across 60 staging stories, all 18 secondary-only pages (sceneCharacters: []
// AND a non-empty AD roster) have a stored plate; the 9 plateless ones are
// genuine cast-0 pages with no emptyScenePrompt at all.

// @ts-expect-error - JS module without types
import { decidePageRoute, pageCastSize } from '../../server/lib/imageRouter.js';
import rows from './fixtures/secondary-only-cast-job_1789337998754_apslnsq1z.json';

describe('secondary-character-only page — empty-scene plate', () => {
  it('the fixture really is the empty-vs-absent shape', () => {
    expect(rows.map((r: any) => r.pageNumber)).toEqual([13, 15, 19]);
    for (const row of rows as any[]) {
      // key PRESENT and EMPTY — the trap
      expect(Object.prototype.hasOwnProperty.call(row, 'sceneCharacters')).toBe(true);
      expect(row.sceneCharacters).toEqual([]);
      // ...yet a secondary IS on the page
      expect(Object.keys(row.sceneCharacterClothing)).toEqual(['Lantern man']);
      expect(row.sceneMetadata.fullData.characters).toHaveLength(1);
    }
  });

  it('counts the secondary as cast — an empty sceneCharacters[] does not zero it', () => {
    for (const row of rows as any[]) {
      expect(pageCastSize(row)).toBe(1);
    }
  });

  it('routes every such page to a plate, never to the cast-0 skip', () => {
    for (const row of rows as any[]) {
      const route = decidePageRoute(row, {}, {});
      expect(route.cast).toBe(1);
      expect(route.emptyScene).not.toBe('skip');
      expect(route.emptyScene).toBe('reuse');
    }
  });

  it('has a usable emptyScenePrompt to generate the plate from', () => {
    for (const row of rows as any[]) {
      expect(row.emptyScenePromptLength).toBeGreaterThan(1000);
      expect(row.emptyScenePromptHead.trim().length).toBeGreaterThan(0);
    }
  });

  it('matches what production actually stored — the plate exists', () => {
    for (const row of rows as any[]) {
      expect(row.hasEmptySceneImage).toBe(true);
    }
  });
});
