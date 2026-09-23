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

  it('the live head-row prompt binds its neckline to the body row it was drawn from', () => {
    const t = read('server/lib/character2x4Sheet.js');
    expect(t).not.toMatch(/head and neck only, no shoulders, no torso, no clothing/);
    const { buildHeadRowPrompt } = require('../../server/lib/character2x4Sheet.js');
    expect(buildHeadRowPrompt({ name: 'A' }, 'a red shirt', true)).toMatch(/Where the neckline shows, it is the one Image 3 wears/);
  });

  it('the head-row evaluator checks the garment, not only that something is worn', () => {
    const t = read('prompts/sheet-row-heads-eval.txt');
    expect(t).toMatch(/TASK 3: COVERAGE AND GARMENT/);
    expect(t).toMatch(/it is the garment REQUESTED_OUTFIT names/);
    expect(t).toMatch(/a collared polo where a plain crew neck was asked for — scores 1-3/);
    // The placeholder must exist or the check has nothing to compare against.
    // It is FILLED for the heads row only since 2026-09-14 — see the wiring
    // test below; before that the judge received the literal token.
    expect(t).toMatch(/\{REQUESTED_OUTFIT\}/);
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
 * 2026-09-14 — the dungaree fault. Naming the garment's PARTS was already in
 * force (prompts/story-bible-from-beats.txt) and both contracts spelled them
 * out; the sheet still drew straps over separate trousers in the body row and
 * no straps at all in the head row.
 *
 * Three roots, none of them the contract text (which arrives verbatim):
 *   1. buildHeadRowPrompt never received the costume — the head row was
 *      generated from the body IMAGE alone, so an ambiguous part was dropped.
 *   2. evaluateSheetRow filled {REQUESTED_OUTFIT} only on the 'bodies' branch,
 *      so the heads garment check shipped inert — the judge saw the literal
 *      token and had no outfit to compare against.
 *   3. Nothing said a garment named with its parts is ONE continuous piece, so
 *      a parts list invited a parts assembly.
 *
 * Pins the behaviour, not the wording.
 */
describe('a garment named with its parts is one garment, in both rows', () => {
  const sheet = require('../../server/lib/character2x4Sheet');
  const { buildBodyRowPrompt, buildHeadRowPrompt, buildGarmentRule } = sheet._internal;
  const OUTFIT = 'brown corduroy dungaree trousers — square bib panel over the chest held by two shoulder straps';

  it('the head-row prompt names the garment instead of inferring it from the body image', () => {
    const p = buildHeadRowPrompt({ name: 'A', physical: {} }, OUTFIT);
    expect(p).toContain(OUTFIT);
    // Without a costume it must not emit an empty "Costume:" line.
    expect(buildHeadRowPrompt({ name: 'A', physical: {} })).not.toMatch(/Costume:\s*$/m);
  });

  it('the generator says the parts are one continuous garment, not items worn together', () => {
    const rule = buildGarmentRule();
    expect(rule).toMatch(/ONE continuous piece/);
    expect(rule).toMatch(/cut in one with its trousers/);
    expect(rule).toMatch(/never straps laid over a separate pair of trousers/);
    // The row-agreement half lives in the SAME clause, so both rows inherit it
    // from one place rather than two drifting copies.
    expect(rule).toMatch(/both rows of the sheet show that same garment/);
    for (const p of [buildBodyRowPrompt(OUTFIT, null, false, null), buildHeadRowPrompt(null, OUTFIT)]) {
      expect(p).toContain(rule);
    }
  });

  it('the heads evaluator is actually given the outfit — the check is not inert', () => {
    // The garment check in the heads template names REQUESTED_OUTFIT. Until
    // 2026-09-14 fillTemplate ran only on the 'bodies' branch, so the heads
    // judge was handed the literal token: the check could never fire. Pin that
    // the fill is no longer conditional on the row.
    const src = read('server/lib/character2x4Sheet.js');
    const fn = src.slice(src.indexOf('async function evaluateSheetRow'));
    const body = fn.slice(0, fn.indexOf('\nasync function', 1));
    expect(body).toMatch(/REQUESTED_OUTFIT/);
    // The fill must no longer sit behind a bodies-only guard.
    expect(body).not.toMatch(/if \(which === 'bodies'\)[\s\S]{0,40}fillTemplate/);
    // And the production caller forwards it.
    expect(src).toMatch(/evaluateSheetRow\(headRowData, 'heads', \{ costumeDescription/);
    expect(src).toMatch(/reviewHeadRow\(res\.imageData, \{[^}]*costumeDescription/);

    // A filled heads prompt carries the outfit and no leftover placeholder.
    const { fillTemplate } = require('../../server/services/prompts');
    const filled = fillTemplate(read('prompts/sheet-row-heads-eval.txt'), {
      REQUESTED_OUTFIT: `REQUESTED_OUTFIT: ${OUTFIT}`,
    });
    expect(filled).not.toMatch(/\{REQUESTED_OUTFIT\}/);
    expect(filled).toContain(OUTFIT);
  });

  it('both row evaluators penalise a NAMED part that is missing, not only an invented one', () => {
    const heads = read('prompts/sheet-row-heads-eval.txt');
    expect(heads).toMatch(/A part the outfit DOES name and this row omits scores 1-3/);
  });

  it('the garment rule stays generic — no story nouns', () => {
    expect(buildGarmentRule()).not.toMatch(/Julian|Funkli|Drachenei|dungarees? are blue/i);
  });
});
