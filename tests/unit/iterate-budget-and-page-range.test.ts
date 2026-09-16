/**
 * TWO MECHANICAL GUARDS ON AN ITERATE REWRITE (2026-09-16).
 *
 * 1. PAGE RANGE, NOT NAME TOKENS. The anchored-object allow-list let a rewrite
 *    ADD any Visual Bible id whose name shared a >=5-char word with the page
 *    text — which is how a creature was staged pages early: the page text
 *    legitimately used its proper name for the OBJECT it hatches from.
 *    `pages` is structured data the bible already states; it decides.
 *
 * 2. THE REWRITE BUDGET. All five iterate rewrites on
 *    job_1789506283204_3kxqshifx grew the brief 2.2x-3.4x (1891->4890,
 *    2430->5920, 1320->4440, 2176->5758, 3174->6947) and the added clauses
 *    created NEW criticals on content that had been correct.
 *
 * Behaviour pinned, never wording.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const {
  vbEntityCoversPage, briefProse, computeBriefBudget, renderBriefBudget,
  checkBriefBudget, BRIEF_GROWTH_FACTOR,
} = nodeRequire('../../server/lib/iterateBeat.js');

describe('a rewrite may not stage a Visual Bible id outside its own page range', () => {
  const creature = { id: 'ANI003', name: 'Lindi', description: 'a small winged creature', pages: [18, 19, 20] };
  const artifact = { id: 'ART001', name: 'Lindi', description: 'a speckled egg', pages: [14, 15, 16, 17] };

  it('an id whose range EXCLUDES this page is refused', () => {
    expect(vbEntityCoversPage(creature, 16)).toBe(false);
  });

  it('an id whose range INCLUDES this page is allowed', () => {
    expect(vbEntityCoversPage(artifact, 16)).toBe(true);
    expect(vbEntityCoversPage(creature, 19)).toBe(true);
  });

  it('an entry with no pages at all is UNKNOWN, never excluded', () => {
    expect(vbEntityCoversPage({ id: 'ART009', name: 'lantern' }, 16)).toBeNull();
    expect(vbEntityCoversPage({ id: 'ART009', pages: [] }, 16)).toBeNull();
  });

  it('the older appearsInPages shape and per-state pages both count', () => {
    expect(vbEntityCoversPage({ id: 'ART002', appearsInPages: [3, 4] }, 4)).toBe(true);
    expect(vbEntityCoversPage({ id: 'ART003', states: [{ id: 'ART003.2', pages: [7] }] }, 7)).toBe(true);
    expect(vbEntityCoversPage({ id: 'ART003', states: [{ id: 'ART003.2', pages: [7] }] }, 9)).toBe(false);
  });

  it('string page numbers and an unreadable page are handled without coercing', () => {
    expect(vbEntityCoversPage({ id: 'X', pages: ['5', '6'] }, 5)).toBe(true);
    expect(vbEntityCoversPage({ id: 'X', pages: [5] }, NaN)).toBeNull();
    expect(vbEntityCoversPage(null, 5)).toBeNull();
  });
});

describe('the rewrite budget is a number computed from the brief being rewritten', () => {
  const original = 'x'.repeat(2000);

  it('the budget is the measured growth factor over the original prose', () => {
    const b = computeBriefBudget(original);
    expect(b.originalChars).toBe(2000);
    expect(b.maxChars).toBe(Math.ceil(2000 * BRIEF_GROWTH_FACTOR));
    // Below the smallest growth ever measured on the reference story.
    expect(BRIEF_GROWTH_FACTOR).toBeLessThan(2.2);
  });

  it('the ---METADATA--- block is structure, not prose, and is not budgeted', () => {
    expect(briefProse(`${'y'.repeat(100)}\n---METADATA---\n{"characters":[]}`)).toHaveLength(100);
  });

  it('a very short original still gets a workable floor', () => {
    expect(computeBriefBudget('short').maxChars).toBeGreaterThanOrEqual(1200);
  });

  it('the rendered rule states the concrete number', () => {
    const b = computeBriefBudget(original);
    expect(renderBriefBudget(b)).toContain(String(b.maxChars));
    expect(renderBriefBudget(b)).toContain(String(b.originalChars));
  });

  it('every rewrite measured on the reference story breaches this budget', () => {
    for (const [before, after] of [[1891, 4890], [2430, 5920], [1320, 4440], [2176, 5758], [3174, 6947]]) {
      const b = computeBriefBudget('x'.repeat(before));
      expect(checkBriefBudget({ brief: 'x'.repeat(after), budget: b }).some((f: any) => f.type === 'brief_over_budget')).toBe(true);
    }
  });

  it('a rewrite inside the budget with only allowed citations breaches nothing', () => {
    const b = computeBriefBudget('x'.repeat(2000));
    expect(checkBriefBudget({
      brief: 'x'.repeat(2500),
      budget: b,
      newMetadata: { objects: ['ART001.2'], characters: [{ name: 'Hero' }] },
      allowedObjects: ['ART001'],
      allowedNames: ['Hero'],
    })).toEqual([]);
  });

  it('an object or character outside original-union-planline-union-feedback is a breach', () => {
    const b = computeBriefBudget('x'.repeat(2000));
    const findings = checkBriefBudget({
      brief: 'x'.repeat(100),
      budget: b,
      newMetadata: { objects: ['ANI003'], characters: [{ name: 'Stranger' }] },
      allowedObjects: ['ART001'],
      allowedNames: ['Hero'],
    });
    expect(findings.map((f: any) => f.type).sort()).toEqual(['character_outside_budget', 'object_outside_budget']);
    // The breach names the offender, so the re-ask can carry it.
    expect(findings.find((f: any) => f.type === 'object_outside_budget').detail).toContain('ANI003');
    expect(findings.find((f: any) => f.type === 'character_outside_budget').detail).toContain('Stranger');
  });
});

describe('a breach triggers exactly ONE corrective re-ask carrying the breach', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');

  it('there is one budget re-ask call, not a retry loop', () => {
    expect(SRC.split("usageLabel: 'scene_iterate_budget'").length - 1).toBe(1);
  });

  it('the re-ask carries the specific breach, not a generic nag', () => {
    const call = SRC.slice(SRC.indexOf('budgetFindings.length > 0'), SRC.indexOf("usageLabel: 'scene_iterate_budget'"));
    expect(call).toContain('describeBriefFindings(budgetFindings)');
  });

  it('the re-ask is only taken when it actually reduces the breach', () => {
    expect(SRC).toContain('trimmedFindings.length < budgetFindings.length');
  });
});
