/**
 * TWO MECHANICAL GUARDS ON AN ITERATE REWRITE (2026-09-16), pinned against the
 * five stored pages of staging job_1789506283204_3kxqshifx that motivated them.
 * The fixture is the REAL stored data — each page's original and rewritten
 * declarations, its plan line, its page text, the evaluator feedback the
 * iterate actually received (shaped exactly as repairPipeline hands it over),
 * and the story's Visual Bible page ranges. A hand-built fixture is how a fix
 * passes its test while broken.
 *
 * 1. THE DECLARED SET. A rewrite's objects[] / characters[] may cite only
 *    original ∪ plan-line ∪ feedback. Three of the five rewrites cited a
 *    landmark or a creature none of their inputs named; two were clean. A
 *    length budget that shipped beside this check was removed the same day: the
 *    growth it was built on was the template's own audit keys, not prose.
 *
 * 2. PAGE RANGE, NOT NAME TOKENS — at BOTH sites that put a Visual Bible entity
 *    on a page: the anchored-object allow-list and the staged-figures list. The
 *    page text calls the egg by the creature's proper name, so the creature
 *    (bible pages [17,18]) was staged on p13 and p16 off the plan line.
 *
 * Behaviour pinned, never wording.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const nodeRequire = createRequire(import.meta.url);

const {
  vbEntityCoversPage, anchorHaystack, collectStagedFigures, partitionAnchoredObjects,
  declaredSetAllowance, checkDeclaredSet,
} = nodeRequire('../../server/lib/iterateBeat.js');

const FIXTURE = nodeRequire('./fixtures/iterate-declared-set-job_1789506283204_3kxqshifx.json');
const VB = FIXTURE.visualBible;
const pageOf = (n: number) => FIXTURE.pages.find((p: any) => p.pageNumber === n);
const entity = (id: string) => [...VB.animals, ...VB.locations, ...VB.artifacts].find((e: any) => e.id === id);
const base = (o: any) => String(typeof o === 'string' ? o : o?.id || '').toUpperCase().split('.')[0];

/** Exactly the inputs iteratePageCore assembles for the two checks. */
function stagedOn(n: number, sceneMetadata = pageOf(n).original, visualBible = VB) {
  const pg = pageOf(n);
  return collectStagedFigures({
    visualBible, sceneMetadata, savedScene: { sceneMetadata }, planLine: pg.planLine, pageNumber: n,
  });
}
function findingsFor(n: number, evaluationFeedback = pageOf(n).evaluationFeedback) {
  const pg = pageOf(n);
  const allowance = declaredSetAllowance({
    origObjects: pg.original.objects,
    rewriteObjects: pg.rewrite.objects,
    evaluationFeedback, pageText: pg.pageText, planLine: pg.planLine,
    origCharacters: pg.original.characters,
    // strict iterate locks promptCharacters to the original scene's cast
    promptCharacters: pg.original.characters.map((name: string) => ({ name })),
    stagedFigures: stagedOn(n),
  });
  return checkDeclaredSet({ newMetadata: pg.rewrite, ...allowance });
}
const offendingIds = (findings: any[]) => findings.find(f => f.type === 'object_outside_declared_set')?.ids ?? [];

// ── The declared set, on the five stored pages ──────────────────────────────

describe('the declared set: a rewrite may cite only original ∪ plan-line ∪ feedback', () => {
  it.each([
    [2, []],
    [7, ['LOC003']],
    [10, []],
    [13, ['LOC002', 'LOC003', 'ANI003']],
    [16, ['LOC003', 'ANI003']],
  ])('p%i cites %j outside its declared set, and no character', (n, expected) => {
    const findings = findingsFor(n as number);
    expect(offendingIds(findings)).toEqual(expected);
    expect(findings.filter((f: any) => f.type === 'character_outside_declared_set')).toEqual([]);
  });

  it('none of the flagged ids is named by the feedback, the page text or the plan line', () => {
    for (const n of [7, 13, 16]) {
      const pg = pageOf(n);
      const hay = anchorHaystack({ evaluationFeedback: pg.evaluationFeedback, pageText: pg.pageText, planLine: pg.planLine });
      const ids = offendingIds(findingsFor(n));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(hay).not.toContain(id.toLowerCase());
    }
  });

  it('the flagged ids are exactly the ones whose bible range excludes the page', () => {
    for (const n of [7, 13, 16]) {
      for (const id of offendingIds(findingsFor(n))) expect(vbEntityCoversPage(entity(id), n)).toBe(false);
    }
  });

  it('an id the feedback asks for by name is allowed', () => {
    const pg = pageOf(7);
    const asked = { ...pg.evaluationFeedback, fixableIssues: [...pg.evaluationFeedback.fixableIssues, { description: 'LOC003 (the landmark) is missing from the scene.' }] };
    expect(findingsFor(7, asked)).toEqual([]);
  });

  it('a sub-state id is covered by its base id, and a named figure by its staged name', () => {
    expect(checkDeclaredSet({ newMetadata: { objects: ['ART001.2'], characters: [] }, allowedObjects: ['ART001'], allowedNames: [] })).toEqual([]);
    // real p10: the rewrite moved the crow from objects[] into characters[]; it is staged by name, so nothing is added
    expect(pageOf(10).rewrite.characters).toContain('Crow');
    expect(stagedOn(10).map((f: any) => f.name)).toContain('Crow');
  });

  it('a character none of the inputs name is a finding that carries the name', () => {
    const findings = checkDeclaredSet({ newMetadata: { objects: [], characters: [{ name: 'Stranger' }, 'Hero'] }, allowedObjects: [], allowedNames: ['hero'] });
    expect(findings.map((f: any) => f.type)).toEqual(['character_outside_declared_set']);
    expect(findings[0].names).toEqual(['Stranger']);
  });
});

// ── Exactly one corrective re-ask, fired only by an id-set finding ─────────

describe('exactly one corrective re-ask, fired only by an id-set finding', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');
  const IMAGES = read('server/lib/images.js');
  const LABEL = "usageLabel: 'scene_iterate_declared_set'";

  it('there is one re-ask call, not a retry loop, and the budget re-ask is gone', () => {
    expect(IMAGES.split(LABEL).length - 1).toBe(1);
    expect(IMAGES).not.toContain('scene_iterate_budget');
  });

  it('the re-ask sits inside the finding branch and carries the specific ids', () => {
    const branch = IMAGES.indexOf('if (declaredSetFindings.length > 0) {');
    const call = IMAGES.indexOf(LABEL);
    expect(branch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(branch);
    const body = IMAGES.slice(branch, call);
    expect(body).toContain('describeBriefFindings(declaredSetFindings)');
    // no other paid call between the branch and the re-ask
    expect(body.split('callClaudeAPI(').length - 1).toBe(1);
  });

  it('the re-ask is taken only when it shrinks the breach and does not regress the declaration check', () => {
    expect(IMAGES).toContain('recitedFindings.length < declaredSetFindings.length');
    expect(IMAGES).toContain('(recitedDeclarations || []).length <= consistencyFindings.length');
  });

  it('no rewrite is measured by length anywhere on the iterate path', () => {
    for (const rel of ['server/lib/iterateBeat.js', 'server/lib/images.js', 'server/lib/promptBuilders.js', 'prompts/scene-iteration.txt', 'prompts/scene-iteration-free.txt']) {
      expect(read(rel), rel).not.toMatch(/BRIEF_BUDGET|briefBudget|brief_over_budget|computeBriefBudget|BRIEF_GROWTH_FACTOR/);
    }
  });
});

// ── The page range gates BOTH staging sites ────────────────────────────────

describe('a Visual Bible id outside its page range is refused at both staging sites', () => {
  it('the creature is not staged on p13 or p16 off its plan-line name (bible range [17,18])', () => {
    expect(entity('ANI003').pages).toEqual([17, 18]);
    for (const n of [13, 16]) {
      expect(pageOf(n).planLine).toContain(entity('ANI003').name);
      expect(stagedOn(n).map((f: any) => f.id)).not.toContain('ANI003');
    }
  });

  it('an in-range figure the plan line names is staged (p16 dog, p10 crow)', () => {
    expect(stagedOn(16).map((f: any) => f.id)).toEqual(['ANI001']);
    expect(stagedOn(10).map((f: any) => f.id)).toContain('ANI002');
  });

  it('an entry with no range is staged off the plan line as before', () => {
    const noRange = { ...VB, animals: VB.animals.map((a: any) => (a.id === 'ANI003' ? { id: a.id, name: a.name, description: a.description } : a)) };
    expect(stagedOn(13, pageOf(13).original, noRange).map((f: any) => f.id)).toContain('ANI003');
  });

  it('an id the previous brief already cites is lineage and stays staged even out of range', () => {
    expect(stagedOn(13, { objects: ['ANI003'], characters: [] }).map((f: any) => f.id)).toContain('ANI003');
  });

  it('the allow-list scrubs exactly the ids the declared-set check flags', () => {
    for (const [n, expected] of [[13, ['LOC002', 'LOC003', 'ANI003']], [16, ['LOC003', 'ANI003']], [7, ['LOC003']], [2, []], [10, []]] as Array<[number, string[]]>) {
      const pg = pageOf(n);
      const { kept, scrubbed } = partitionAnchoredObjects({
        rewriteObjects: pg.rewrite.objects, origObjects: pg.original.objects,
        evaluationFeedback: pg.evaluationFeedback, pageText: pg.pageText, planLine: pg.planLine,
        visualBible: VB, pageNumber: n,
      });
      expect(scrubbed.map(base), `p${n}`).toEqual(expected);
      expect([...kept, ...scrubbed].length).toBe(pg.rewrite.objects.length);
    }
  });

  it('the allow-list keeps an original id and a feedback-named id regardless of range', () => {
    const pg = pageOf(13);
    const asked = { ...pg.evaluationFeedback, fixableIssues: [{ description: 'LOC003 is missing' }] };
    const { kept } = partitionAnchoredObjects({
      rewriteObjects: ['ART001.2', 'LOC003.2'], origObjects: ['ART001.2'],
      evaluationFeedback: asked, pageText: pg.pageText, planLine: pg.planLine, visualBible: VB, pageNumber: 13,
    });
    expect(kept.map(base)).toEqual(['ART001', 'LOC003']);
  });

  it('an id with no range falls through to the token anchor', () => {
    const vb = { locations: [{ id: 'LOC009', name: 'Lantern bridge', description: 'an old stone bridge lined with lanterns' }] };
    const args = { rewriteObjects: ['LOC009'], origObjects: [], evaluationFeedback: null, planLine: '', visualBible: vb, pageNumber: 4 };
    expect(partitionAnchoredObjects({ ...args, pageText: 'They crossed the bridge at dusk.' }).kept).toEqual(['LOC009']);
    expect(partitionAnchoredObjects({ ...args, pageText: 'They sat by the fire.' }).scrubbed).toEqual(['LOC009']);
  });
});

// ── vbEntityCoversPage reads structured ranges only ────────────────────────

describe('vbEntityCoversPage reads the bible\'s structured range and nothing else', () => {
  it('an id whose range EXCLUDES this page is refused; one whose range INCLUDES it is allowed', () => {
    expect(vbEntityCoversPage(entity('ANI003'), 16)).toBe(false);
    expect(vbEntityCoversPage(entity('ANI003'), 18)).toBe(true);
    expect(vbEntityCoversPage(entity('ART001'), 16)).toBe(true);
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
