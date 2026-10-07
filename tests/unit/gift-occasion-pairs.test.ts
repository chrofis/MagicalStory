import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { GIFT_OCCASION_PAIRS, occasionForGift, giftForOccasion } from '../../client/src/constants/giftOccasionPairs';
import { giftPages } from '../../client/src/constants/giftData';
import { occasions } from '../../client/src/constants/occasionData';
import { guides } from '../../client/src/constants/guideData';

// Cross-links added 2026-10-07: gift ↔ occasion twins (taufgeschenk ↔ taufe) and theme → guide
// (the reverse of GuidePage's relatedTheme link). The pair table is data; this holds it to the ids.
const ROOT = path.resolve(__dirname, '../..');

describe('gift ↔ occasion pairs', () => {
  it('every id exists in its data file, each side at most once', () => {
    const giftIds = new Set(giftPages.map((g) => g.id));
    const occIds = new Set(occasions.map((o) => o.id));
    for (const [g, o] of GIFT_OCCASION_PAIRS) {
      expect(giftIds.has(g), g).toBe(true);
      expect(occIds.has(o), o).toBe(true);
    }
    expect(new Set(GIFT_OCCASION_PAIRS.map(([g]) => g)).size).toBe(GIFT_OCCASION_PAIRS.length);
    expect(new Set(GIFT_OCCASION_PAIRS.map(([, o]) => o)).size).toBe(GIFT_OCCASION_PAIRS.length);
  });

  it('pairs are the occasion-category gift pages whose subject is the occasion', () => {
    // Every gift page of category "occasion" has an occasion twin; no other gift page does.
    const occasionGifts = giftPages.filter((g) => g.category === 'occasion').map((g) => g.id).sort();
    expect(GIFT_OCCASION_PAIRS.map(([g]) => g).sort()).toEqual(occasionGifts);
  });

  it('lookups are symmetric', () => {
    expect(occasionForGift('taufgeschenk')?.id).toBe('taufe');
    expect(giftForOccasion('taufe')?.id).toBe('taufgeschenk');
    expect(occasionForGift('fuer-enkel')).toBeNull();
    expect(giftForOccasion('advent')).toBeNull();
  });

  it('GiftPage and OccasionPage render the twin link through the lang helper', () => {
    const gift = fs.readFileSync(path.join(ROOT, 'client/src/pages/GiftPage.tsx'), 'utf-8');
    const occ = fs.readFileSync(path.join(ROOT, 'client/src/pages/OccasionPage.tsx'), 'utf-8');
    expect(gift).toContain('to={lp(`/anlass/${occasionTwin.id}`)}');
    expect(occ).toContain('to={lp(`/geschenk/${giftTwin.id}`)}');
    for (const src of [gift, occ]) {
      for (const lang of ['en', 'de', 'fr', 'it']) {
        const block = src.match(new RegExp(`^  ${lang}: \\{[\\s\\S]*?^  \\},`, 'm'))![0];
        expect(block, lang).toMatch(/(occasionLink|giftLink): '[^']+'/);
      }
    }
  });
});

describe('theme → guide reverse link', () => {
  it('every guide relatedTheme is a theme id the ThemePage can resolve', () => {
    const withTheme = guides.filter((g) => g.relatedTheme);
    expect(withTheme.length).toBeGreaterThan(0);
    const storyTypes = fs.readFileSync(path.join(ROOT, 'client/src/constants/storyTypes.ts'), 'utf-8');
    for (const g of withTheme) expect(storyTypes, g.id).toContain(`id: '${g.relatedTheme}'`);
  });

  it('ThemePage links the guide back, in the page language', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/ThemePage.tsx'), 'utf-8');
    expect(src).toContain("guides.find((g) => g.relatedTheme === themeId)");
    expect(src).toContain('to={lp(`/ratgeber/${guide.id}`)}');
    for (const lang of ['en', 'de', 'fr', 'it']) {
      const block = src.match(new RegExp(`^  ${lang}: \\{[\\s\\S]*?^  \\},`, 'm'))![0];
      expect(block, lang).toMatch(/guideLink: '[^']+'/);
    }
  });
});
