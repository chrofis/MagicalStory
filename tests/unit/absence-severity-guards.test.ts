/**
 * The image judges' "it is not there" findings pay full price only when a
 * second witness agrees.
 *
 * Staging job_1790100385959_1nitlympp p12 v0: the quality judge invented a
 * second Max on empty ground (CRITICAL) and called Kiaan's boots and the gilet
 * missing (MAJOR) — all three are drawn. They took the repair slots, the real
 * semantic findings were capped out, and the consolidator both dropped the
 * gilet as a false finding and charged it.
 *
 * Every guard here changes a severity only, from structured data: a type, a
 * detector count, a second judge's yes/no, the consolidator's reason code.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const { loadPromptTemplates } = require('../../server/services/prompts');
const absence = require('../../server/lib/absenceCheck');
const { parseFixableIssues, castPeopleCount, PRESENCE_DERIVED_MARKER } = require('../../server/lib/evalPipeline');
const { enforceNotADefectDrops } = require('../../server/lib/feedbackConsolidator');

// The run's stored p12 v0 quality findings (types, severities, subjects as stored).
const P12 = () => ([
  { type: 'duplicate_character', severity: 'CRITICAL', character: 'Max', description: 'Max appears twice in the illustration.' },
  { type: 'clothing', severity: 'MAJOR', character: 'Kiaan', description: 'Kiaan is missing his brown lace-up boots.', absent: true },
  { type: 'missing_element', severity: 'MAJOR', character: null, description: "Kiaan's rust-brown quilted gilet is missing from the scene." },
  { type: 'setting', severity: 'MODERATE', character: null, description: 'The atmosphere is not desperate.' },
]);

describe('duplicate_character is advisory when the detector counted no more people than the cast', () => {
  it('p12: detector 4 people, cast 4 people → the CRITICAL duplicate becomes MINOR, original kept', () => {
    const issues = P12();
    expect(absence.capDuplicatesByDetector(issues, { detectedPeopleCount: 4, castPeopleCount: 4 })).toBe(1);
    expect(issues[0]).toMatchObject({ severity: 'MINOR', severityBeforeCap: 'CRITICAL' });
    expect(issues[1].severity).toBe('MAJOR');
  });

  it('NEGATIVE CONTROL — one more person than the cast: the duplicate keeps CRITICAL', () => {
    const issues = P12();
    expect(absence.capDuplicatesByDetector(issues, { detectedPeopleCount: 5, castPeopleCount: 4 })).toBe(0);
    expect(issues[0].severity).toBe('CRITICAL');
  });

  it('no detector count → nothing is capped', () => {
    const issues = P12();
    expect(absence.capDuplicatesByDetector(issues, { detectedPeopleCount: null, castPeopleCount: 4 })).toBe(0);
    expect(issues[0].severity).toBe('CRITICAL');
  });

  it('the cast is counted in people: animals on the roster do not count', () => {
    const cast = { declared: true, names: ['Levin', 'Kiaan', 'Max', 'Julian', 'Turi', 'Nia'], nonHumanNames: ['Turi', 'Nia'] };
    expect(castPeopleCount(cast)).toBe(4);
    expect(castPeopleCount({ declared: false, names: ['A'] })).toBeNull();
  });
});

describe('which findings need a second look before they may take a repair slot', () => {
  it('CRITICAL/MAJOR absence by type or by the judge\'s own absent flag; never the detector\'s arithmetic', () => {
    const [dup, boots, gilet, setting] = P12();
    expect(absence.isSlotAbsenceClaim(boots, PRESENCE_DERIVED_MARKER)).toBe(true);
    expect(absence.isSlotAbsenceClaim(gilet, PRESENCE_DERIVED_MARKER)).toBe(true);
    expect(absence.isSlotAbsenceClaim(dup, PRESENCE_DERIVED_MARKER)).toBe(false);
    expect(absence.isSlotAbsenceClaim(setting, PRESENCE_DERIVED_MARKER)).toBe(false);
    expect(absence.isSlotAbsenceClaim({ ...gilet, severity: 'MODERATE' }, PRESENCE_DERIVED_MARKER)).toBe(false);
    expect(absence.isSlotAbsenceClaim({ type: 'missing_character', severity: 'CRITICAL', derivedBy: PRESENCE_DERIVED_MARKER }, PRESENCE_DERIVED_MARKER)).toBe(false);
  });

  it('the quality parser keeps the judge\'s absent flag', () => {
    const out = parseFixableIssues({ fixable_issues: [{ type: 'clothing', severity: 'MAJOR', description: 'x', absent: true }, { type: 'clothing', severity: 'MAJOR', description: 'y', absent: false }] });
    expect(out[0].absent).toBe(true);
    expect(out[1].absent).toBeUndefined();
  });
});

describe('the second look', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const IMG = 'data:image/jpeg;base64,AAAA';

  it('visible or unclear → advisory; confirmed absent → keeps its severity; one call for the page', async () => {
    const issues = P12();
    const sem = [{ type: 'missing_element', severity: 'MAJOR', character: null, description: 'The lantern is not in the picture.' }];
    const callJudge = vi.fn(async (parts: any[]) => {
      const prompt = parts[1].text;
      expect(prompt).toContain('1. Kiaan: Kiaan is missing his brown lace-up boots.');
      expect(prompt).not.toContain('Max appears twice');
      return { text: JSON.stringify({ claims: [{ id: 1, visible: 'yes', where: 'on his feet' }, { id: 2, visible: 'unclear' }, { id: 3, visible: 'no' }] }), usage: {} };
    });
    const out = await absence.secondLookAbsenceClaims({ imageData: IMG, lists: [issues, sem], presenceMarker: PRESENCE_DERIVED_MARKER, callJudge });
    expect(callJudge).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ checked: 3, capped: 2, confirmed: 1, error: null });
    expect(issues[1]).toMatchObject({ severity: 'MINOR', severityBeforeCap: 'MAJOR', secondLook: { visible: 'yes' } });
    expect(issues[2].severity).toBe('MINOR');
    expect(sem[0].severity).toBe('MAJOR');
  });

  it('no claims → no call', async () => {
    const callJudge = vi.fn();
    const out = await absence.secondLookAbsenceClaims({ imageData: IMG, lists: [[P12()[3]]], callJudge });
    expect(callJudge).not.toHaveBeenCalled();
    expect(out.checked).toBe(0);
  });

  it('a failed call leaves every claim at its severity and records the error on each', async () => {
    const issues = P12();
    const out = await absence.secondLookAbsenceClaims({ imageData: IMG, lists: [issues], callJudge: async () => { throw new Error('HTTP 503'); } });
    expect(out.error).toBe('HTTP 503');
    expect(issues[1]).toMatchObject({ severity: 'MAJOR', secondLook: { error: 'HTTP 503' } });
  });
});

describe('the consolidator never charges what it dropped as not a defect', () => {
  const plan = () => ({
    deduped_issues: [
      { type: 'missing_element', character: 'quilted gilet', severity: 'MAJOR', description: 'gilet missing' },
      { type: 'action_interaction', character: 'Kiaan', severity: 'MAJOR', description: 'not digging' },
    ],
    dropped_issues: [] as any[],
  });

  it('a finding_contradicts_brief drop removes the same type+subject from deduped_issues', () => {
    const p = plan();
    p.dropped_issues.push({ issue: 'gilet missing', reason: 'finding_contradicts_brief — the brief takes it off', type: 'missing_element', character: 'Quilted Gilet' });
    expect(enforceNotADefectDrops(p, 12)).toBe(1);
    expect(p.deduped_issues.map((i: any) => i.type)).toEqual(['action_interaction']);
  });

  it('NEGATIVE CONTROL — a plan-only drop (capped at 3) keeps the defect charged', () => {
    const p = plan();
    p.dropped_issues.push({ issue: 'not digging', reason: 'capped at 3, defer to next round', type: 'action_interaction', character: 'Kiaan' });
    expect(enforceNotADefectDrops(p, 12)).toBe(0);
    expect(p.deduped_issues).toHaveLength(2);
  });

  it('runs inside consolidateFeedback before the plan is used', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/feedbackConsolidator.js'), 'utf8');
    expect(src).toMatch(/enforceNotADefectDrops\(plan, pageNumber\);\s*\r?\n\s*applyRule7SceneFixGuard/);
  });
});

describe('the evaluator runs both guards before it scores the page', () => {
  it('both calls sit ahead of the score recompute', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/evalPipeline.js'), 'utf8');
    const cap = src.indexOf('absence.capDuplicatesByDetector(fixableIssues');
    const look = src.indexOf('absence.secondLookAbsenceClaims({');
    const score = src.indexOf('THE SCORE DERIVES FROM THE CURRENT ISSUE LIST');
    expect(cap).toBeGreaterThan(0);
    expect(look).toBeGreaterThan(cap);
    expect(score).toBeGreaterThan(look);
  });
});
