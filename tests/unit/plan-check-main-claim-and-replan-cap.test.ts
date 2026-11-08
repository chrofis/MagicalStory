/**
 * docs/decisions.md 2026-11-08 "plan check: main-character claims kept, one re-plan round".
 * (a) An `unlisted` claim the instant does not contain is dropped, unless it names a MAIN character
 *     (resolved from the structured mainNames list through castResolver).
 * (b) The re-plan is capped at one round, from one runtime constant.
 * Offline and free.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');
const { runtime } = require('../../server/config/runtime');

const roster = PB.parsePlanCheckRoster('ROSTER 1: people = none; things = egg; covers = none; unlisted = Ana, Ben');
const pages = [{ pageNumber: 1, planLine: 'low-angle — the egg — the egg sits in the roots, steam rising — the egg is warm' }];
const codes = (r: any) => r.findings.filter((x: any) => x.code === 'CAST_NOT_IN_WHO_COLUMN');

describe('(a) a dropped unlisted claim naming a main character is kept', () => {
  it('main Ana claimed but not in the instant: finding names Ana only', () => {
    const f = codes(PC.runPlanCounters({ pages, roster, commissionedNames: ['Ana', 'Ben'], mainNames: ['Ana'] }));
    expect(f.length).toBe(1);
    expect(f[0].pages).toEqual([1]);
    expect(f[0].line || f[0].text || JSON.stringify(f[0])).toContain('Ana');
    expect(JSON.stringify(f[0])).not.toContain('Ben');
  });
  it('no main among the claims: still dropped', () => {
    expect(codes(PC.runPlanCounters({ pages, roster, commissionedNames: ['Ana', 'Ben'], mainNames: [] })).length).toBe(0);
  });
  it('a main already in the who column is not flagged', () => {
    const p = [{ pageNumber: 1, planLine: 'wide — Ana — she waits — nothing yet' }];
    expect(codes(PC.runPlanCounters({ pages: p, roster, commissionedNames: ['Ana', 'Ben'], mainNames: ['Ana'] })).length).toBe(0);
  });
});

describe('(b) one re-plan round, one source', () => {
  it('runtime planReplanRounds is 1 and beatsPipeline reads it', () => {
    expect(runtime('planReplanRounds')).toBe(1);
    const src = readFileSync(join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toMatch(/MAX_REPLAN_ROUNDS = require\('\.\.\/config\/runtime'\)\.runtime\('planReplanRounds'\)/);
  });
});
