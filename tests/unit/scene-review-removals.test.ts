import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseCastRemovals, diffCastRemovals } = require('../../server/lib/sceneReviewGuard.js');

const root = path.resolve(__dirname, '../..');

// ── OWNER DECISION 2 (2026-09-13) — the declared-removals channel ──
// Evidence: job_1789207854566_l43qgl34w p7/p15, where the reviewer rewrote five
// commissioned characters into "five soaked pirates: one in a blue tricorn, one
// tall in an orange tricorn…" and shipped `characters: []` / `["Fiona"]` with no
// delta and no reason. Only the `FAULTED PAGES:` line was ever parsed.

describe('parseCastRemovals — the REMOVED CAST line', () => {
  it('reads one page with one name and its reason', () => {
    const r = parseCastRemovals('[cast_over_cap] none\nFAULTED PAGES: 4\nREMOVED CAST: 4 = Alice: the plan line stages the subject alone');
    expect(r.present).toBe(true);
    expect(r.none).toBe(false);
    expect(r.pages).toEqual([{ pageNumber: 4, names: ['Alice'], reason: 'the plan line stages the subject alone' }]);
    expect(r.malformed).toEqual([]);
  });

  it('reads several pages and several names per page', () => {
    const r = parseCastRemovals('REMOVED CAST: 4 = Alice: off-frame; 7 = Bob, Cara: imported cast');
    expect(r.pages).toEqual([
      { pageNumber: 4, names: ['Alice'], reason: 'off-frame' },
      { pageNumber: 7, names: ['Bob', 'Cara'], reason: 'imported cast' },
    ]);
  });

  it('reads NONE as "declared, nothing removed" — not as "no line"', () => {
    expect(parseCastRemovals('FAULTED PAGES: NONE\nREMOVED CAST: NONE'))
      .toEqual({ present: true, none: true, pages: [], malformed: [] });
  });

  it('reports an absent line as absent, so an older review is never read as NONE', () => {
    expect(parseCastRemovals('FAULTED PAGES: 3, 9'))
      .toEqual({ present: false, none: false, pages: [], malformed: [] });
  });

  it('collects malformed entries instead of silently dropping them', () => {
    const r = parseCastRemovals('REMOVED CAST: Alice was cut; 7 = Bob: too many figures; = : ');
    expect(r.pages).toEqual([{ pageNumber: 7, names: ['Bob'], reason: 'too many figures' }]);
    expect(r.malformed).toContain('Alice was cut');
    expect(r.malformed.length).toBe(2);
    expect(r.none).toBe(false);
  });

  it('is case-insensitive on the label and tolerates surrounding whitespace', () => {
    expect(parseCastRemovals('  removed cast:  4 = Alice: reason  ').pages.length).toBe(1);
  });
});

describe('diffCastRemovals — an undeclared removal is detectable', () => {
  const declaredNone = parseCastRemovals('REMOVED CAST: NONE');

  it('reports a page that lost cast with no declaration (the p7 shape: 5 lost)', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 7, beforeCast: ['Fiona', 'Facundo', 'Sarah', 'Saira', 'Lorena'], afterCast: [] }],
      declaredNone
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pageNumber).toBe(7);
    expect(rows[0].undeclared.length).toBe(5);
    expect(rows[0].declared).toEqual([]);
  });

  it('does NOT report a removal the reviewer declared', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 7, beforeCast: ['Alice', 'Bob'], afterCast: ['Bob'] }],
      parseCastRemovals('REMOVED CAST: 7 = Alice: the plan line does not name her')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].declared).toEqual(['alice']);
    expect(rows[0].undeclared).toEqual([]);
  });

  it('splits a page that declared one removal and hid another', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 7, beforeCast: ['Alice', 'Bob', 'Cara'], afterCast: ['Cara'] }],
      parseCastRemovals('REMOVED CAST: 7 = Alice: imported cast')
    );
    expect(rows[0].declared).toEqual(['alice']);
    expect(rows[0].undeclared).toEqual(['bob']);
  });

  it('is silent on a page that lost nobody, including one that GAINED cast', () => {
    expect(diffCastRemovals([
      { pageNumber: 1, beforeCast: ['Alice', 'Bob'], afterCast: ['Alice', 'Bob'] },
      { pageNumber: 2, beforeCast: ['Alice'], afterCast: ['Alice', 'Bob'] },
      { pageNumber: 3, beforeCast: [], afterCast: [] },
    ], declaredNone)).toEqual([]);
  });

  it('matches names case- and whitespace-insensitively on both sides', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 5, beforeCast: [' Alice ', 'Bob'], afterCast: ['bob'] }],
      parseCastRemovals('REMOVED CAST: 5 =  aLiCe : reason')
    );
    expect(rows[0].undeclared).toEqual([]);
    expect(rows[0].declared).toEqual(['alice']);
  });

  it('accepts object-shaped characters[] entries as well as bare strings', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 2, beforeCast: [{ name: 'Alice' }, { name: 'Bob' }] as any, afterCast: [{ name: 'Bob' }] as any }],
      declaredNone
    );
    expect(rows[0].undeclared).toEqual(['alice']);
  });

  it('treats an ABSENT REMOVED CAST line as "nothing declared" — every loss is undeclared', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 9, beforeCast: ['Alice'], afterCast: [] }],
      parseCastRemovals('FAULTED PAGES: 9')
    );
    expect(rows[0].undeclared).toEqual(['alice']);
  });

  // The discrimination the detector exists for (job_1789207854566_l43qgl34w):
  // p13/p16 moved CHR001 out of characters[] and kept citing it in objects[] —
  // a Visual Bible secondary carried a different way, still drawn. p7/p15 lost
  // five and four commissioned names to nothing at all.
  it('does NOT report a name that moved to objects[] (the p13/p16 secondary routing)', () => {
    expect(diffCastRemovals(
      [{ pageNumber: 13, beforeCast: ['Fiona', 'CHR001'], afterCast: ['Fiona'], afterObjects: ['ART004', 'CHR001'] }],
      declaredNone
    )).toEqual([]);
  });

  it('tells routing apart from a real loss on the same page', () => {
    const rows = diffCastRemovals(
      [{ pageNumber: 15, beforeCast: ['Fiona', 'CHR001', 'Sarah'], afterCast: ['Fiona'], afterObjects: ['CHR001'] }],
      declaredNone
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rerouted).toEqual(['chr001']);
    expect(rows[0].undeclared).toEqual(['sarah']);
    expect(rows[0].lost).toEqual(['sarah']);
  });

  it('never infers from prose — an unchanged cast with rewritten description is silent', () => {
    expect(diffCastRemovals(
      [{ pageNumber: 7, beforeCast: ['Alice', 'Bob'], afterCast: ['Alice', 'Bob'] }],
      declaredNone
    )).toEqual([]);
  });
});

// ── OWNER DECISION 1 (2026-09-13) — the cap is 6, and a recommendation ──

describe('cast cap', () => {
  const models = require(path.join(root, 'server/config/models.js'));

  it('every image model carries maxCharactersPerScene 6 (was 5)', () => {
    const vals = Object.entries(models.IMAGE_MODELS)
      .filter(([, cfg]: any) => cfg && cfg.maxCharactersPerScene !== undefined)
      .map(([k, cfg]: any) => [k, cfg.maxCharactersPerScene] as [string, number]);
    expect(vals.length).toBeGreaterThan(0);
    for (const [key, v] of vals) expect(v, key).toBe(6);
  });

  it('the production lookup path the scene reviewer is filled from yields 6, not the || 3 fallback', () => {
    // buildSceneReviewPrompt -> buildStoryContextFields ->
    // IMAGE_MODELS[modelOverrides.imageModel || MODEL_DEFAULTS.pageImage].maxCharactersPerScene
    const key = models.MODEL_DEFAULTS.pageImage;
    expect(models.IMAGE_MODELS[key], key).toBeTruthy();
    expect(models.IMAGE_MODELS[key].maxCharactersPerScene).toBe(6);
  });

  it('the scene-review template really does read that value from the placeholder', () => {
    const tpl = fs.readFileSync(path.join(root, 'prompts/scene-review.txt'), 'utf8');
    expect(tpl).toMatch(/^Max named characters per scene: \{MAX_CHARACTERS_PER_SCENE\}$/m);
  });

});

describe('scene-review.txt contract', () => {
  const tpl = fs.readFileSync(path.join(root, 'prompts/scene-review.txt'), 'utf8');
  const lineWithTag = (tag: string) => tpl.split('\n').find(l => l.includes('[' + tag + ']')) || '';

  it('declares the REMOVED CAST line in the OUTPUT FORMAT, after FAULTED PAGES', () => {
    expect(tpl).toMatch(/^REMOVED CAST: /m);
    expect(tpl.indexOf('REMOVED CAST:')).toBeGreaterThan(tpl.indexOf('FAULTED PAGES:'));
  });

  it('the figure-count check no longer prescribes anonymising the cast', () => {
    const line = lineWithTag('cast_crowded');
    expect(line, 'cast_crowded check present').toBeTruthy();
    // The remedy that produced "five soaked pirates" on p7/p15, gone.
    expect(line).not.toMatch(/one mass/i);
    expect(line).not.toMatch(/rewrite to three/i);
  });

  it('the figure-count check reads the cap from the placeholder, not a literal three', () => {
    const line = lineWithTag('cast_crowded');
    expect(line).toContain('{MAX_CHARACTERS_PER_SCENE}');
    expect(line).not.toMatch(/more than three figures/i);
  });

  it('exceeding the cap is framed as a recommendation, not a fault', () => {
    expect(lineWithTag('cast_crowded')).toMatch(/recommendation/i);
    expect(lineWithTag('cast_over_cap')).toMatch(/recommendation/i);
  });

  it('both cast checks forbid dropping or renaming a commissioned character', () => {
    expect(lineWithTag('cast_crowded')).toMatch(/never drop a character/i);
    expect(lineWithTag('cast_crowded')).toMatch(/never replace a name/i);
  });
});
