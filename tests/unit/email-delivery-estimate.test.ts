import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { formatDeliveryEstimate } = require('../../email.js');

describe('G-3 formatDeliveryEstimate', () => {
  it('falls back to the 5-7 business days text in all four languages (decision #8)', () => {
    expect(formatDeliveryEstimate(null, null, 'English')).toBe('5–7 business days');
    expect(formatDeliveryEstimate(null, null, 'German')).toBe('5–7 Werktage');
    expect(formatDeliveryEstimate(null, null, 'French')).toBe('5–7 jours ouvrables');
    expect(formatDeliveryEstimate(null, null, 'Italian')).toBe('5–7 giorni lavorativi');
  });

  it('resolves regional / short language keys the same as the names', () => {
    for (const k of ['de-ch', 'de', 'DE-CH', 'German']) expect(formatDeliveryEstimate(null, null, k)).toBe('5–7 Werktage');
    for (const k of ['it-ch', 'it', 'Italian']) expect(formatDeliveryEstimate(null, null, k)).toBe('5–7 giorni lavorativi');
    expect(formatDeliveryEstimate(null, null, 'fr-ch')).toBe('5–7 jours ouvrables');
  });

  it('formats a date range in the visitor language, not en-US', () => {
    const it = formatDeliveryEstimate('2026-10-12', '2026-10-14', 'it-ch');
    expect(it).toMatch(/ott/i);
    expect(it).not.toMatch(/Oct/);
    const de = formatDeliveryEstimate('2026-10-12', '2026-10-14', 'German');
    expect(de).toMatch(/Okt/);
    const fr = formatDeliveryEstimate('2026-10-12', '2026-10-14', 'French');
    expect(fr).toMatch(/oct/i);
  });

  it('single max date gets the per-language "by" label', () => {
    expect(formatDeliveryEstimate(null, '2026-10-14', 'Italian')).toMatch(/^entro il /);
    expect(formatDeliveryEstimate(null, '2026-10-14', 'de-ch')).toMatch(/^bis /);
  });
});
