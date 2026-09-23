import { describe, it, expect } from 'vitest';

// A `cutout_artifact` finding describes the entity grid's crop, not the page
// (owner, 2026-09-01). It already costs nothing (scoring.js ZERO_POINT_TYPES);
// it takes no repair route either. On staging job_1790100385959_1nitlympp p14
// the consolidator planned an inpaint to remove a white block that existed only
// in the grid crop.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideRepairMethod, selectCharRepairTasks, typesAreInpaintable, isCropArtifact } = require('../../server/lib/repairLogic');

const report = (type: string) => ({
  characters: {
    CharA: { issues: [{ id: 'i1', type, severity: 'CRITICAL', description: 'x', pagesToFix: [4] }] },
  },
});
const okEval = () => ({ scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } }, fixableIssues: [] });

describe('crop artefacts take no repair route', () => {
  it('a CRITICAL cutout_artifact does not route a char-fix', () => {
    expect(decideRepairMethod(4, okEval(), report('cutout_artifact')).method).not.toBe('char-fix');
    expect(decideRepairMethod(4, okEval(), report('age_shift')).method).toBe('char-fix');
  });
  it('the char-fix task selector skips it too', () => {
    expect(selectCharRepairTasks(report('cutout_artifact'), {}).tasks).toEqual([]);
    expect(selectCharRepairTasks(report('age_shift'), {}).tasks.length).toBe(1);
  });
  it('an inpaint whose types are all crop artefacts is not inpaintable', () => {
    expect(typesAreInpaintable(['cutout_artifact'])).toBe(false);
    expect(typesAreInpaintable(['cutout_artifact', 'action_interaction'])).toBe(true);
  });
  it('reads the declared type or subType, never text', () => {
    expect(isCropArtifact({ subType: 'cutout_artifact' })).toBe(true);
    expect(isCropArtifact({ type: 'face_drift', description: 'cutout_artifact' })).toBe(false);
  });
});
