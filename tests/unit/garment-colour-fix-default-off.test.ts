/**
 * The garment colour fix is OFF by default (owner, 2026-10-08, docs/decisions.md
 * "Garment colour fix switched off"). While off, garment_colour findings must not
 * pull a page into repair: they stay findings that cost nothing.
 */
import { describe, it, expect } from 'vitest';

const { MODEL_DEFAULTS } = require('../../server/config/models');
const { deductionPoints } = require('../../server/lib/scoring');

describe('garment colour fix default', () => {
  it('is off unless GARMENT_COLOUR_FIX=true', () => {
    if (process.env.GARMENT_COLOUR_FIX === 'true') return;
    expect(MODEL_DEFAULTS.garmentColourFix).toBe(false);
  });

  it('a garment_colour finding costs no points at any severity, so it never makes a page "bad"', () => {
    for (const severity of ['minor', 'major', 'critical']) {
      expect(deductionPoints({ type: 'garment_colour', severity })).toBe(0);
      expect(deductionPoints({ type: 'consistency', subType: 'garment_colour', severity }, { entity: true })).toBe(0);
    }
  });
});
