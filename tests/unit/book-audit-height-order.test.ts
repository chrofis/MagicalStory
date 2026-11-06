/**
 * THE BOOK REVIEW READS THE HEIGHT ORDER (2026-11-07, docs/decisions.md).
 * The reader gets the same HEIGHT ORDER line the painter got, per page, for
 * the drawn cast only; `height_order` is a registered, MAJOR-capped, redraw type.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';

const require_ = createRequire(import.meta.url);
const bookAudit = require_('../../server/lib/bookAudit.js');
const { CONSOLIDATED_TYPES, TYPE_TO_BUCKET, BUCKETS } = require_('../../server/lib/evalBuckets.js');
const scoring = require_('../../server/lib/scoring.js');
const review = require_('../../server/lib/bookReview.js');
const { buildRelativeHeightDescription } = require_('../../server/lib/promptBuilders.js');
const { NOT_INPAINTABLE_TYPES, ITERATE_ROUTED_TYPES } = require_('../../server/lib/repairLogic.js');

const girls = [
  { name: 'Polina', physical: { height: '106' } },
  { name: 'Melodi', physical: { height: '111' } },
  { name: 'Janna', physical: { height: '115' } },
  { name: 'Melisa', physical: { height: '121' } },
];

describe('auditPageHeightLine', () => {
  it('is the generator line over exactly the drawn cast', () => {
    const line = bookAudit.auditPageHeightLine(['Janna', 'polina', 'Melisa'], { characters: girls });
    expect(line).toBe(buildRelativeHeightDescription([girls[0], girls[2], girls[3]]));
    expect(line).toContain('HEIGHT ORDER (shortest to tallest):** Polina (shortest) -> Janna -> Melisa');
    expect(line).not.toContain('Melodi');
  });
  it('is empty for one drawn figure, nobody, or unknown names', () => {
    expect(bookAudit.auditPageHeightLine(['Janna'], { characters: girls })).toBe('');
    expect(bookAudit.auditPageHeightLine([], { characters: girls })).toBe('');
    expect(bookAudit.auditPageHeightLine(['Ghost', 'Janna'], { characters: girls })).toBe('');
    expect(bookAudit.auditPageHeightLine(['Janna', 'Polina'], {})).toBe('');
  });
  it('reaches the brief line after the outfits', () => {
    const heightLine = bookAudit.auditPageHeightLine(['Janna', 'Melisa'], { characters: girls });
    const l = bookAudit.briefLine('PAGE 3', { cast: ['Janna', 'Melisa'], sceneIntent: 'They run.', outfits: { Janna: 'red coat' }, heightLine });
    expect(l.endsWith(heightLine)).toBe(true);
    expect(l.indexOf('what each wears')).toBeLessThan(l.indexOf('HEIGHT ORDER'));
  });
});

describe('height_order type registration', () => {
  it('is in the closed list, the bucket tables, the consolidator template and the audit prompt', () => {
    expect(CONSOLIDATED_TYPES).toContain('height_order');
    expect(TYPE_TO_BUCKET.height_order).toBe('height_order');
    expect(BUCKETS.height_order.repair).toBe('regen');
    expect(fs.readFileSync('prompts/feedback-consolidator.txt', 'utf8')).toContain('`height_order`');
    expect(fs.readFileSync('prompts/book-audit.txt', 'utf8')).toContain('HEIGHT ORDER');
  });
  it('is capped at MAJOR on both issue shapes', () => {
    expect(scoring.deductionPoints({ type: 'height_order', severity: 'critical' }))
      .toBe(scoring.deductionPoints({ type: 'x', severity: 'major' }));
    expect(scoring.deductionPoints({ type: 'consistency', subType: 'height_order', severity: 'catastrophic' }))
      .toBe(scoring.deductionPoints({ type: 'x', severity: 'major' }));
  });
  it('routes to a page redo, never an inpaint', () => {
    expect(NOT_INPAINTABLE_TYPES.has('height_order')).toBe(true);
    expect(ITERATE_ROUTED_TYPES.has('height_order')).toBe(true);
    const pick = review.chooseMethod([{ route: { kind: 'NEW' }, type: 'height_order', severity: 'MAJOR', page: 1, detail: 'x' }]);
    expect(pick.method).toBe('iterate');
  });
});
