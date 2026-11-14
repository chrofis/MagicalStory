/**
 * Pipeline review 2026-11-13 finding 8: TEXT faults from every review round went to the corrective text
 * round, including ones written against a picture a later round replaced. Those are dropped now;
 * untouched pages keep every round's faults.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { shippingTextFaults } = require_('../../server/lib/bookReview.js');

const f = (page: number, words: string) => ({ page, line: `FAULT[TEXT][MINOR]: p${page} — ${words}` });

describe('shippingTextFaults', () => {
  const round0 = { round: 0, textFaults: [f(2, 'say the coat has toggles, not a zip'), f(5, 'say the lamp is lit')] };

  it('drops a fault on a page whose picture the re-review replaced (BETTER NEW)', () => {
    const r1 = { round: 1, repairedPages: [2], betterVerdicts: { 2: 'NEW' }, textFaults: [] };
    const { faults, dropped } = shippingTextFaults([round0, r1]);
    expect(faults.map((x: any) => x.page)).toEqual([5]);
    expect(dropped).toEqual([{ fault: round0.textFaults[0], round: 0, replacedInRound: 1 }]);
  });

  it('keeps it when the previous picture won (it still ships)', () => {
    const r1 = { round: 1, repairedPages: [2], betterVerdicts: { 2: 'PREVIOUS' }, textFaults: [] };
    expect(shippingTextFaults([round0, r1]).faults.map((x: any) => x.page)).toEqual([2, 5]);
  });

  it('keeps the re-review\'s own fault on the replaced page (it saw the shipped picture)', () => {
    const r1 = { round: 1, repairedPages: [2], betterVerdicts: { 2: 'NEW' }, textFaults: [f(2, 'say she holds the wand')] };
    expect(shippingTextFaults([round0, r1]).faults.map((x: any) => x.line)).toEqual([round0.textFaults[1].line, r1.textFaults[0].line]);
  });

  it('a later round\'s silence on an untouched page drops nothing, and duplicates go once', () => {
    const r1 = { round: 1, repairedPages: [], betterVerdicts: {}, textFaults: [round0.textFaults[1]] };
    expect(shippingTextFaults([round0, r1]).faults).toHaveLength(2);
  });

  it('the pipeline sends only these faults to the text round', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/const \{ faults: auditTextFaults, dropped: staleTextFaults \} = require\('\.\/server\/lib\/bookReview'\)\.shippingTextFaults\(pipelineBookAuditRounds\);/);
  });
});
