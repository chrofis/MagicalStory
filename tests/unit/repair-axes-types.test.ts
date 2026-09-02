/**
 * Defect-type → repair-mode mapping (resolveRepairAxes, server/lib/faceRepair.js).
 *
 * Owner ruling 2026-09-01: "The char is needed if figure is distorted or limbs
 * missing or position wrong. But age cue is the face." Identity cues
 * (age_shift, face_drift, face_mismatch, facial_hair, skin_tone) route to the
 * FACE repair path; structural/positional defects and clothing keep the
 * full-figure path. Types beat keyword sniffing — "appears older" contains no
 * routing keyword and used to go full-figure (the G7 p16 failure).
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveRepairAxes } = require('../../server/lib/faceRepair.js');

describe('resolveRepairAxes — defect-type mapping', () => {
  it('age_shift routes to the FACE path even without a keyword ("appears older")', () => {
    const axes = resolveRepairAxes('Lorena appears older than her reference', { hasFaceBbox: true, issueTypes: ['age_shift'] });
    expect(axes.faceOnly).toBe(true);
    expect(axes.regionSource).toBe('cutout');
  });

  it('face_drift, face_mismatch, facial_hair, skin_tone are all face repairs', () => {
    for (const t of ['face_drift', 'face_mismatch', 'facial_hair', 'skin_tone']) {
      expect(resolveRepairAxes('', { hasFaceBbox: true, issueTypes: [t] }).faceOnly).toBe(true);
    }
  });

  it('structural and clothing types stay full-figure', () => {
    for (const t of ['shape_change', 'missing', 'unexpected', 'clothing_inconsistent', 'color_change']) {
      const axes = resolveRepairAxes('', { hasFaceBbox: true, issueTypes: [t] });
      expect(axes.faceOnly).toBe(false);
      expect(axes.regionSource).toBe('box');
      expect(axes.treatment).toBe('crosshatch');
    }
  });

  it('mixed face + body types → full-figure (garment/structure owns the scale)', () => {
    expect(resolveRepairAxes('', { hasFaceBbox: true, issueTypes: ['age_shift', 'clothing_inconsistent'] }).faceOnly).toBe(false);
  });

  it('face type without a face bbox degrades to full-figure', () => {
    expect(resolveRepairAxes('', { hasFaceBbox: false, issueTypes: ['age_shift'] }).faceOnly).toBe(false);
  });

  it('forceTarget still beats the type mapping', () => {
    expect(resolveRepairAxes('', { hasFaceBbox: true, issueTypes: ['age_shift'], forceTarget: 'body' }).faceOnly).toBe(false);
  });

  it('no types → keyword heuristic unchanged', () => {
    expect(resolveRepairAxes('wrong face shape', { hasFaceBbox: true }).faceOnly).toBe(true);
    expect(resolveRepairAxes('wrong jacket color', { hasFaceBbox: true }).faceOnly).toBe(false);
  });
});
