/**
 * Two repair-loop bugs on production job_1790107559778_fcmlfa8kn (2026-09-23).
 *
 * 1. READER FINDINGS WERE CHARGED TO THE WRONG VERSION. The book audit reads each
 *    page's picked version; its IMG faults went into a page-keyed map that the NEXT
 *    round handed to the consolidator of the version that round had just painted.
 *    p5 v3 was billed a CATASTROPHIC reader line describing v0's pixels. Now each
 *    finding is bound to the version object the audit read, and only that version
 *    is re-consolidated with it.
 *
 * 2. A PAGE WRITTEN FOR NOBODY LOOPED ON CHAR-FIX. p7's declared cast is []; Grok
 *    drew two children, the entity check read one as a roster girl with a CRITICAL
 *    age_shift, and all three rounds went to char-fixes that produced no image. A
 *    cast-0 page now routes drawn figures to iterate, and a char-fix that failed
 *    on a version is never repeated on that version.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { attributeReaderFindings, decideRepairMethod } = require('../../server/lib/repairLogic');
const { derivePresenceFinding } = require('../../server/lib/evalPipeline');

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineSrc = readFileSync(path.join(here, '../../server/lib/repairPipeline.js'), 'utf8');

describe('reader findings belong to the version the audit read', () => {
  const v0 = { source: 'original', imageData: 'data:image/jpeg;base64,AAAA' };
  const v1 = { source: 'iterate-round-1', imageData: 'data:image/jpeg;base64,BBBB' };

  it('binds every page-scoped fault to the audited version object, verbatim', () => {
    const faults = [
      { page: 5, severity: 'CATASTROPHIC', line: 'FAULT[IMG][CATASTROPHIC]: p5 — a' },
      { page: 5, severity: 'MAJOR', line: 'FAULT[IMG][MAJOR]: p5 — b' },
      { page: 8, severity: 'MINOR', line: 'FAULT[IMG][MINOR]: p8 — c' },
    ];
    const out = attributeReaderFindings(faults, new Map([[5, v0], [8, v1]]));
    expect(out.get(5).version).toBe(v0);
    expect(out.get(5).findings.map(f => f.line)).toEqual([faults[0].line, faults[1].line]);
    expect(out.get(8).version).toBe(v1);
    expect(out.get(5).findings[0].sources).toContain('reader');
  });

  it('drops a fault with no page, and one on a page the audit read no version of', () => {
    const out = attributeReaderFindings(
      [{ page: null, severity: 'MAJOR', line: 'x' }, { page: 9, severity: 'MAJOR', line: 'y' }],
      new Map([[5, v0]]));
    expect(out.size).toBe(0);
  });

  it('the pipeline has ONE route for reader findings: the re-score of the audited version', () => {
    // The page-keyed map that leaked findings onto the next round's new version is gone.
    expect(pipelineSrc).not.toMatch(/readerFindingsByPage/);
    // Every consolidatePageEval call passes reader findings only from the rescore.
    const calls = pipelineSrc.match(/consolidatePageEval\([^)]*\)/g) || [];
    const withFindings = calls.filter(c => c.split(',').length >= 6);
    expect(withFindings).toEqual(['consolidatePageEval(ev, entityResult.issues, pageNumber, round, version.description || null, findings)']);
    // The audit is read from the same map the findings are attributed through.
    expect(pipelineSrc).toMatch(/buildAuditPages\(rawImages, \(pageNumber\) => auditedVersionByPage\.get\(pageNumber\)/);
    expect(pipelineSrc).toMatch(/attributeReaderFindings\(audit\.byRoute\.IMG, auditedVersionByPage\)/);
  });
});

describe('a page written for nobody is never char-fixed', () => {
  const ROSTER = [{ name: 'Sophie' }, { name: 'Lukas' }];
  const SCORES = { scoreBreakdown: { visual: { score: 70 }, semantic: { score: 60 } }, finalScore: 30, qualityScore: 70 };
  const ENTITY_CRIT = {
    characters: {
      Sophie: { issues: [{ type: 'age_shift', subType: 'age_shift', severity: 'CRITICAL', pageNumber: 7, pagesToFix: [7], description: 'looks younger' }] },
    },
  };
  const EXTRA = { type: 'extra_character', severity: 'critical', sources: ['quality'], description: 'Two person-figures present despite EXPECTED CAST of 0' };
  const EMOTION = { type: 'emotion', severity: 'major', character: 'girl', sources: ['semantic'], description: 'smiling' };

  it('p7 shape: extra_character + entity CRITICAL on a roster name → iterate, not char-fix', () => {
    const d = decideRepairMethod(7, { ...SCORES, consolidatedPlan: { deduped_issues: [EXTRA, EMOTION] } }, ENTITY_CRIT,
      { characters: ROSTER, expectedCast: [] });
    expect(d.method).toBe('iterate');
    expect(d.reason).toMatch(/expected cast is empty/);
  });

  it('an entity CRITICAL alone on a cast-0 page also routes to iterate', () => {
    const d = decideRepairMethod(7, { ...SCORES, fixableIssues: [] }, ENTITY_CRIT, { characters: ROSTER, expectedCast: [] });
    expect(d.method).toBe('iterate');
  });

  it('a clothing finding on a cast-0 page is not a figure redo', () => {
    const d = decideRepairMethod(7, {
      ...SCORES,
      fixableIssues: [{ type: 'clothing', severity: 'MAJOR', character: 'Sophie', description: 'wrong coat' }],
    }, null, { characters: ROSTER, expectedCast: [] });
    expect(d.method).not.toBe('char-fix');
  });

  it('a declared cast that holds the character keeps the char-fix route', () => {
    const d = decideRepairMethod(7, { ...SCORES, fixableIssues: [] }, ENTITY_CRIT,
      { characters: ROSTER, expectedCast: [{ name: 'Sophie' }] });
    expect(d.method).toBe('char-fix');
  });

  it('an undeclared cast (null) has no opinion', () => {
    const d = decideRepairMethod(7, { ...SCORES, fixableIssues: [] }, ENTITY_CRIT, { characters: ROSTER, expectedCast: null });
    expect(d.method).toBe('char-fix');
  });

  it('the derived extra_character on a roster of 0 asks for removal, not a redraw as a cast entry', () => {
    const r = derivePresenceFinding({
      figures: [{ id: 1 }, { id: 2 }],
      matches: [{ figure: 1, reference: 'unmatched', confidence: 0 }, { figure: 2, reference: 'unmatched', confidence: 0 }],
      cast: { names: [], count: 0, declared: true, crowdExpected: false, block: '' },
      detectedFigureCount: 2,
    });
    expect(r.outcome).toBe('extra_character');
    expect(r.finding.fix).toBe('Remove this figure: the page is written with no one in it.');
  });
});

describe('a failed char-fix is not repeated on the same version', () => {
  const ROSTER = [{ name: 'Sophie' }];
  const SCORES = { scoreBreakdown: { visual: { score: 70 }, semantic: { score: 60 } }, finalScore: 40, qualityScore: 70 };
  const ENTITY_CRIT = {
    characters: { Sophie: { issues: [{ type: 'age_shift', severity: 'CRITICAL', pageNumber: 3, pagesToFix: [3], description: 'x' }] } },
  };

  it('entity CRITICAL: char-fix the first time, iterate once a char-fix failed on this version', () => {
    expect(decideRepairMethod(3, { ...SCORES }, ENTITY_CRIT, { characters: ROSTER }).method).toBe('char-fix');
    const d = decideRepairMethod(3, { ...SCORES }, ENTITY_CRIT, { characters: ROSTER, failedMethods: ['char-fix'] });
    expect(d.method).toBe('iterate');
    expect(d.reason).toMatch(/char-fix already failed/);
  });

  it('clothing figure redo flips the same way', () => {
    const ev = { ...SCORES, fixableIssues: [{ type: 'clothing', severity: 'MAJOR', character: 'Sophie', description: 'x' }] };
    expect(decideRepairMethod(3, ev, null, { characters: ROSTER }).method).toBe('char-fix');
    expect(decideRepairMethod(3, ev, null, { characters: ROSTER, failedMethods: ['char-fix'] }).method).toBe('iterate');
  });

  it('a failure of another method does not block char-fix', () => {
    expect(decideRepairMethod(3, { ...SCORES }, ENTITY_CRIT, { characters: ROSTER, failedMethods: ['inpaint'] }).method).toBe('char-fix');
  });

  it('the pipeline records each failure on the version it was attempted on and feeds it back', () => {
    expect(pipelineSrc).toMatch(/parent\.failedRepairs = \[\.\.\.\(parent\.failedRepairs \|\| \[\]\), \{ method: baseRepairMethod\(f\.method\)/);
    expect(pipelineSrc).toMatch(/failedMethods: \(bestSoFar\?\.failedRepairs \|\| \[\]\)\.map\(f => f\.method\)/);
    expect(pipelineSrc).toMatch(/expectedCast: resolveDeclaredCast\(bestSoFar\?\.sceneCharacters, img\.sceneCharacters\)/);
  });
});
