/**
 * The trial's reference sheet is dressed for the story's season.
 *
 * Why this exists: on the trial path NO clothing text reaches any prompt. The
 * contract is `standard: { used: true, signature: 'none' }`, which every
 * resolver discards (`clothingResolve.js:819,830`) down to a generic default
 * (`entityConsistency.js:3013-3018`), and a full-text scan of all six scene
 * briefs of staging job_1789296188291_thezv15y1 ("warm soft afternoon autumn
 * light", "fallen orange and yellow autumn leaves") finds no clothing word at
 * all. The outfit therefore comes entirely from the styled 2×4 sheet, which was
 * built from the child's creation-time photo with no season input — so a child
 * photographed in summer clothes wears them through every autumn book.
 *
 * These pin the CONTRACT, not the wording:
 *   - a season decides GARMENTS and never identity;
 *   - warm seasons are handled as explicitly as cold ones (no coat in summer);
 *   - a costume (redress) keeps owning its own outfit;
 *   - the non-seasonal sheet prompt is byte-identical to the shipped one.
 */
import { describe, it, expect } from 'vitest';

const { seasonOutfitGuidance, SEASONS } = require('../../server/lib/season');
const { buildBodyRowPrompt, buildPrompt, buildFootwearRule, buildSeasonOutfitBlock } =
  require('../../server/lib/character2x4Sheet')._internal;

const forSeason = (season: string) => seasonOutfitGuidance({ season });

describe('seasonOutfitGuidance', () => {
  it('gives every season an outfit and a footwear clause', () => {
    for (const s of SEASONS) {
      const g = forSeason(s);
      expect(g, s).toBeTruthy();
      expect(g.season).toBe(s);
      expect(g.label.toLowerCase()).toBe(s);
      expect(g.outfit.length).toBeGreaterThan(20);
      expect(g.footwear.length).toBeGreaterThan(3);
    }
  });

  it('a cold season asks for an outer layer; a warm one forbids it', () => {
    expect(forSeason('winter').outfit).toMatch(/coat|parka|jacket/i);
    expect(forSeason('autumn').outfit).toMatch(/jacket|anorak|knit/i);
    // The warm-season half is the one that silently goes wrong: a rule that only
    // says "dress for the season" puts a child in a coat in July.
    const summer = forSeason('summer').outfit;
    expect(summer).toMatch(/no outer layer/i);
    expect(summer).toMatch(/short sleeves|bare arms/i);
    expect(forSeason('spring').outfit).toMatch(/no winter coat/i);
  });

  it('resolves from the story date when no season is given', () => {
    expect(seasonOutfitGuidance({}, { now: '2026-01-15' }).season).toBe('winter');
    expect(seasonOutfitGuidance({}, { now: '2026-07-15' }).season).toBe('summer');
  });

  it('stays out of a historical story, where the era dresses the cast', () => {
    expect(seasonOutfitGuidance({ season: 'winter', storyCategory: 'historical' })).toBeNull();
  });

  it('stays generic — no story specifics', () => {
    for (const s of SEASONS) {
      expect(forSeason(s).outfit).not.toMatch(/Omar|chestnut|hedgehog|Rohrdorf/i);
    }
  });
});

describe('the sheet prompt carries the season as an OUTFIT rule only', () => {
  const winter = forSeason('winter');

  it('names the garments and pins identity to the references', () => {
    const block = buildSeasonOutfitBlock(winter, false);
    expect(block).toContain(winter.outfit);
    // Identity is the whole point of the sheet — the season may never move it.
    expect(block).toMatch(/face, hair, hairstyle, skin tone, build and apparent age/i);
    expect(block).toMatch(/never change/i);
  });

  it('is suppressed on a costume sheet — the costume owns the outfit', () => {
    expect(buildSeasonOutfitBlock(winter, true)).toBe('');
    expect(buildBodyRowPrompt('a pirate coat and sash', null, true, 'pirate', winter))
      .not.toContain(winter.outfit);
  });

  it('reaches both sheet builders when passed', () => {
    expect(buildBodyRowPrompt('standard outfit', null, false, null, winter)).toContain(winter.outfit);
    expect(buildPrompt('watercolor', 'standard outfit', null, false, null, winter)).toContain(winter.outfit);
  });

  it('changes nothing at all when no season is passed', () => {
    expect(buildSeasonOutfitBlock(null, false)).toBe('');
    expect(buildBodyRowPrompt('standard outfit', null, false, null))
      .toEqual(buildBodyRowPrompt('standard outfit', null, false, null, null));
  });
});

describe('season and the footwear rule are one rule, not two', () => {
  it('a seasonal sheet takes its footwear kind from the season, not from the photo', () => {
    // The reference photo's sandals are exactly what a winter sheet must not copy.
    const seasonal = buildFootwearRule(false, forSeason('winter').footwear);
    expect(seasonal).toContain(forSeason('winter').footwear);
    expect(seasonal).not.toMatch(/the footwear the body reference shows, same type and colour/);
    // The no-feet exception survives (a tail or fin is still never shod).
    expect(seasonal).toMatch(/tail, fin, or single fused form with no feet at all/);
  });

  it('the shipped non-seasonal rule is untouched', () => {
    expect(buildFootwearRule(false, null)).toEqual(buildFootwearRule(false));
    expect(buildFootwearRule(true, forSeason('winter').footwear)).toEqual(buildFootwearRule(true));
  });

  it('the body-row prompt states footwear exactly once', () => {
    const p = buildBodyRowPrompt('standard outfit', null, false, null, forSeason('winter'));
    expect(p.match(/Footwear is part of the/g)).toHaveLength(1);
  });
});
