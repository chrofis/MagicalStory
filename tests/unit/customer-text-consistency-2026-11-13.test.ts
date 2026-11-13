// Regression for the 2026-11-13 language review of the customer-facing constants, SEO
// meta, emails and voucher: facts written in text must match the code.
//  - Swiss German uses ss, never the eszett (in strings; comments may mention it).
//  - The art-style count written in seoMeta.js and comparisonData.ts equals the number
//    of styles in client/src/constants/artStyles.ts (the review found 8 and 14 side by side).
//  - The printed-book "from" price is one value across giftData.ts (the review found
//    "from CHF 29" and "from CHF 37" for the same book on one page): hardcover
//    prices say CHF 37, and CHF 29 appears only where the softcover is named.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CONSTANTS = 'client/src/constants';
const TEXT_FILES = [
  `${CONSTANTS}/giftData.ts`, `${CONSTANTS}/comparisonData.ts`, `${CONSTANTS}/occasionData.ts`,
  `${CONSTANTS}/guideData.ts`, `${CONSTANTS}/storyTypes.ts`, `${CONSTANTS}/translations.ts`,
  `${CONSTANTS}/artStyles.ts`, `${CONSTANTS}/relationships.ts`, `${CONSTANTS}/traits.ts`,
  'shared/relationship-types.json', 'server/lib/seoMeta.js', 'server/lib/vouchers.js', 'email.js',
  'emails/voucher.html', 'emails/trial-reminder.html', 'emails/trial-story-complete.html',
  'emails/story-complete.html', 'emails/order-confirmation.html', 'emails/order-shipped.html',
  'emails/order-failed.html', 'emails/story-failed.html', 'emails/password-reset.html',
  'emails/email-verification.html',
];
const THEME_DIR = path.join(ROOT, CONSTANTS, 'themeContent');
const themeFiles = fs.readdirSync(THEME_DIR).filter(f => f.endsWith('.json')).map(f => `${CONSTANTS}/themeContent/${f}`);

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('Swiss German: no eszett in customer text', () => {
  for (const file of [...TEXT_FILES, ...themeFiles]) {
    it(file, () => {
      const offending = read(file).split('\n').filter(l => l.includes('ß') && !isComment(l));
      expect(offending).toEqual([]);
    });
  }
});

describe('art-style count written in text equals artStyles.ts', () => {
  const styleCount = (read(`${CONSTANTS}/artStyles.ts`).match(/^\s{4}id: '/gm) || []).length;

  it('artStyles.ts has styles', () => {
    expect(styleCount).toBeGreaterThan(0);
  });

  it('seoMeta.js claims', () => {
    const claims = [...read('server/lib/seoMeta.js').matchAll(/\b(\d+) (?:art styles|Kunststile|styles|stili)\b/g)].map(m => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const n of claims) expect(n).toBe(styleCount);
  });

  it('comparisonData.ts claims about Magical Story (own bullets say 170+ themes or "we offer"; competitor bullets are skipped)', () => {
    const lines = read(`${CONSTANTS}/comparisonData.ts`).split('\n');
    const claims: number[] = [];
    lines.forEach((line, i) => {
      // table rows: label 'Art styles' followed by us: { en: 'N...', ...}
      if (/label: \{ en: 'Art styles'/.test(line)) {
        const us = lines[i + 1].match(/us: \{ en: '(\d+)/);
        if (us) claims.push(Number(us[1]));
      }
      const own = /170\+|We also offer|Wir bieten|Nous offrons|offriamo/.test(line);
      if (!own) return; // competitor feature lists carry their own numbers
      for (const m of line.matchAll(/\b(\d+) (?:art styles|Kunststile|styles artistiques|stili artistici|styles|stili)\b/g)) claims.push(Number(m[1]));
    });
    expect(claims.length).toBeGreaterThan(0);
    for (const n of claims) expect(n).toBe(styleCount);
  });
});

describe('printed book "from" price is one value in giftData.ts', () => {
  const text = read(`${CONSTANTS}/giftData.ts`);
  const matches = [...text.matchAll(/\b(?:from|ab|dès|da) CHF ?(\d+)\b/gi)];
  const HARDCOVER = /hardcover|rigide|rigida/i;
  const SOFTCOVER = /softcover|souple|morbida/i;

  it('has prices', () => {
    expect(matches.length).toBeGreaterThan(0);
  });

  it('every "from CHF" price outside a softcover mention is one value', () => {
    const values = new Set<number>();
    for (const m of matches) {
      const near = text.slice(Math.max(0, m.index! - 120), m.index! + 120);
      if (SOFTCOVER.test(near) && Number(m[1]) !== 37) continue; // softcover has its own, lower price
      values.add(Number(m[1]));
    }
    expect([...values]).toEqual([37]);
  });

  it('CHF 29 appears only next to the word softcover', () => {
    for (const m of matches.filter(x => Number(x[1]) === 29)) {
      const near = text.slice(Math.max(0, m.index! - 120), m.index! + 120);
      expect(SOFTCOVER.test(near) && HARDCOVER.test(near)).toBe(true);
    }
  });
});
