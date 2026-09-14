/**
 * Finding provenance — WHO said this (backlog #50, 2026-09-14).
 *
 * A finding's origin is the first thing needed to judge it. Four diagnoses on
 * 2026-09-14 turned on reconstructing the emitter after the fact. These tests
 * pin the three things that make the field trustworthy:
 *
 *  1. findings from DIFFERENT emitters each carry their OWN provenance, and it
 *     survives the merge/consolidation whitelists into the stored shape;
 *  2. a finding WITHOUT provenance still flows and still scores identically
 *     (the additive guarantee);
 *  3. routing is unchanged — the `sources: ['entity']` contract that
 *     repairLogic reads behaves exactly as before.
 */
import { describe, it, expect } from 'vitest';

const {
  FINDING_SOURCES,
  stampFindingSource,
  sourcesOf,
  mergeSources,
} = require('../../server/lib/findingSources.js');

describe('provenance: three different emitters each carry their own, through consolidation into the stored shape', () => {
  it('a quality, a compliance and an entity finding keep distinct sources through flattenEntityIssues + normalizeIssues', () => {
    // Emitter 1 — the quality judge (evalPipeline stamps at the merge chokepoint).
    const quality = stampFindingSource(
      [{ description: 'hand merges into the railing', severity: 'MAJOR', type: 'anatomy' }],
      FINDING_SOURCES.QUALITY,
    )[0];
    // Emitter 2 — the three-stage compliance judge.
    const compliance = stampFindingSource(
      [{ description: 'the lantern the brief calls for is absent', severity: 'MAJOR', type: 'object_presence' }],
      FINDING_SOURCES.COMPLIANCE,
    )[0];
    // Emitter 3 — entity consistency.
    const entity = stampFindingSource(
      [{ description: 'hair reads darker than the reference', severity: 'MINOR', subType: 'hair_nuance', type: 'consistency' }],
      FINDING_SOURCES.ENTITY,
    )[0];

    expect(sourcesOf(quality)).toEqual(['quality']);
    expect(sourcesOf(compliance)).toEqual(['compliance']);
    expect(sourcesOf(entity)).toEqual(['entity']);

    // HOP 1 — the consolidator's entity whitelist, historically a drop site.
    const { flattenEntityIssues } = require('../../server/lib/feedbackConsolidator.js');
    const flattened = flattenEntityIssues({
      characters: { Anna: { issues: [entity] } },
    });
    expect(flattened).toHaveLength(1);
    expect(sourcesOf(flattened[0])).toEqual(['entity']);

    // HOP 2 — scoring's normalizeIssues whitelist, and the stored deductions shape.
    const { composeDeductions } = require('../../server/lib/scoring.js');
    const deductions = composeDeductions({
      evalResult: { fixableIssues: [quality, compliance], semanticResult: null, threeStageResult: null },
      entityResult: { issues: [{ ...entity, name: 'Anna' }] },
    });
    const stored = [
      ...(deductions.quality || []),
      ...(deductions.semantic || []),
      ...(deductions.compliance || []),
      ...(deductions.entity || []),
    ];
    const byText = (needle: string) => stored.find((d: any) => d.description.includes(needle));

    expect(sourcesOf(byText('railing'))).toEqual(['quality']);
    expect(sourcesOf(byText('lantern'))).toEqual(['compliance']);
    expect(sourcesOf(byText('darker'))).toEqual(['entity']);
  });

  it('the consolidated path keeps the multi-evaluator sources the consolidator wrote', () => {
    const { composeDeductions } = require('../../server/lib/scoring.js');
    const out = composeDeductions({
      consolidated: [
        { description: 'boy turned away from the stone', severity: 'MAJOR', type: 'action_interaction', sources: ['quality', 'semantic'] },
        { description: 'hair colour drift', severity: 'MINOR', type: 'hair', sources: ['entity'] },
      ],
    });
    expect(sourcesOf(out.consolidated[0])).toEqual(['quality', 'semantic']);
    // entity-only still lands in its own capped bucket — unchanged.
    expect(out.entity).toHaveLength(1);
    expect(sourcesOf(out.entity[0])).toEqual(['entity']);
  });
});

describe('provenance is additive: a finding with none still flows and still scores identically', () => {
  it('scores the same with and without the field, and never invents one', () => {
    const { composeDeductions, deductionPoints } = require('../../server/lib/scoring.js');
    const bare = { description: 'shadow falls the wrong way', severity: 'MODERATE', type: 'lighting' };
    const stamped = stampFindingSource([bare], FINDING_SOURCES.QUALITY)[0];

    const withoutProv = composeDeductions({ evalResult: { fixableIssues: [bare] } });
    const withProv = composeDeductions({ evalResult: { fixableIssues: [stamped] } });

    expect(withoutProv.quality).toHaveLength(1);
    expect(withProv.quality).toHaveLength(1);
    // Identical points — provenance costs nothing.
    expect(deductionPoints(withoutProv.quality[0])).toBe(deductionPoints(withProv.quality[0]));
    // Severity and type untouched by the stamp.
    expect(withProv.quality[0].severity).toBe(withoutProv.quality[0].severity);
    expect(withProv.quality[0].type).toBe(withoutProv.quality[0].type);
    // Unknown provenance reads as EMPTY, never as a guessed value.
    expect(sourcesOf(withoutProv.quality[0])).toEqual([]);
    expect(sourcesOf(bare)).toEqual([]);
  });

  it('a stamp never overwrites provenance a finding already carries', () => {
    const merged = { description: 'x', severity: 'MAJOR', sources: ['quality', 'semantic'] };
    expect(stampFindingSource([merged], FINDING_SOURCES.ENTITY)[0].sources).toEqual(['quality', 'semantic']);
    expect(mergeSources(['quality'], ['QUALITY', 'entity'])).toEqual(['quality', 'entity']);
    // An unknown emitter name is a bug, not a silent pass-through.
    expect(() => stampFindingSource([merged], 'made-up-judge')).toThrow(/unknown source/i);
  });
});

describe('routing regression: the entity-sourced contract at repairLogic is unchanged', () => {
  const { findSafeRepairableFinding } = require('../../server/lib/repairLogic.js');

  it('an entity-sourced CRITICAL is still refused, and stamping non-entity pools does not change that', () => {
    const entityCritical = {
      description: 'wrong face on the boy', severity: 'CRITICAL', type: 'object_presence', sources: ['entity'],
    };
    // Before: refused. After stamping the OTHER pools, still refused.
    expect(findSafeRepairableFinding({ consolidatedPlan: { deduped_issues: [entityCritical] } })).toBeNull();
    expect(findSafeRepairableFinding({ fixableIssues: [entityCritical] })).toBeNull();
  });

  it('a quality-pool CRITICAL routes the same with and without its new stamp', () => {
    const bare = { description: 'the lantern is missing', severity: 'CRITICAL', type: 'object_presence' };
    const stamped = stampFindingSource([bare], FINDING_SOURCES.QUALITY)[0];

    const before = findSafeRepairableFinding({ fixableIssues: [bare] });
    const after = findSafeRepairableFinding({ fixableIssues: [stamped] });
    expect(after).toEqual(before);
    expect(after).not.toBeNull();
    expect(after.pool).toBe('quality');
  });

  it('a semantic-pool finding stamped `semantic` is still not treated as entity-only', () => {
    const stamped = stampFindingSource(
      [{ description: 'the lantern is missing', severity: 'CRITICAL', type: 'object_presence' }],
      FINDING_SOURCES.SEMANTIC,
    );
    const got = findSafeRepairableFinding({ semanticResult: { semanticIssues: stamped } });
    expect(got).not.toBeNull();
    expect(got.pool).toBe('semantic');
  });
});
