import { describe, it, expect } from 'vitest';

// Critical-gone wins (owner, 2026-09-26): a version whose CRITICAL is confirmed
// gone never loses to a version that still carries it. Staging
// job_1790373080139_vnx5l8iy7 p18 shipped a caption overlay (v0, 75) over the
// inpaint that removed it (v1, 33).

// @ts-ignore — plain CommonJS module
const { pickBestVersionIndex, dominatesByCritical, chargedCriticalKeys } = require('../../server/lib/scoring.js');
// @ts-ignore — plain CommonJS module
const { lastRepairRegressed, bothStrategiesTriedAndRegressed } = require('../../server/lib/repairPipeline.js');
// @ts-ignore — plain CommonJS module
const { summarizeRepairRound } = require('../../server/lib/repairLogic.js');

const EMPTY = { quality: [], semantic: [], compliance: [], consolidated: [], entity: [] };
const finding = (type: string, severity: string, name: string | null = null) =>
  ({ type, severity, name, description: 'prose is never read', source: 'consolidated' });
const version = (source: string, finalScore: number, consolidated: any[] = [], extra: any = {}) =>
  ({ source, finalScore, score: finalScore, deductions: { ...EMPTY, consolidated }, ...extra });

const CAPTION = { text: 'A HEADLINE', surface: 'overlay', position: 'bottom', placement: 'overlay', spelling: 'correct' };
const lettering = (items: any[]) => ({ letteringInventory: { items, declared: [] } });

describe('critical-gone wins — pickBestVersionIndex', () => {
  it('p18 shape: the inpaint that removed the caption wins over the higher-scoring original', () => {
    const v0 = version('original', 75, [finding('rendered_text', 'critical')], lettering([CAPTION]));
    const v1 = version('inpaint-round-1', 33, [finding('clothing', 'major', 'A'), finding('scale', 'major', 'B')], lettering([]));
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(1);
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'latest' })).toBe(1);
  });

  it('a lettering CRITICAL is not confirmed gone without the child\'s lettering record', () => {
    const v0 = version('original', 75, [finding('rendered_text', 'critical')], lettering([CAPTION]));
    const v1 = version('inpaint-round-1', 33, []);
    expect(dominatesByCritical(v1, v0)).toBe(false);
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('a lettering CRITICAL still in the child\'s inventory is not gone, even when its deductions dropped it', () => {
    const v0 = version('original', 75, [finding('rendered_text', 'critical')], lettering([CAPTION]));
    const v1 = version('inpaint-round-1', 33, [], lettering([CAPTION]));
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('both clean: the score decides', () => {
    const v0 = version('original', 80);
    const v1 = version('inpaint-round-1', 60);
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('both carrying different CRITICALs: the score decides', () => {
    const v0 = version('original', 70, [finding('object_presence', 'critical')]);
    const v1 = version('inpaint-round-1', 40, [finding('action_interaction', 'critical', 'A')]);
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('a child that fixed one CRITICAL but gained a new one of another class does not dominate', () => {
    const v0 = version('original', 70, [finding('object_presence', 'critical')]);
    const v1 = version('inpaint-round-1', 40, [finding('action_interaction', 'critical', 'A')]);
    expect(dominatesByCritical(v1, v0)).toBe(false);
  });

  it('the same class on a different subject is a different CRITICAL', () => {
    const v0 = version('original', 70, [finding('action_interaction', 'critical', 'A')]);
    const v1 = version('inpaint-round-1', 40, [finding('action_interaction', 'critical', 'B')]);
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('a type capped below CRITICAL does not count as a charged CRITICAL', () => {
    // cutout_artifact is a zero-point type: CRITICAL on paper, charged nothing.
    expect(chargedCriticalKeys(version('original', 90, [finding('cutout_artifact', 'critical', 'A')])).size).toBe(0);
  });

  it('a version without a deductions record takes no part (unknown set)', () => {
    const v0 = { source: 'original', finalScore: 75, deductions: { ...EMPTY, consolidated: [finding('object_presence', 'critical')] } };
    const v1 = { source: 'inpaint-round-1', finalScore: 33 };
    expect(pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
  });

  it('among non-dominated versions the score still ranks', () => {
    const v0 = version('original', 75, [finding('object_presence', 'critical')]);
    const v1 = version('inpaint-round-1', 33);
    const v2 = version('iterate-round-2', 50);
    expect(pickBestVersionIndex([v0, v1, v2], { tieBreak: 'earliest' })).toBe(2);
  });
});

describe('critical-gone wins — repair round decisions', () => {
  const v0 = version('original', 75, [finding('object_presence', 'critical')]);
  const cleared = version('inpaint-round-1', 33);

  it('lastRepairRegressed: a repair that cleared the CRITICAL did not regress', () => {
    expect(lastRepairRegressed([v0, cleared])).toBe(null);
  });

  it('lastRepairRegressed: a lower-scoring repair that cleared nothing still regressed', () => {
    const same = version('inpaint-round-1', 33, [finding('object_presence', 'critical')]);
    expect(lastRepairRegressed([v0, same])).toBe('iterate');
  });

  it('bothStrategiesTriedAndRegressed: a clearing repair counts as an improvement', () => {
    const iter = version('iterate-round-2', 30, [finding('object_presence', 'critical')]);
    expect(bothStrategiesTriedAndRegressed([v0, cleared, iter])).toBe(false);
    const inp = version('inpaint-round-1', 33, [finding('object_presence', 'critical')]);
    expect(bothStrategiesTriedAndRegressed([v0, inp, iter])).toBe(true);
  });

  it('summarizeRepairRound: a critical-cleared page is improved, not regressed', () => {
    const s = summarizeRepairRound({
      round: 1,
      attempts: [{ pageNumber: 18, method: 'inpaint', ok: true, error: null }],
      beforeScores: { 18: 75 },
      afterScores: { 18: 33 },
      criticalCleared: { 18: true },
    });
    expect(s.improved).toBe(1);
    expect(s.regressed).toBe(0);
    expect(s.pages[0].criticalCleared).toBe(true);
  });
});
