import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

/**
 * Object size, asked in ONE call PER QUALIFYING PROP, over that prop's pages.
 *
 * Every shape of this question has been measured on job_1789759147125_p08djwhbl
 * (truth by eye: the egg is larger on p3 1.69x and p5 1.83x, smaller on p9
 * 0.65x, the rest 0.94-1.32):
 *  - inside the audit's six-page chunks: 0 of 3 outliers, 2 false positives.
 *  - one call, ALL props: "SMALLER: egg p8, p9, p14, p16" — the WRONG direction
 *    for a book whose visible defect is a giant egg, plus 3 false positives.
 *  - one call PER PROP (what ships): "LARGER: egg p4, p5" + "SMALLER: egg p8,
 *    p16" from the shipped builder, byte-identical over two runs — the worst
 *    offender (p5) and the borderline small page (p8) caught, p3 and p9 missed,
 *    p4 (1.22) and p16 (0.94) named in error.
 *  - folded into the reading call: that call fell from 16 faults to 5 and 6.
 *
 * These tests pin the shipped shape: one call per prop, only that prop's pages,
 * its own separate call; the animal exclusion (an animal's drawn size moves
 * with its pose, so an outlier named for one is meaningless by nature) and the
 * declared-size requirement, which together reduce this story to ONE call; the
 * >= 4-pages scoping; per-page numeric estimates forbidden; an empty answer
 * permitted; a missing answer becoming `notEvaluated` rather than a clean
 * result; and the finding never entering the repair routing.
 */

const scale = require_('../../server/lib/objectScaleAudit.js');

describe('scoping — declared-size, non-animal bible props with enough pages', () => {
  const storyData = {
    visualBible: {
      artifacts: [
        { id: 'ART001', name: 'large egg', label: 'dragon egg', scaleClass: 'melon' },
        // No band and no stored free-text size: nothing declares how big it
        // should be, so "drawn larger than it should be" has no referent and
        // the call is not spent.
        { id: 'ART002', name: 'unsized lantern', label: 'brass lantern' },
      ],
      // Excluded by construction: an animal's apparent size moves with its
      // pose. Both of these are cited on 5 pages and carry a band; neither is
      // ever asked about.
      animals: [
        { id: 'ANI001', name: 'Nia', scaleClass: 'knee' },
        { id: 'ANI002', name: 'Raven', scaleClass: 'melon' },
      ],
      // Generic entries are dropped at parse time WITH NO ID; a page can never
      // cite one, which is why no second generic gate is implemented here.
      genericObjects: [{ name: 'basket', collection: 'artifacts' }],
      clothing: [{ id: 'CLO001', name: 'tunic', scaleClass: 'melon' }],
      locations: [{ id: 'LOC001', name: 'the square', scaleClass: 'house' }],
      mainCharacters: [{ id: 'CHR001', name: 'the child', scaleClass: 'adult' }],
    },
    sceneImages: [
      { pageNumber: 2, sceneMetadata: { objects: ['ART001', 'ART002', 'ANI001', 'ANI002', 'CLO001', 'LOC001.1'] } },
      { pageNumber: 3, sceneMetadata: { objects: ['ART001', 'ART002', 'ANI001', 'ANI002'] } },
      { pageNumber: 5, sceneMetadata: { objects: ['ART001.2', 'ART002', 'ANI001', 'ANI002'] } },
      { pageNumber: 9, sceneMetadata: { objects: ['ART001', 'ART002', 'ANI001', 'ANI002'] } },
      { pageNumber: 14, sceneMetadata: { objects: ['ART001', 'ART002', 'ANI001', 'ANI002', 'CHR001'] } },
    ],
  };
  const pages = [2, 3, 5, 9, 14];

  it('the prop cited on 5 pages is a candidate, dotted state ids included', () => {
    const { candidates } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.map((c: any) => c.id)).toContain('ART001');
    expect(candidates.find((c: any) => c.id === 'ART001').pages).toEqual([2, 3, 5, 9, 14]);
  });

  it('ANIMALS ARE NEVER ASKED ABOUT — a raven with its wings out is not a bigger raven', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, pages);
    const seen = [...candidates, ...skipped].map((r: any) => r.id);
    expect(seen).not.toContain('ANI001');
    expect(seen).not.toContain('ANI002');
    expect(scale.SCALE_COLLECTIONS).not.toContain('animals');
  });

  it('a prop with NO declared size is skipped and SAYS SO — the call is not spent', () => {
    const { candidates, skipped } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.map((c: any) => c.id)).not.toContain('ART002');
    expect(skipped.find((r: any) => r.id === 'ART002').reason).toBe('no_declared_size');
  });

  it('a pre-enum bible with only free-text `size` still qualifies', () => {
    const legacy = {
      ...storyData,
      visualBible: {
        ...storyData.visualBible,
        artifacts: [{ id: 'ART001', label: 'dragon egg', size: 'about as big as a football' }],
      },
    };
    const { candidates } = scale.selectScaleObjects(legacy, pages);
    expect(candidates.map((c: any) => c.id)).toEqual(['ART001']);
  });

  it('together the gates reduce this story to ONE call', () => {
    const { candidates } = scale.selectScaleObjects(storyData, pages);
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe('ART001');
  });

  it('an element on fewer than 4 pages is skipped and SAYS SO', () => {
    const thin = {
      ...storyData,
      sceneImages: [
        { pageNumber: 2, sceneMetadata: { objects: ['ART001'] } },
        { pageNumber: 3, sceneMetadata: { objects: ['ART001'] } },
        { pageNumber: 5, sceneMetadata: { objects: ['ART001'] } },
      ],
    };
    const { candidates, skipped } = scale.selectScaleObjects(thin, pages);
    expect(candidates.map((c: any) => c.id)).not.toContain('ART001');
    expect(skipped.find((r: any) => r.id === 'ART001').reason).toBe('too_few_pages');
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

describe('the question — ONE prop, outliers only, no numbers, "none" allowed', () => {
  const candidate = { id: 'ART001', label: 'dragon egg', pages: [2, 3, 5, 9, 14] };

  it('names ONE object and every page it is on, because one prop is asked at a time', () => {
    const { text, asked } = scale.buildScaleQuestion(candidate, [2, 3, 5, 9, 14]);
    expect(asked.id).toBe('ART001');
    expect(asked.batchPages).toEqual([2, 3, 5, 9, 14]);
    expect(text).toMatch(/dragon egg/);
    expect(text).toMatch(/p2, p3, p5, p9, p14/);
    // ONE object, singular — the all-props phrasing measured worse.
    expect(text).toMatch(/One recurring object appears on the pages named/);
  });

  it("a second prop is not mentioned in the first prop's question", () => {
    const { text } = scale.buildScaleQuestion(candidate, [2, 3, 5, 9, 14]);
    expect(text).not.toMatch(/Raven|brass lantern/);
  });

  it('only pages whose image the audit resolved are named', () => {
    const { text, asked } = scale.buildScaleQuestion(candidate, [2, 3, 4, 5, 6, 7]);
    expect(asked.batchPages).toEqual([2, 3, 5]);
    expect(text).toMatch(/p2, p3, p5/);
    expect(text).not.toMatch(/p9|p14/);
  });

  it('asks for departures, not a ratio, and permits "none"', () => {
    const { text } = scale.buildScaleQuestion(candidate, [2, 3, 5]);
    expect(text).toMatch(/significantly LARGER/);
    expect(text).toMatch(/significantly SMALLER/);
    expect(text).toMatch(/SCALE: none/);
    expect(text).toMatch(/Do not estimate a size, a ratio, a percentage/i);
    expect(text).toMatch(/do not write a page-by-page list/i);
  });

  it('a single page in the batch cannot be compared, so nothing is asked', () => {
    const { text, asked } = scale.buildScaleQuestion(candidate, [2, 20, 21]);
    expect(asked).toBeNull();
    expect(text).toBe('');
  });

  it('no candidate means the reviewer never hears about size', () => {
    expect(scale.buildScaleQuestion(null, [1, 2, 3]).text).toBe('');
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
  it('names the pages and carries the measured recall, not a verdict', () => {
    const t = scale.buildScaleFinding('dragon egg', [3, 5], []);
    expect(t).toMatch(/p3, p5/);
    expect(t).toMatch(/LOW CONFIDENCE/);
    // Whoever reads the report must know the recall WITHOUT opening
    // decisions.md: it catches the worst offender, names the occasional page
    // sitting at the book's average, and misses the milder outliers.
    expect(t).toMatch(/named the worst size outlier in the book/i);
    expect(t).toMatch(/two pages that merely sit near the book's own average size/i);
    expect(t).toMatch(/missed two milder outliers/i);
    expect(t).toMatch(/go and look/i);
    expect(t).toMatch(/nothing is repainted/i);
  });

  it('a quiet run is explicitly not proof the object is consistent', () => {
    const t = scale.buildScaleFinding('dragon egg', [], [9]);
    expect(t).toMatch(/drawn smaller on p9/);
    expect(t).toMatch(/do not read a quiet run as proof/i);
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

describe('the wiring — ONE call PER PROP, in its own call, never per chunk', () => {
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

  it("each prop gets its OWN call, carrying only that prop's pages", async () => {
    const calls: any[] = [];
    const parts = [1, 2, 3, 5, 9, 14, 18].map(n => ({ pageNumber: n, part: { inline_data: { mime_type: 'image/jpeg', data: `img${n}` } } }));
    const candidates = [
      { id: 'ART001', label: 'dragon egg', pages: [2, 3, 5, 9, 14] },
      { id: 'VEH001', label: 'wooden cart', pages: [3, 5, 18] },
    ];
    const mod = require_('../../server/lib/bookAudit.js');
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
      // ONE call per prop — never all props in one, never one per chunk.
      expect(calls.length).toBe(2);
      expect(got.length).toBe(2);
      expect(got[0].pages).toEqual([2, 3, 5, 9, 14]);   // p1/p18 have no egg
      expect(got[1].pages).toEqual([3, 5, 18]);

      const eggParts = calls[0].contents[0].parts;
      const eggQuestion = eggParts[0].text;
      expect(eggQuestion).toMatch(/OBJECT SIZE/);
      expect(eggQuestion).toMatch(/p2, p3, p5, p9, p14/);
      expect(eggQuestion).toMatch(/Do not estimate a size, a ratio, a percentage/i);
      // The second prop is not named in the first prop's question.
      expect(eggQuestion).not.toMatch(/wooden cart/);
      expect(eggParts.filter((p: any) => p.inline_data).length).toBe(5);
      expect(eggParts.map((p: any) => p.text).filter(Boolean).join(' ')).toMatch(/PAGE 2.*PAGE 14/s);

      const cartQuestion = calls[1].contents[0].parts[0].text;
      expect(cartQuestion).toMatch(/wooden cart/);
      expect(cartQuestion).not.toMatch(/dragon egg/);
      expect(calls[1].contents[0].parts.filter((p: any) => p.inline_data).length).toBe(3);
      expect(got[0].raw).toMatch(/SCALE\[LARGER\]/);
    } finally {
      (globalThis as any).fetch = original;
    }
  });

  it('nothing qualifying means no call is made at all', async () => {
    const before = (globalThis as any).fetch;
    let called = 0;
    (globalThis as any).fetch = async () => { called++; throw new Error('should not be called'); };
    try {
      expect(await bookAudit.askObjectScale([], [{ pageNumber: 1, part: {} }], 'm', null)).toEqual([]);
      expect(called).toBe(0);
    } finally {
      (globalThis as any).fetch = before;
    }
  });

  it('the question is asked in its OWN call, never inside the reading call', () => {
    // Folding it into the (whole-book) audit call was built and measured on
    // 2026-09-19 and reverted: the reader's-eye pass returned 5 and 6 faults
    // with the size question appended, against 16 without it on the same story.
    expect(src).toMatch(/await judgeChunk\(template, chunk, modelId, thinkingLevel\)/);
    expect(src.match(/await judgeChunk\(/g)?.length).toBe(1);
    expect(src.match(/await askObjectScale\(/g)?.length).toBe(1);
    expect(src).not.toMatch(/foldedScale|scaleQuestion/);
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
