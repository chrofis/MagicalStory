import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { entityIssuesForPage, entityFindingsForPage, entityFindingPages } = require('../../server/lib/scoring.js');
const { collectAllIssuesForPage } = require('../../server/lib/images.js');
const { selectCharRepairTasks, decideRepairMethod } = require('../../server/lib/repairLogic.js');
const { flattenEntityIssues } = require('../../server/lib/feedbackConsolidator.js');
const { mergeEntityIssues } = require('../../server/lib/repairPipeline.js');

// Shape from staging job_1790100385959_1nitlympp (dragon run 6), 2026-09-24:
// the final entity report is assembled from the shipped picks and dedupes one
// finding across pages into pageNumbers [11,12] next to a lone pageNumber 11.
const multiPage = (extra: Record<string, unknown> = {}) => ({
  type: 'clothing_inconsistent',
  subType: 'clothing_inconsistent',
  severity: 'MAJOR',
  description: 'The character is missing the outer garment.',
  pageNumbers: [11, 12],
  pageNumber: 11,
  ...extra,
});
const face = (pages: number[]) => ({
  type: 'face_mismatch', subType: 'face_mismatch', severity: 'CRITICAL',
  description: 'The face reads as a different child.', pageNumbers: pages, pageNumber: pages[0],
});

describe('a finding that names several pages counts on each page, once', () => {
  it('bills and lists the finding on every page in pageNumbers', () => {
    const report = { characters: { Kiaan: { issues: [multiPage()] } } };
    for (const page of [11, 12]) {
      const billed = entityIssuesForPage(page, report);
      expect(billed.issues).toHaveLength(1);
      expect(billed.penalty).toBeGreaterThan(0);
      const listed = collectAllIssuesForPage({}, { finalChecksReport: { entity: report } }, page)
        .filter((i: any) => i.source === 'entity check');
      expect(listed).toHaveLength(1);
    }
    expect(entityIssuesForPage(13, report).issues).toHaveLength(0);
  });

  it('is not double-counted when pagesToFix, pageNumbers and pageNumber all name the page', () => {
    const report = { characters: { Kiaan: { issues: [multiPage({ pagesToFix: [11, 12] })] } } };
    expect(entityFindingsForPage(11, report)).toHaveLength(1);
    expect(entityFindingsForPage(12, report)).toHaveLength(1);
    expect(entityFindingPages(multiPage({ pagesToFix: [11, 12] }))).toEqual([11, 12]);
  });

  it('pagesToFix is the routing field and wins over the first-cell pageNumbers', () => {
    expect(entityFindingPages({ pagesToFix: [5], pageNumbers: [3], pageNumber: 3 })).toEqual([5]);
    expect(entityFindingPages({ pageNumber: 4 })).toEqual([4]);
    expect(entityFindingPages({ pageNumbers: [] })).toEqual([]);
  });

  it('char-fix targets each named page, and decideRepairMethod sees it on the second page', () => {
    const report = { characters: { Kiaan: { issues: [face([11, 12])] } } };
    const { tasks } = selectCharRepairTasks(report, { maxTasks: 10 });
    expect(tasks.map((t: any) => t.pageNumber).sort()).toEqual([11, 12]);
    const pages = entityFindingsForPage(12, report);
    expect(pages).toHaveLength(1);
  });

  it('the consolidator gets the finding on each of its pages', () => {
    const report = { characters: { Kiaan: { issues: [multiPage()] } } };
    expect(flattenEntityIssues(report, 12)).toHaveLength(1);
    expect(flattenEntityIssues(report, 13)).toHaveLength(0);
  });

  it('the round merge keeps a base finding on its pages that were not re-checked', () => {
    const base = { characters: { Kiaan: { issues: [multiPage({ pagesToFix: [11, 12] })] } } };
    const fresh = { characters: { Kiaan: { issues: [] } } };
    const merged = mergeEntityIssues(base, fresh, [12]);
    expect(entityIssuesForPage(11, merged).issues).toHaveLength(1);
    expect(entityIssuesForPage(12, merged).issues).toHaveLength(0);
  });
});

describe('a wardrobe finding on a page that takes the garment off by design costs nothing', () => {
  const offReport = (issue: Record<string, unknown>) => ({
    characters: { Kiaan: { issues: [issue], declaredOffByPage: { 11: ['ART004'], 12: ['ART004'] } } },
  });

  it('judged against the wearing grid: 0 points, excused, never a repair input', () => {
    const report = offReport(multiPage({ clothingCategory: 'standard' }));
    for (const page of [11, 12]) {
      const billed = entityIssuesForPage(page, report);
      expect(billed.penalty).toBe(0);
      expect(billed.issues).toHaveLength(0);
      expect(billed.excused).toHaveLength(1);
      expect(billed.excused[0].declaredOffIds).toEqual(['ART004']);
      expect(flattenEntityIssues(report, page)).toHaveLength(0);
      const listed = collectAllIssuesForPage({}, { finalChecksReport: { entity: report } }, page)
        .filter((i: any) => i.source === 'entity check');
      expect(listed).toHaveLength(0);
    }
  });

  it('an unknown grid on an off page is excused too (the judge cannot be shown to have known the state)', () => {
    expect(entityIssuesForPage(11, offReport(multiPage())).penalty).toBe(0);
  });

  it('judged in the page\'s own off-state grid: still counts', () => {
    const report = offReport(multiPage({ clothingCategory: 'standard--off:ART004' }));
    expect(entityIssuesForPage(11, report).issues).toHaveLength(1);
    expect(entityIssuesForPage(11, report).penalty).toBeGreaterThan(0);
  });

  it('a page that declares nothing off still charges the same finding', () => {
    const report = { characters: { Kiaan: { issues: [multiPage({ pageNumbers: [9], pageNumber: 9, clothingCategory: 'standard' })], declaredOffByPage: { 11: ['ART004'] } } } };
    expect(entityIssuesForPage(9, report).issues).toHaveLength(1);
  });

  it('a non-wardrobe finding on an off page still counts and still routes to char-fix', () => {
    const report = offReport(face([11]));
    expect(entityIssuesForPage(11, report).issues).toHaveLength(1);
    expect(selectCharRepairTasks(report, { maxTasks: 10 }).tasks).toHaveLength(1);
  });

  it('an off-by-design finding is no char-fix target', () => {
    const report = offReport(multiPage({ severity: 'CRITICAL', clothingCategory: 'standard' }));
    expect(selectCharRepairTasks(report, { maxTasks: 10 }).tasks).toHaveLength(0);
    const d = decideRepairMethod(11, { score: 50, fixableIssues: [] }, report);
    expect(JSON.stringify(d)).not.toMatch(/char/i);
  });

  it('the round merge carries each page\'s declared state from the check that read it', () => {
    const base = { characters: { Kiaan: { issues: [], declaredOffByPage: { 11: ['ART004'], 12: ['ART004'] } } } };
    const fresh = { characters: { Kiaan: { issues: [], declaredOffByPage: {} } } };
    const merged = mergeEntityIssues(base, fresh, [12]);
    expect(merged.characters.Kiaan.declaredOffByPage).toEqual({ 11: ['ART004'] });
  });
});
