/**
 * A page whose camera Jev puts aboard a vessel while its cited vantage is a ground view
 * (Fiona rerun #13, job_1791450210539_nwi88y9lr p13: the crew stood on the quay steps the vantage showed,
 * the text had them at the ship's rail). Pins behaviour, never prompt wording; archetypal fixtures.
 * see docs/decisions.md "Fiona rerun group C"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JBF = req('../../server/lib/jevBriefFields');
const JD = req('../../server/lib/jevDecisions');

const vb = {
  locations: [
    { id: 'LOC001', vantages: [
      { id: 'LOC001.1', cameraOn: 'ground', pages: [1] },
      { id: 'LOC001.2', cameraOn: 'aboard', pages: [2] },
    ] },
  ],
};

describe('aboardOnGroundVantage', () => {
  it('is true when the camera is aboard a vehicle and the cited vantage is a ground view', () => {
    expect(JBF.aboardOnGroundVantage(vb, 'LOC001.1', 'VEH001', ['VEH001'])).toBe(true);
  });
  it('is false when the vantage is itself an aboard view', () => {
    expect(JBF.aboardOnGroundVantage(vb, 'LOC001.2', 'VEH001', ['VEH001'])).toBe(false);
  });
  it('is false with no aboard, no cite, an unknown vantage or a non-vehicle aboard', () => {
    expect(JBF.aboardOnGroundVantage(vb, 'LOC001.1', null, ['VEH001'])).toBe(false);
    expect(JBF.aboardOnGroundVantage(vb, null, 'VEH001', ['VEH001'])).toBe(false);
    expect(JBF.aboardOnGroundVantage(vb, 'LOC009.1', 'VEH001', ['VEH001'])).toBe(false);
    expect(JBF.aboardOnGroundVantage(vb, 'LOC001.1', 'LOC002', ['VEH001'])).toBe(false);
  });
});

describe('the FIXED block for such a page', () => {
  const base = { cites: ['VEH001'], location: 'LOC001.1', aboard: 'VEH001', labels: { VEH001: 'sailing ship', 'LOC001.1': 'quay steps' } };
  it('tells the brief author the figures stand on the deck', () => {
    const block = JD.fixedBlock({ jevFixed: { ...base, aboardFromGround: true } });
    expect(block).toMatch(/- aboard: VEH001 \(sailing ship\) — the figures stand on its deck/);
  });
  it('is the plain aboard line when the vantage agrees', () => {
    const block = JD.fixedBlock({ jevFixed: base });
    expect(block).toMatch(/^- aboard: VEH001 \(sailing ship\)$/m);
    expect(block).not.toContain('stand on its deck');
  });
});
