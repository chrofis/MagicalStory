/**
 * THE READER GETS THE BRIEF, AND NAMES ITS FINDING'S TYPE (2026-09-24).
 *
 * The book audit read only page text + picture, so a character the words name
 * but the brief never staged was charged as an image fault (prod
 * job_1790107559778_fcmlfa8kn p7, cast []: "Manuel absent"; 40 such IMG faults
 * over 17 stories). And its IMG lines reached the consolidator with no type,
 * so the consolidator invented one. Pinned: the brief line (cast from the ONE
 * roster + sceneIntent) reaches the judge; the closed type list is filled from
 * the same constant the consolidator's list is held to; the parser carries the
 * type through to the reader finding.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const { CONSOLIDATED_TYPES } = require_('../../server/lib/evalBuckets.js');
const { attributeReaderFindings } = require_('../../server/lib/repairLogic.js');

describe('parseRoutes carries the reader type', () => {
  it('reads [WEIGHT][type] on IMG lines and still parses the older shapes', () => {
    const r = bookAudit.parseRoutes([
      'FAULT[IMG][MAJOR][action_interaction]: p3 — the boy faces away',
      'FAULT[IMG][CRITICAL]: p4 — old shape',
      'FAULT[TEXT][MINOR]: p5 — words say night',
    ].join('\n'));
    expect(r.IMG[0]).toMatchObject({ page: 3, severity: 'MAJOR', type: 'action_interaction', detail: 'the boy faces away' });
    expect(r.IMG[1]).toMatchObject({ page: 4, severity: 'CRITICAL', type: null, detail: 'old shape' });
    expect(r.TEXT[0]).toMatchObject({ page: 5, severity: 'MINOR', type: null });
  });
  it('the type survives attribution to the audited version', () => {
    const v = { source: 'original' };
    const out = attributeReaderFindings([{ page: 3, severity: 'MAJOR', type: 'emotion', line: 'l' }], new Map([[3, v]]));
    expect(out.get(3).findings[0].type).toBe('emotion');
  });
});

describe('the brief line', () => {
  it('states an empty cast as nobody by design, never as unknown', () => {
    expect(bookAudit.briefLine('PAGE 7', { cast: [], sceneIntent: 'A tower at dusk.' }))
      .toBe('PAGE 7 BRIEF — the moment drawn: A tower at dusk. drawn with: nobody — no character is in this picture by design');
    expect(bookAudit.briefLine('PAGE 9', { cast: ['Lukas'], sceneIntent: '' })).toBe('PAGE 9 BRIEF — drawn with: Lukas');
    // A trailing full stop is trimmed, never a trailing letter.
    expect(bookAudit.briefLine('PAGE 2', { cast: null, sceneIntent: 'Two boys cross the rivers.' })).toBe('PAGE 2 BRIEF — the moment drawn: Two boys cross the rivers');
    expect(bookAudit.briefLine('PAGE -1', { cast: null, sceneIntent: '' })).toBeNull();
  });
  it('auditPageBrief resolves the cast through the evaluator roster and reads sceneIntent', () => {
    const b = bookAudit.auditPageBrief({
      pageNumber: 9, sceneCharacters: [{ name: 'Lukas' }], outlineCharacters: [],
      sceneMetadata: { sceneIntent: 'The boy reaches the summit.', characters: [{ name: 'Lukas' }], objects: [] },
    }, { characters: [{ name: 'Lukas' }], visualBible: null });
    expect(b.cast).toEqual(['Lukas']);
    expect(b.sceneIntent).toBe('The boy reaches the summit.');
    const empty = bookAudit.auditPageBrief({ pageNumber: 7, sceneCharacters: [], sceneMetadata: { characters: [], objects: [] } }, { characters: [] });
    expect(empty.cast).toEqual([]);
    expect(bookAudit.auditPageBrief({ pageNumber: -1 }, {}).cast).toBeNull();
  });
  it('buildAuditPages carries the brief inputs from the page record', () => {
    const [p] = bookAudit.buildAuditPages([{ pageNumber: 2, text: 't', imageData: 'x', sceneCharacters: ['A'], sceneMetadata: { sceneIntent: 'i' }, outlineCharacters: ['A'] }], null);
    expect(p.sceneCharacters).toEqual(['A']);
    expect(p.sceneMetadata.sceneIntent).toBe('i');
    expect(p.outlineCharacters).toEqual(['A']);
  });
});

describe('the closed type list is one list', () => {
  it('the consolidator template lists exactly CONSOLIDATED_TYPES, in order', () => {
    const t = fs.readFileSync('prompts/feedback-consolidator.txt', 'utf8');
    const line = t.split('\n').find(l => l.includes('`image_coherence` ·'))!;
    expect([...line.matchAll(/`([a-z_]+)`/g)].map(m => m[1])).toEqual([...CONSOLIDATED_TYPES]);
  });
  it('the book-audit template declares the placeholder the judge call fills', () => {
    const t = fs.readFileSync('prompts/book-audit.txt', 'utf8');
    expect(t).toContain('{FINDING_TYPES}');
    expect(t).toContain('FAULT[IMG][<WEIGHT>][<TYPE>]');
    const src = fs.readFileSync('server/lib/bookAudit.js', 'utf8');
    expect(src).toMatch(/FINDING_TYPES: require\('\.\/evalBuckets'\)\.CONSOLIDATED_TYPES/);
  });
});
