import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// THE BOOK AUDIT READS THE BOOK THAT SHIPS (owner, 2026-09-13).
//
// The mid-loop/final book audit is the reader's-eye pass: page text and page
// picture, together, in order. It routed IMG faults into the next repair round
// while being handed PRE-REFINE prose, because the text-refine join ran AFTER
// runUnifiedRepairPipeline (storyJobPipeline.js) while the audit lives inside
// it (server/lib/repairPipeline.js, MID-LOOP BOOK AUDIT).
//
// Measured on 12 staging stories: the refiner rewrote 172 of 178 pages (97%);
// on job_1789304198359_y3n0euk3z 426 of 1009 shipped words were absent from the
// text the audit read. The stored audits are almost entirely faults of the form
// "the picture contradicts the text" — judged against prose the book never had.
//
// These tests pin BEHAVIOUR, never prompt wording:
//   - the audit's page list carries the FINAL text and the PICKED image version
//   - the text-refine join happens before the repair pipeline runs
//   - neither the stale-text expression nor the late join can be rebuilt

// @ts-expect-error - JS module without types
import { buildAuditPages } from '../../server/lib/bookAudit.js';

const pick = (map: Record<number, any>) => (pageNumber: number) => map[pageNumber] || null;

describe('buildAuditPages — the page list the judge reads', () => {
  it('carries the page text it is given, verbatim (post-refine wording by the time it runs)', () => {
    const pages = buildAuditPages(
      [{ pageNumber: 1, text: 'Refined wording.', imageData: 'data:image/png;base64,AAA' }],
      null
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe('Refined wording.');
  });

  it('takes the PICKED version, not the page object\'s own bytes', () => {
    const pages = buildAuditPages(
      [{ pageNumber: 3, text: 't', imageData: 'data:image/png;base64,ORIGINAL' }],
      pick({ 3: { source: 'iterate-round-2', imageData: 'data:image/png;base64,PICKED' } })
    );
    expect(pages[0].imageData).toBe('data:image/png;base64,PICKED');
  });

  it('falls back to the page image when the picker has no version for that page', () => {
    const pages = buildAuditPages(
      [{ pageNumber: 4, text: 't', imageData: 'data:image/png;base64,ORIGINAL' }],
      pick({})
    );
    expect(pages[0].imageData).toBe('data:image/png;base64,ORIGINAL');
  });

  it('a page whose picked version is the original keeps the original — last version never wins by position', () => {
    const original = { source: 'original', imageData: 'data:image/png;base64,ORIGINAL' };
    const pages = buildAuditPages(
      [{ pageNumber: 5, text: 't', imageData: 'data:image/png;base64,STALE' }],
      pick({ 5: original })
    );
    expect(pages[0].imageData).toBe('data:image/png;base64,ORIGINAL');
  });

  it('drops a page with no resolvable image rather than sending it text-only', () => {
    const pages = buildAuditPages(
      [
        { pageNumber: 1, text: 'a', imageData: null },
        { pageNumber: 2, text: 'b', imageData: 'data:image/png;base64,B' },
      ],
      pick({})
    );
    expect(pages.map((p: any) => p.pageNumber)).toEqual([2]);
  });

  it('is defensive about junk input — a missing list is an empty audit, not a throw', () => {
    expect(buildAuditPages(null, null)).toEqual([]);
    expect(buildAuditPages([null, { text: 'no page number', imageData: 'x' }], null)).toEqual([]);
  });
});

describe('wiring: the audit cannot be rebuilt on stale text or a stale version', () => {
  const repair = fs.readFileSync(new URL('../../server/lib/repairPipeline.js', import.meta.url), 'utf8');
  const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');

  it('repairPipeline builds the audit pages through the shared resolver', () => {
    expect(repair).toContain('buildAuditPages');
    // The exact regressed expression: the audit page list assembled inline off
    // the page object, which is where the pre-refine text came from.
    expect(repair).not.toMatch(/return\s*\{\s*pageNumber:\s*img\.pageNumber,\s*text:\s*img\.text,\s*imageData\s*\}/);
  });

  it('the text-refine join runs BEFORE the repair pipeline that contains the audit', () => {
    const join = pipeline.indexOf('await joinTextRefinement([rawImages])');
    const run = pipeline.indexOf('await runUnifiedRepairPipeline(');
    expect(join).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(join).toBeLessThan(run);
  });

  it('the join is defined once and is idempotent — the late call cannot re-join', () => {
    expect(pipeline).toContain('const joinTextRefinement = async (targets = []) => {');
    expect(pipeline).toMatch(/if \(textRefineJoined\) return;\s*\n\s*textRefineJoined = true;/);
    // Exactly one definition, and both call sites go through it.
    expect(pipeline.match(/const joinTextRefinement =/g)).toHaveLength(1);
    expect(pipeline.match(/await joinTextRefinement\(/g)).toHaveLength(2);
  });

  it('the refined text is written back to the page objects the pipeline was handed, not only to expandedScenes', () => {
    // `rawImages[].text` is a COPY taken when the page was prepared, so the
    // scene-level rewrite alone would leave the audit on the old prose.
    expect(pipeline).toMatch(/for \(const list of targets\) \{[\s\S]{0,200}?img\.text = t;/);
  });
});
