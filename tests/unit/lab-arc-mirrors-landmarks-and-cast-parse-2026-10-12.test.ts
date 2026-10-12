/**
 * The Test Lab's arc and plan mirrors read what production now reads (sibling sets
 * arc-retell-gate, plan-cast-table-prod-vs-lab; commit 7137b0e84):
 *   - the arc re-tell gate takes the landmark shortfall as a code-counted finding
 *     (landmarkGuideline.arcLandmarkCodeFindings) at both Lab arc stages;
 *   - the Lab's CAST block parse passes `leadEach`, so an "also on" page that is another
 *     character's deed page is refused there as in beatsPipeline.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const LG = require('../../server/lib/landmarkGuideline');
const PB = require('../../server/lib/promptBuilders');

const OFFERED = [{ name: 'Alpha Bridge' }, { name: 'Beta Tower' }, { name: 'Gamma Abbey (Old Town)' }];
const active = { premiseNamedWorld: false, availableLandmarks: OFFERED };

describe('arcLandmarkCodeFindings', () => {
  it('is empty when the arc stages the guideline minimum', () => {
    expect(LG.arcLandmarkCodeFindings(['- Alpha Bridge', '- Beta Tower'], active)).toEqual([]);
  });
  it('files one finding for a shortfall', () => {
    const f = LG.arcLandmarkCodeFindings(['- Alpha Bridge'], active);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('"Alpha Bridge"');
  });
  it('counts a missing block (null lines) as none staged', () => {
    expect(LG.arcLandmarkCodeFindings(null, active)).toHaveLength(1);
  });
  it('does not count a name that is not on the offered list', () => {
    expect(LG.arcLandmarkCodeFindings(['- Alpha Bridge', '- Nowhere Castle'], active)).toHaveLength(1);
  });
  it('is empty where the guideline is off or nothing was offered', () => {
    expect(LG.arcLandmarkCodeFindings(null, { ...active, premiseNamedWorld: true })).toEqual([]);
    expect(LG.arcLandmarkCodeFindings(null, { premiseNamedWorld: false, availableLandmarks: [] })).toEqual([]);
  });
  it('feeds the gate: a shortfall alone opens the re-tell', () => {
    const gate = PB.arcRepairFindings({ critique: '', reviewedArc: '', panel: [], codeFindings: LG.arcLandmarkCodeFindings(null, active) });
    expect(gate.retell).toBe(true);
  });
});

describe('Lab mirrors call the production readers', () => {
  const src = fs.readFileSync('server/lib/testlab.js', 'utf8');
  it('both arc stages pass the landmark code findings to the gate', () => {
    const calls = src.match(/arcRepairFindingsWithCastCheck\(\{[^\n]*\}\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).toContain('codeFindings: require(\'./landmarkGuideline\').arcLandmarkCodeFindings');
  });
  it('the Lab CAST parse passes leadEach', () => {
    expect(src).toMatch(/parsePlanCastBlock\(reply, \{ listed: commissionedCast\(storyData\)\.listed, leadEach:/);
  });
});
