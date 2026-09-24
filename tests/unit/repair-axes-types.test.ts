/**
 * Defect-type → repair-mode mapping (resolveRepairAxes, server/lib/faceRepair.js).
 *
 * Owner ruling 2026-09-01: "The char is needed if figure is distorted or limbs
 * missing or position wrong. But age cue is the face." Identity cues (the
 * evaluator vocabulary's character_identity bucket) route to the FACE repair
 * path; structural/positional defects and clothing keep the full-figure path.
 *
 * 2026-09-24: the choice comes from structured data ONLY. The judge's sentence
 * is no longer an input at all — it used to be keyword-sniffed ('eye', 'hair',
 * 'cloth') when no type decided. With no deciding type and no forceTarget the
 * resolver throws instead of guessing.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveRepairAxes, repairTargetForTypes } = require('../../server/lib/faceRepair.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideRepairMethod } = require('../../server/lib/repairLogic');

describe('resolveRepairAxes — defect-type mapping', () => {
  it('identity-cue types are face repairs', () => {
    for (const t of ['age_shift', 'face_drift', 'face_mismatch', 'facial_hair', 'skin_tone', 'face_destroyed', 'hair_change', 'hair_nuance']) {
      const axes = resolveRepairAxes({ hasFaceBbox: true, issueTypes: [t] });
      expect(axes.faceOnly, t).toBe(true);
      expect(axes.regionSource).toBe('cutout');
      expect(axes.treatment).toBe('blur');
    }
  });

  it('structural and clothing types stay full-figure', () => {
    for (const t of ['shape_change', 'clothing_inconsistent', 'color_change', 'clothing', 'garment', 'anatomy', 'placeholder_figure']) {
      const axes = resolveRepairAxes({ hasFaceBbox: true, issueTypes: [t] });
      expect(axes.faceOnly, t).toBe(false);
      expect(axes.regionSource).toBe('box');
      expect(axes.treatment).toBe('crosshatch');
    }
  });

  it('types are read case-insensitively', () => {
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['AGE_SHIFT'] }).faceOnly).toBe(true);
  });

  it('mixed face + body types → full-figure (garment/structure owns the scale)', () => {
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['age_shift', 'clothing_inconsistent'] }).faceOnly).toBe(false);
  });

  it('an unknown type is ignored when a known one decides', () => {
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['eye_colour', 'age_shift'] }).faceOnly).toBe(true);
    expect(repairTargetForTypes(['no_such_type', 'clothing_inconsistent'])).toBe('body');
  });

  it('face type without a face bbox degrades to full-figure', () => {
    expect(resolveRepairAxes({ hasFaceBbox: false, issueTypes: ['age_shift'] }).faceOnly).toBe(false);
  });

  it('forceTarget beats the type mapping, and decides alone when there is no type', () => {
    expect(resolveRepairAxes({ hasFaceBbox: true, issueTypes: ['age_shift'], forceTarget: 'body' }).faceOnly).toBe(false);
    expect(resolveRepairAxes({ hasFaceBbox: true, forceTarget: 'face' }).faceOnly).toBe(true);
    expect(resolveRepairAxes({ hasFaceBbox: true, forceTarget: 'body' }).faceOnly).toBe(false);
  });

  it('no deciding type and no forceTarget → throws, never guesses', () => {
    for (const issueTypes of [null, [], [''], ['consistency'], ['eye_colour'], ['body_build_change']]) {
      expect(repairTargetForTypes(issueTypes)).toBe(null);
      expect(() => resolveRepairAxes({ hasFaceBbox: true, issueTypes })).toThrow(/no finding type decides/);
    }
  });

  it('the judge sentence is not an input — a string first argument decides nothing', () => {
    // The old signature was (issueDescription, opts). A caller still passing
    // prose gets no keyword read: the string is not an options object.
    expect(() => resolveRepairAxes('the face and eyes look wrong')).toThrow(/no finding type decides/);
  });
});

describe('decideRepairMethod — entity char-fix routes by type only', () => {
  const evaluator = { scoreBreakdown: { visual: { score: 100 }, semantic: { score: 100 } }, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } };
  const report = (issues: unknown[]) => ({ characters: { Julian: { issues } } });

  it('an age cue with no keyword in its sentence is a face repair', () => {
    const d = decideRepairMethod(4, evaluator, report([{ type: 'age_shift', severity: 'CRITICAL', pagesToFix: [4], description: 'Julian appears older than his reference' }]));
    expect(d.method).toBe('char-fix');
    expect(d.repairParams.faceOnly).toBe(true);
  });

  it('a clothing word in a face finding sentence does not pull it to the body', () => {
    const d = decideRepairMethod(4, evaluator, report([{ type: 'face_mismatch', severity: 'CRITICAL', pagesToFix: [4], description: 'his face under the jacket collar reads as another child' }]));
    expect(d.repairParams.faceOnly).toBe(true);
  });

  it('a CRITICAL whose type decides nothing gets no char-fix; a routable one behind it still does', () => {
    const none = decideRepairMethod(4, evaluator, report([{ type: 'eye_colour', severity: 'CRITICAL', pagesToFix: [4], description: 'eyes are brown' }]));
    expect(none.method).not.toBe('char-fix');
    const next = decideRepairMethod(4, evaluator, report([
      { type: 'eye_colour', severity: 'CRITICAL', pagesToFix: [4], description: 'eyes are brown' },
      { type: 'clothing_inconsistent', severity: 'CRITICAL', pagesToFix: [4], description: 'wrong coat' },
    ]));
    expect(next.method).toBe('char-fix');
    expect(next.issueTypes).toEqual(['clothing_inconsistent']);
    expect(next.repairParams.faceOnly).toBe(false);
  });
});
