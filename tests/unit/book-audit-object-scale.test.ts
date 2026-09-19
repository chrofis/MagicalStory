import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * Object size, asked as ONE MORE QUESTION inside the book audit's existing
 * call (owner's ruling 2026-09-19: "The reviewer runs once and answers many
 * questions; one explicit question is if the prop is too big or too small
 * compared to other pages").
 *
 * What these pin: no extra API call, the question reaches the BUILT prompt,
 * per-page numeric estimates are forbidden (ignoring that ban truncated a read
 * in testing), an empty answer is permitted, the >= 4-pages and bible-prop
 * scoping hold, a missing answer becomes `notEvaluated` rather than a clean
 * result, and the finding never enters the repair routing.
 */

const scale = require_('../../server/lib/objectScaleAudit.js');

describe('scoping — only bible props, only with enough pages to compare against', () => {
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

  it('the prop cited on 5 pages is a candidate, dotted state ids included', () => {
    const { candidates } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.map((c: any) => c.id)).toContain('ART001');
    expect(candidates.find((c: any) => c.id === 'ART001').pages).toEqual([2, 3, 5, 9, 14]);
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

describe('the question — outliers only, no numbers, "none" allowed', () => {
  const candidates = [{ id: 'ART001', label: 'dragon egg', pages: [2, 3, 5, 9, 14] }];

  it('names the object and the pages of THIS batch', () => {
    const { text, asked } = scale.buildScaleQuestion(candidates, [2, 3, 4, 5, 6, 7]);
    expect(asked.map((a: any) => a.id)).toEqual(['ART001']);
    expect(text).toMatch(/dragon egg/);
    expect(text).toMatch(/p2, p3, p5/);
    expect(text).not.toMatch(/p9|p14/);
  });

  it('asks for departures, not a ratio, and permits "none"', () => {
    const { text } = scale.buildScaleQuestion(candidates, [2, 3, 5]);
    expect(text).toMatch(/significantly LARGER/);
    expect(text).toMatch(/significantly SMALLER/);
    expect(text).toMatch(/SCALE: none/);
    expect(text).toMatch(/Do not estimate a size, a ratio, a percentage/i);
    expect(text).toMatch(/do not write a page-by-page list/i);
  });

  it('a single page in the batch cannot be compared, so nothing is asked', () => {
    const { text, asked } = scale.buildScaleQuestion(candidates, [2, 20, 21]);
    expect(asked).toEqual([]);
    expect(text).toBe('');
  });

  it('no candidates means the reviewer never hears about size', () => {
    expect(scale.buildScaleQuestion([], [1, 2, 3]).text).toBe('');
  });
});

describe('reading the answer out of the reviewer\'s ordinary reply', () => {
  it('reads the routed SCALE lines', () => {
    const got = scale.parseScaleAnswer([
      'FAULT[IMG][MINOR]: p3 — something unrelated',
      'SCALE[LARGER]: dragon egg — p3, p5',
      'SCALE[SMALLER]: dragon egg — p9',
    ].join('\n'));
    expect(got.larger['dragon egg']).toEqual([3, 5]);
    expect(got.smaller['dragon egg']).toEqual([9]);
  });

  it('an explicit "SCALE: none" is a real, empty answer', () => {
    const got = scale.parseScaleAnswer('FAULTS: 0\nSCALE: none');
    expect(got).toEqual({ larger: {}, smaller: {} });
  });

  it('a reply with no scale answer at all is MISSING, not clean', () => {
    expect(scale.parseScaleAnswer('FAULT[TEXT][MAJOR]: p2 — x\nFAULTS: 1')).toBeNull();
    expect(scale.parseScaleAnswer('')).toBeNull();
  });
});

describe('the finding is honest about a single read, and never repairs', () => {
  it('names the pages and warns that one read carries false positives', () => {
    const t = scale.buildScaleFinding('dragon egg', [3, 5], []);
    expect(t).toMatch(/p3, p5/);
    expect(t).toMatch(/One read/i);
    expect(t).toMatch(/check by eye/i);
    expect(t).toMatch(/nothing is repainted/i);
  });

  it('marks the smaller side as the weaker direction', () => {
    expect(scale.buildScaleFinding('dragon egg', [], [9])).toMatch(/weaker/i);
  });

  it('no departures means no finding at all', () => {
    expect(scale.buildScaleFinding('dragon egg', [], [])).toBeNull();
  });

  it('there is no intersection, quorum or shuffle left in the module', () => {
    expect(scale.intersectOutliers).toBeUndefined();
    expect(scale.shuffleWithSeed).toBeUndefined();
    expect(scale.SCALE_CALLS).toBeUndefined();
    expect(scale.MIN_ANSWERS).toBeUndefined();
  });
});

describe('collecting the answer — a missing answer is notEvaluated', () => {
  const bookAudit = require_('../../server/lib/bookAudit.js');
  const { createNotEvaluatedRecorder } = require_('../../server/lib/notEvaluated.js');
  const asked = new Map([['ART001', { id: 'ART001', label: 'dragon egg', pages: [2, 3, 5, 9, 14] }]]);

  it('an answered reply produces a finding for the pages it named', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'book' });
    const r = bookAudit.collectObjectScale(['SCALE[LARGER]: dragon egg — p3, p5'], asked, rec);
    expect(r.objects[0].larger).toEqual([3, 5]);
    expect(r.findings.length).toBe(1);
    expect(rec.isEmpty()).toBe(true);
  });

  it('a page the object is not on is never accepted from the reply', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'book' });
    const r = bookAudit.collectObjectScale(['SCALE[LARGER]: dragon egg — p3, p8'], asked, rec);
    expect(r.objects[0].larger).toEqual([3]);
  });

  it('an explicit "none" is clean — a finding-free result, not an absence', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'book' });
    const r = bookAudit.collectObjectScale(['SCALE: none'], asked, rec);
    expect(r.findings).toEqual([]);
    expect(r.objects[0].evaluated).toBe(true);
    expect(rec.isEmpty()).toBe(true);
  });

  it('asked but not answered → notEvaluated, never a clean result', () => {
    const rec = createNotEvaluatedRecorder({ pageContext: 'book' });
    const r = bookAudit.collectObjectScale(['FAULTS: 0'], asked, rec);
    expect(r.findings).toEqual([]);
    expect(r.objects[0].evaluated).toBe(false);
    const list = rec.list();
    expect(list.map((e: any) => e.dimension)).toContain('object_scale');
    expect(list.map((e: any) => e.reason)).toContain('no_scale_answer');
  });
});

describe('the BUILT prompt and the wiring — one call, no extra calls', () => {
  const template = fs.readFileSync(path.join(process.cwd(), 'prompts/book-audit.txt'), 'utf8');
  const { fillTemplate } = require_('../../server/services/prompts.js');
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/bookAudit.js'), 'utf8');

  it('the template carries the question placeholder and no separate pass', () => {
    expect(template).toMatch(/\{OBJECT_SCALE_QUESTION\}/);
    expect(template).not.toMatch(/===OBJECT-SCALE PASS===/);
  });

  it('the question reaches the built prompt through the real filler', () => {
    const { text } = scale.buildScaleQuestion(
      [{ id: 'ART001', label: 'dragon egg', pages: [2, 3, 5] }], [2, 3, 5]);
    const built = fillTemplate(template, {
      PAGE_LIST: '2, 3, 5',
      TEXT_NOT_A_CHECKLIST: 'rule',
      OBJECT_SCALE_QUESTION: text,
    });
    expect(built).toMatch(/ONE MORE QUESTION — OBJECT SIZE/);
    expect(built).toMatch(/dragon egg/);
    expect(built).toMatch(/Do not estimate a size, a ratio, a percentage/i);
    expect(built).toMatch(/FAULT\[IMG\]/);          // the existing questions survive
    expect(built).not.toMatch(/\{[A-Z_]+\}/);       // nothing left unfilled
  });

  it('an empty question leaves the reviewer\'s prompt as it was', () => {
    const built = fillTemplate(template, {
      PAGE_LIST: '1, 2',
      TEXT_NOT_A_CHECKLIST: 'rule',
      OBJECT_SCALE_QUESTION: '',
    });
    expect(built).not.toMatch(/OBJECT SIZE/);
    expect(built).toMatch(/FAULT\[IMG\]/);
  });

  it('the question rides in judgeChunk — there is no second call site', () => {
    expect(src).toMatch(/OBJECT_SCALE_QUESTION: scaleQuestion/);
    // Exactly one place sends a book-audit request per chunk.
    expect(src.match(/await judgeChunk\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/intersectOutliers|shuffleWithSeed|MIN_ANSWERS|maxCalls/);
  });

  it('the scale result is its own field and never enters byRoute', () => {
    const fn = src.slice(src.indexOf('function collectObjectScale'), src.indexOf('/** Pull routed fault lines'));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toMatch(/byRoute/);
    expect(src).toMatch(/^\s+objectScale,\s*$/m);
  });

  it('it uses the shared notEvaluated recorder, not a parallel mechanism', () => {
    expect(src).toMatch(/require\('\.\/notEvaluated'\)\.createNotEvaluatedRecorder/);
  });
});
