import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * Object size, asked ONCE per story over every page the prop appears on.
 *
 * The first shipped shape asked it inside the book audit's six-page chunks and
 * MEASURED NOTHING: on job_1789759147125_p08djwhbl the egg's nine pages were
 * split across three calls, so "larger than on the other pages" was only ever
 * asked of a fragment — 0 of 3 true outliers, 2 false positives. The whole-book
 * ask then scored 1 of 3 on the same story (the small outlier; both large ones
 * missed), in its OWN call — an 18-page book makes 4 audit calls, not 3. These tests
 * pin the fix: the question is built over the WHOLE book, it is sent in its own
 * single call with the pages the prop is on, and it is no longer wired into the
 * chunk prompt at all.
 *
 * They also keep pinning what the earlier measurement bought: per-page numeric
 * estimates are forbidden (ignoring that ban truncated a read), an empty answer
 * is permitted, the >= 4-pages and bible-prop scoping hold, a missing answer
 * becomes `notEvaluated` rather than a clean result, and the finding never
 * enters the repair routing.
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

  it('names the object and EVERY page it is on, because the whole book is asked at once', () => {
    const { text, asked } = scale.buildScaleQuestion(candidates, [2, 3, 5, 9, 14]);
    expect(asked.map((a: any) => a.id)).toEqual(['ART001']);
    expect(asked[0].batchPages).toEqual([2, 3, 5, 9, 14]);
    expect(text).toMatch(/dragon egg/);
    expect(text).toMatch(/p2, p3, p5, p9, p14/);
  });

  it('only pages whose image the audit resolved are named', () => {
    const { text, asked } = scale.buildScaleQuestion(candidates, [2, 3, 4, 5, 6, 7]);
    expect(asked[0].batchPages).toEqual([2, 3, 5]);
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
  it('names the pages and carries the measured LOW CONFIDENCE, not a verdict', () => {
    const t = scale.buildScaleFinding('dragon egg', [3, 5], []);
    expect(t).toMatch(/p3, p5/);
    expect(t).toMatch(/LOW CONFIDENCE/);
    // The real-story validation: 1 of 3 true outliers, both LARGE ones missed,
    // 2-3 false positives. The finding must carry that, not a rosier number.
    expect(t).toMatch(/1 of 3 true outliers/);
    expect(t).toMatch(/missed both pages where the object was drawn too LARGE/);
    expect(t).toMatch(/go and look/i);
    expect(t).toMatch(/nothing is repainted/i);
  });

  it('labels the smaller side with its measured, mixed record', () => {
    const t = scale.buildScaleFinding('dragon egg', [], [9]);
    expect(t).toMatch(/weaker/i);
    // Not a flat "this side is weak": on the validation story SMALLER was the
    // only direction that hit anything at all.
    expect(t).toMatch(/hit on the validation story/i);
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

describe('the wiring — ONE complete ask, not one per chunk', () => {
  const template = fs.readFileSync(path.join(process.cwd(), 'prompts/book-audit.txt'), 'utf8');
  const { fillTemplate } = require_('../../server/services/prompts.js');
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/bookAudit.js'), 'utf8');
  const bookAudit = require_('../../server/lib/bookAudit.js');

  it("the reader-eye template no longer carries the size question at all", () => {
    expect(template).not.toMatch(/OBJECT_SCALE_QUESTION/);
    expect(template).not.toMatch(/OBJECT SIZE/);
    expect(src).not.toMatch(/OBJECT_SCALE_QUESTION/);
    const built = fillTemplate(template, { PAGE_LIST: '1, 2', TEXT_NOT_A_CHECKLIST: 'rule' });
    expect(built).toMatch(/FAULT\[IMG\]/);
    expect(built).not.toMatch(/\{[A-Z_]+\}/);
  });

  it("the question is asked over the whole book in a single call, with only the prop pages", async () => {
    const calls: any[] = [];
    const parts = [1, 2, 3, 5, 9, 14].map(n => ({ pageNumber: n, part: { inline_data: { mime_type: 'image/jpeg', data: `img${n}` } } }));
    const candidates = [{ id: 'ART001', label: 'dragon egg', pages: [2, 3, 5, 9, 14] }];
    const mod = require_('../../server/lib/bookAudit.js');
    // The real function, with the vendor dispatch swapped out.
    const original = (globalThis as any).fetch;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'SCALE[LARGER]: dragon egg — p3, p5' }] }, finishReason: 'STOP' }],
          usageMetadata: {},
        }),
      } as any;
    };
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
    try {
      const got = await mod.askObjectScale(candidates, parts, 'gemini-2.5-flash', null);
      expect(calls.length).toBe(1);                       // ONE call, never per chunk
      expect(got.pages).toEqual([2, 3, 5, 9, 14]);        // p1 has no prop — not sent
      const sent = calls[0].contents[0].parts;
      const question = sent[0].text;
      expect(question).toMatch(/OBJECT SIZE/);
      expect(question).toMatch(/p2, p3, p5, p9, p14/);
      expect(question).toMatch(/Do not estimate a size, a ratio, a percentage/i);
      expect(sent.filter((p: any) => p.inline_data).length).toBe(5);
      expect(sent.map((p: any) => p.text).filter(Boolean).join(' ')).toMatch(/PAGE 2.*PAGE 14/s);
      expect(got.raw).toMatch(/SCALE\[LARGER\]/);
    } finally {
      (globalThis as any).fetch = original;
    }
  });

  it('nothing qualifying means no call is made at all', async () => {
    const before = (globalThis as any).fetch;
    let called = 0;
    (globalThis as any).fetch = async () => { called++; throw new Error('should not be called'); };
    try {
      expect(await bookAudit.askObjectScale([], [{ pageNumber: 1, part: {} }], 'm', null)).toBeNull();
      expect(called).toBe(0);
    } finally {
      (globalThis as any).fetch = before;
    }
  });

  it('the chunk loop knows nothing about scale — the loop call takes no question', () => {
    expect(src).toMatch(/await judgeChunk\(template, chunk, modelId, thinkingLevel\)/);
    expect(src.match(/await judgeChunk\(/g)?.length).toBe(1);
    expect(src.match(/await askObjectScale\(/g)?.length).toBe(1);
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
