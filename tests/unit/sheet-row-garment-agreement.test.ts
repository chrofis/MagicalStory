/**
 * D15 — the two rows of a 2×4 reference sheet must wear the same garment.
 *
 * Evidence: the styled sheet for a commissioned child on
 * job_1789147573901_m3uam0nxi. Looking at the image: the four TOP cells wear a
 * red shirt with a BLUE COLLAR (a polo); the four BOTTOM cells wear a plain red
 * crew T-shirt. The story's clothing contract says "A red short-sleeved cotton
 * T-shirt" — so the bottom row is right and the top row invented a collar.
 *
 * The pages then copied whichever row they anchored on: p1, p3 and p8 drew the
 * polo, the other fifteen drew the crew. It was never a page-render drift.
 * `stackRowsInto2x4(headRowData, bodyRowData)` builds the sheet from two
 * INDEPENDENT generations, and every garment check ran within one row.
 *
 * Owner ruling 2026-09-11: the head row MAY show clothing — and the garment
 * belongs in the checks. This file pins that the generation prompts and both
 * evaluators agree on it, since they previously contradicted each other (the
 * sheet spec said "no clothing" in row 1 while the head-row evaluator awarded
 * coverage points for a clothed shoulder).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the head row may be clothed, in the SAME garment as the body row', () => {
  it('the styled 2x4 generation prompt binds row 1 to the requested costume', () => {
    const t = read('prompts/styled-costumed-avatar-2x4.txt');
    expect(t).not.toMatch(/No shoulders, no clothing visible/);
    expect(t).toMatch(/Row 1 \(top\) — head and shoulders/);
    expect(t).toMatch(/it is the same garment row 2 wears/);
    expect(t).toMatch(/never a collar, placket, hood or trim row 2 does not have/);
  });

  it('no evaluator still demands a clothing-free top row', () => {
    for (const f of ['prompts/styled-costumed-avatar-2x4.txt']) {
      expect(read(f)).not.toMatch(/no clothing/i);
    }
  });

  it('the 2x2 IDENTITY sheet is untouched — its top quadrants stay face-only', () => {
    // Different artifact, different purpose: a tight photoreal face crop with
    // no neck. The ruling was about the styled 2x4 sheet the pages anchor on.
    for (const f of ['prompts/avatar-main-prompt.txt', 'prompts/avatar-ace-prompt.txt']) {
      expect(read(f)).toMatch(/No shoulders, no neck, no clothing visible/);
    }
  });
});

/**
 * 2026-09-14 — the dungaree fault: a garment named with its PARTS drew straps over separate trousers. Since 2026-10-10 the sheet is
 * ONE call (one prompt for both rows), so the one prompt carries the rule that the parts are one piece and that the top row wears the
 * neckline of the body below.
 */
describe('the one-call sheet prompt binds the top row to the body row and names named parts as one garment', () => {
  const { buildOneCallSheetPrompt } = require('../../server/lib/character2x4Sheet.js');
  const P = (desc: string) => buildOneCallSheetPrompt({ name: 'A' }, { costumeDescription: desc, styleLine: 'watercolour', kind: 'costume' });
  it('the top row wears the neckline the body below wears', () => {
    expect(P('a red shirt')).toMatch(/neckline in the top row is the one the body below wears/);
  });
  it('the parts of a named garment are one continuous piece', () => {
    expect(P('a bib-and-brace garment')).toMatch(/ONE continuous piece, not separate items worn together/);
  });
  it('the garment rule stays generic — no story nouns', () => {
    expect(require('../../server/lib/character2x4Sheet')._internal.buildGarmentRule()).not.toMatch(/Omar|chestnut|hedgehog|Rohrdorf|Lukas/i);
  });
});
