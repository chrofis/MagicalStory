import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * Cross-page object scale, added to the final book audit 2026-09-19.
 *
 * The measured basis these pin (job_1789759147125_p08djwhbl, CHF ~1.9):
 * per-page ratios are order-dependent (5 of 9 verdicts flipped on a reshuffle);
 * the OUTLIER question answered across three shuffled orders intersected to
 * exactly the true outliers with zero false positives, while every SINGLE
 * run's list carried false positives; and 1 run in 4 returned nothing after
 * ignoring the "no per-page numbers" instruction.
 *
 * So the three things that must not drift are: the intersection is an AND and
 * never a majority, fewer than three usable reads is NOT-EVALUATED rather than
 * a partial answer, and the built prompt forbids per-page numbers.
 */

const scale = require_('../../server/lib/objectScaleAudit.js');
const bookAudit = require_('../../server/lib/bookAudit.js');

describe('intersection, not majority — a page must survive every shuffled read', () => {
  it('a page named by 3 of 3 lists is reported', () => {
    expect(scale.intersectOutliers([[3, 5], [5, 3, 7], [3, 5, 2]])).toEqual([3, 5]);
  });

  it('a page named by 2 of 3 lists is NOT reported', () => {
    // p7 and p2 are the measured false positives: each appeared in one run.
    const got = scale.intersectOutliers([[3, 5, 7], [3, 5, 7], [3, 5]]);
    expect(got).toEqual([3, 5]);
    expect(got).not.toContain(7);
  });

  it('a page named by exactly one list never survives', () => {
    expect(scale.intersectOutliers([[9], [4], [2]])).toEqual([]);
  });

  it('the worked case reproduces: p3/p5 larger survive, the rest do not', () => {
    const reads = [
      { larger: [3, 5, 7], smaller: [9] },
      { larger: [2, 3, 5], smaller: [9, 4] },
      { larger: [3, 5, 4], smaller: [] },
    ];
    expect(scale.intersectOutliers(reads.map(r => r.larger))).toEqual([3, 5]);
    // The smaller side is the weak one — the third order dropped p9 entirely,
    // so the intersection is empty. That is the honest answer, not a miss.
    expect(scale.intersectOutliers(reads.map(r => r.smaller))).toEqual([]);
  });
});

describe('a reply that does not answer is a missing read, not an empty one', () => {
  it('a reply with neither line parses as null', () => {
    expect(scale.parseScaleReply('I estimate the object is 0.18 of the child on page 3...')).toBeNull();
    expect(scale.parseScaleReply('')).toBeNull();
  });

  it('an explicit "none" is a real, empty answer', () => {
    expect(scale.parseScaleReply('LARGER: none\nSMALLER: none')).toEqual({ larger: [], smaller: [] });
  });

  it('page markers are read with or without the p prefix', () => {
    expect(scale.parseScaleReply('LARGER: p3, p5\nSMALLER: 9')).toEqual({ larger: [3, 5], smaller: [9] });
  });
});

describe('scoping — only bible props, only with enough pages to average over', () => {
  const storyData = {
    visualBible: {
      artifacts: [{ id: 'ART001', name: 'large egg', label: 'dragon egg' }],
      animals: [{ id: 'ANI001', name: 'Nia' }, { id: 'ANI002', name: 'Raven' }],
      // Generic entries are dropped at parse time WITH NO ID; a page can never
      // cite one, which is why no second generic gate is implemented here.
      genericObjects: [{ name: 'basket', collection: 'artifacts' }],
      clothing: [{ id: 'CLO001', name: 'tunic' }],
      locations: [{ id: 'LOC001', name: 'the square' }],
      mainCharacters: [{ id: 'CHR001', name: 'the child' }],
    },
    sceneImages: [
      { pageNumber: 2, sceneMetadata: { objects: ['ART001', 'CLO001', 'LOC001.1'] } },
      { pageNumber: 3, sceneMetadata: { objects: ['ART001', 'ANI001'] } },
      { pageNumber: 5, sceneMetadata: { objects: ['ART001.2', 'ANI001'] } },
      { pageNumber: 9, sceneMetadata: { objects: ['ART001', 'ANI002'] } },
      { pageNumber: 14, sceneMetadata: { objects: ['ART001', 'CHR001'] } },
    ],
  };
  const pages = [2, 3, 5, 9, 14];

  it('the prop cited on 5 pages is a candidate', () => {
    const { candidates } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.map((c: any) => c.id)).toContain('ART001');
    expect(candidates.find((c: any) => c.id === 'ART001').pages).toEqual([2, 3, 5, 9, 14]);
  });

  it('a dotted state id counts toward its base entry', () => {
    const { candidates } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.find((c: any) => c.id === 'ART001').pages).toContain(5);
  });

  it('an element on fewer than 4 pages is skipped and SAYS SO', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.map((c: any) => c.id)).not.toContain('ANI001');   // 2 pages
    expect(candidates.map((c: any) => c.id)).not.toContain('ANI002');   // 1 page
    const reasons = skipped.filter((s: any) => s.id === 'ANI001' || s.id === 'ANI002');
    expect(reasons.length).toBe(2);
    for (const r of reasons) expect(r.reason).toBe('too_few_pages');
  });

  it('clothing, locations and characters are never scale candidates', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, pages);
    const seen = [...candidates, ...skipped].map((r: any) => r.id);
    expect(seen).not.toContain('CLO001');
    expect(seen).not.toContain('LOC001');
    expect(seen).not.toContain('CHR001');
  });

  it('a generic entry has no id, so it is invisible to the check', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, pages);
    const labels = [...candidates, ...skipped].map((r: any) => r.label);
    expect(labels).not.toContain('basket');
  });

  it('a page whose image the audit could not read does not count toward the threshold', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, [2, 3, 5]);
    expect(candidates.map((c: any) => c.id)).not.toContain('ART001');
    expect(skipped.find((s: any) => s.id === 'ART001').reason).toBe('too_few_pages');
  });
});

describe('the shuffle is real and per call', () => {
  const pages = [2, 3, 4, 5, 7, 8, 9, 14, 16];

  it('two seeds give two different orders over the same pages', () => {
    const a = scale.shuffleWithSeed(pages, 1);
    const b = scale.shuffleWithSeed(pages, 2);
    expect(a).not.toEqual(b);
  });

  it('a shuffle keeps every page exactly once', () => {
    const a = scale.shuffleWithSeed(pages, 7);
    expect([...a].sort((x, y) => x - y)).toEqual(pages);
  });

  it('a seed is reproducible', () => {
    expect(scale.shuffleWithSeed(pages, 42)).toEqual(scale.shuffleWithSeed(pages, 42));
  });
});

describe('the finding reports both directions and their different strength', () => {
  it('names the larger side as the agreed, reliable one', () => {
    const t = scale.buildScaleFinding('dragon egg', [3, 5], []);
    expect(t).toMatch(/p3, p5/);
    expect(t).toMatch(/reliable/i);
    expect(t).toMatch(/nothing is repainted/i);
  });

  it('marks the smaller side as the weaker direction', () => {
    const t = scale.buildScaleFinding('dragon egg', [], [9]);
    expect(t).toMatch(/weaker/i);
    expect(t).toMatch(/pointer, not a verdict/i);
  });

  it('no outliers means no finding at all', () => {
    expect(scale.buildScaleFinding('dragon egg', [], [])).toBeNull();
  });
});

describe('the BUILT prompt — through the real template and the real builder', () => {
  const template = fs.readFileSync(path.join(process.cwd(), 'prompts/book-audit.txt'), 'utf8');
  const { fillTemplate } = require_('../../server/services/prompts.js');
  const split = bookAudit.splitBookAuditTemplate(template);

  it('the scale section is present and split off the reader pass', () => {
    expect(split.scale).toBeTruthy();
    // The reading pass must not inherit "output the two lines and nothing else".
    expect(split.reading).not.toMatch(/LARGER:/);
    expect(split.reading).toMatch(/FAULT\[IMG\]/);
  });

  it('the built scale prompt forbids per-page numeric estimates', () => {
    const built = fillTemplate(split.scale, { OBJECT_LABEL: 'dragon egg' });
    expect(built).toMatch(/Do not estimate a size, a ratio, a percentage/i);
    expect(built).toMatch(/do not write a page-by-page list/i);
  });

  it('the built scale prompt asks only for outliers, and allows an empty answer', () => {
    const built = fillTemplate(split.scale, { OBJECT_LABEL: 'dragon egg' });
    expect(built).toMatch(/LARGER:/);
    expect(built).toMatch(/SMALLER:/);
    expect(built).toMatch(/Either list may be empty/i);
    expect(built).toMatch(/dragon egg/);
    // fillTemplate drops undeclared placeholders silently — no token may survive.
    expect(built).not.toMatch(/\{[A-Z_]+\}/);
  });
});

describe('the wiring — reported, never repaired, and absences use notEvaluated', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/bookAudit.js'), 'utf8');

  it('fewer than MIN_ANSWERS usable reads records notEvaluated, not a verdict', () => {
    expect(src).toMatch(/if \(lists\.length < scaleLib\.MIN_ANSWERS\)/);
    expect(src).toMatch(/notEvaluated\.record\('object_scale', 'insufficient_scale_reads'/);
  });

  it('it retries before giving up — the truncation case', () => {
    expect(src).toMatch(/const maxCalls = scaleLib\.SCALE_CALLS \+ scaleLib\.MIN_ANSWERS/);
  });

  it('three reads are required and three calls are made', () => {
    expect(scale.SCALE_CALLS).toBe(3);
    expect(scale.MIN_ANSWERS).toBe(3);
    expect(scale.MIN_PAGES).toBe(4);
  });

  it('the scale result is its own field and never enters byRoute', () => {
    const fn = src.slice(src.indexOf('async function auditObjectScale'), src.indexOf('/** Pull routed fault lines'));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toMatch(/byRoute/);
    expect(src).toMatch(/^\s+objectScale,\s*$/m);
  });

  it('it uses the shared notEvaluated recorder, not a parallel mechanism', () => {
    expect(src).toMatch(/require\('\.\/notEvaluated'\)\.createNotEvaluatedRecorder/);
  });
});
