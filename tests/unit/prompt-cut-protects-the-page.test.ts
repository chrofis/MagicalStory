import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// THE CUT PAYS WITH GENERIC GUIDANCE, NEVER WITH THE PAGE.
//
// An over-cap image prompt is fitted by `shrinkPromptForModel`. What it spends
// to get under the cap is the whole question: the generic rule paragraphs are
// identical on every page of every book, while the scene prose, the cast list,
// AGE & PROPORTIONS and WORN ITEMS are the only statement of what THIS page is.
//
// Production job_1789975900382_dyc1g7wue (trial, fr-ch, 2026-09-21) shipped
// with that trade inverted. Its pages 4 and 5 cite a Visual Bible object, so
// their prompts carry a REQUIRED OBJECTS block; the cut of the day protected
// everything from `**REQUIRED OBJECTS` onward WHOLE and paid for it out of the
// head alone, so a 5,497-char tail against the Grok-edit budget left a
// 1,022-char head budget — exactly the two opening rule paragraphs. Both stored
// prompts end their head at index 1022, mid-prompt, with AGE & PROPORTIONS,
// WORN ITEMS, the character reference list, the scene prose and
// Setting/Camera/Depth all deleted. Page 5's illustrator was never told the
// scene: it never named the second character and drew the wrong moment.
//
// Trial pages are the exposed path because they render through Grok EDIT, whose
// body budget is the model cap MINUS the edit prefix — a few hundred chars
// lower than the page budget, which is what pushes an object-citing page over.
//
// This test pins the trade, not the mechanism: whatever the cut does, a page's
// own facts outlive the guidance that is the same on every page.

// @ts-expect-error - JS module without types
import { shrinkPromptForModel } from '../../server/lib/images.js';

const TEMPLATE = fs.readFileSync(
  path.join(process.cwd(), 'prompts', 'image-generation.txt'),
  'utf-8'
);

/** A literal paragraph of the template, by its opening text. */
function templateParagraph(prefix: string): string {
  const para = TEMPLATE.split(/\n{2,}/)
    .map((x) => x.trim())
    .find((x) => x.startsWith(prefix));
  if (!para) throw new Error(`image-generation.txt has no paragraph starting "${prefix}"`);
  return para;
}

// The page's own facts. Each carries a sentinel the assertions look for.
const SCENE_PROSE =
  'The main character has just reached the far side of the ravine and is getting to their feet, ' +
  'one hand still on the taut rope that stretches back across the gap. SENTINEL_SECOND_CHARACTER ' +
  'stands just behind them at the tower entrance, eyes wide. Warm low light touches both figures. ' +
  // Real briefs run long: the prose describes each figure in reading order,
  // which is exactly why a byte-offset cut deletes the last-described one.
  'Leaves drift across the ledge and settle on the rock. The rope runs straight and level over '.repeat(9) +
  'the drop, both loops hooked over roots on either side.';

const PAGE_FACTS = [
  'AGE & PROPORTIONS (render each character at their real age, regardless of the action described):',
  '- The main character: kindergarten-age proportions, about 5 heads tall.',
  '',
  '**WORN ITEMS ON THIS PAGE (the attached references are not authoritative for these):**',
  '- The main character IS wearing this on this page: SENTINEL_WORN_GARMENT.',
  '',
  SCENE_PROSE,
  '',
  'Setting: SENTINEL_SETTING. Far side of the ravine, rocky ledge, late afternoon light.',
  'Camera: medium',
  'Depth: foreground: the rope anchored to a root; midground: the main character rising.',
].join('\n');

// Everything from `**REQUIRED OBJECTS` onward — the block that was treated as
// untouchable. Deliberately fat, so the tail alone nearly fills the budget:
// that is the shape that collapsed the head budget in production.
const TAIL = [
  '**REQUIRED OBJECTS IN THIS SCENE (each appears exactly as the scene description places it):**',
  '* **knotted rope** (object) — about as long as an adult\'s whole arm',
  '',
  '**ART STYLE:** ' + 'A painterly style with visible brushwork. '.repeat(70),
  '',
  templateParagraph('**REQUIRED CAST:**'),
  '',
  templateParagraph('**DEPTH AND SIZE:**'),
  '',
  templateParagraph('**COUNTS:**'),
  '',
  templateParagraph('**Composition:**'),
].join('\n\n');

const PROMPT = [
  templateParagraph('Generate a SINGLE illustration'),
  '',
  templateParagraph('When the FIRST reference photo'),
  '',
  PAGE_FACTS,
  '',
  TAIL,
].join('\n');

// The two real budgets: the page cap, and the lower Grok-edit body budget that
// a trial page is fitted to once the edit prefix is held out.
const PAGE_BUDGET = 7900;
const TRIAL_EDIT_BUDGET = 6530;

describe('shrinkPromptForModel — an over-cap page keeps its own facts', () => {
  it('the fixture is genuinely over both budgets (otherwise this test proves nothing)', () => {
    expect(PROMPT.length).toBeGreaterThan(PAGE_BUDGET);
  });

  for (const budget of [PAGE_BUDGET, TRIAL_EDIT_BUDGET]) {
    it(`keeps the scene prose, the cast and the worn item at a ${budget}-char budget`, async () => {
      const out: string = await shrinkPromptForModel(PROMPT, budget, `TEST ${budget}`, null);

      expect(out.length).toBeLessThanOrEqual(budget);

      // The page's own facts — the only statement of what THIS page is.
      expect(out).toContain('SENTINEL_SECOND_CHARACTER');
      expect(out).toContain('SENTINEL_WORN_GARMENT');
      expect(out).toContain('SENTINEL_SETTING');
      expect(out).toContain('reached the far side of the ravine');

      // The commissioned elements and the style are never spent either.
      expect(out).toContain('**REQUIRED OBJECTS');
      expect(out).toContain('**ART STYLE:**');
    });
  }

  it('pays with generic guidance instead — at the tighter budget at least one droppable rule is gone', async () => {
    const out: string = await shrinkPromptForModel(
      PROMPT, TRIAL_EDIT_BUDGET, 'TEST drop order', null
    );
    const droppable = ['**COUNTS:**', '**DEPTH AND SIZE:**', '**REQUIRED CAST:**', '**Composition:**'];
    const spent = droppable.filter((d) => !out.includes(d));
    expect(spent.length).toBeGreaterThan(0);
  });

  it('never cuts the head down to the opening rules alone (the production failure shape)', async () => {
    const out: string = await shrinkPromptForModel(
      PROMPT, TRIAL_EDIT_BUDGET, 'TEST head collapse', null
    );
    // In the failure, everything between the reference-photo rule and
    // `**REQUIRED OBJECTS` was deleted, leaving a ~1,022-char head.
    const headEnd = out.indexOf('**REQUIRED OBJECTS');
    expect(headEnd).toBeGreaterThan(1500);
  });
});

// A DROP REMOVES ITS OWN BLOCK AND NOTHING ELSE.
//
// The production failure was not "the wrong block was ranked first" — it was a
// drop that reached PAST the block it named. `AGE & PROPORTIONS` was removed by
// scanning forward to the next header in a hand-kept list, and on a page whose
// following headers were not in that list the scan ran to the end of the head:
// WORN ITEMS, the scene prose, the per-character lines, Setting/Camera/Depth
// and the character reference list all went with it, logged as one dropped
// block. Reproduced from job_1789975900382_dyc1g7wue's stored p5 brief: the
// historical cut against that page's budget returned exactly the two opening
// rule paragraphs plus the tail, byte-for-byte the shape stored in production.
//
// This pins the accounting rather than the block order: whatever is spent, the
// prompt that comes back is the prompt that went in MINUS the named blocks.
describe('shrinkPromptForModel — a drop is confined to the block it names', () => {
  it('everything the cut did not name survives byte-identically', async () => {
    // Just over the cap: the cut spends whole blocks and stops.
    const out: string = await shrinkPromptForModel(
      PROMPT, PROMPT.length - 400, 'TEST confinement', null
    );

    // The units are whole paragraphs and, for Composition, single bullets
    // (2026-09-23): a unit is spent when its exact text is gone.
    const composition = templateParagraph('**Composition:**').split('\n');
    const units = [
      templateParagraph('**COUNTS:**'),
      templateParagraph('**DEPTH AND SIZE:**'),
      templateParagraph('**REQUIRED CAST:**'),
      ...composition.slice(1),
    ];
    const spent = units.filter((u) => !out.includes(u));
    expect(spent.length).toBeGreaterThan(0);

    // Removing exactly what was named from the INPUT reproduces the output,
    // modulo the blank runs the removal collapses. Nothing else moved — in the
    // production failure this difference was thousands of characters of page.
    const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim();
    let rebuilt = PROMPT;
    for (const u of spent) rebuilt = rebuilt.split(u).join('');
    if (composition.slice(1).every((b) => spent.includes(b))) rebuilt = rebuilt.split(composition[0]).join('');
    expect(squeeze(out)).toBe(squeeze(rebuilt));

    // And the page itself is untouched by a drop this small.
    expect(out).toContain('SENTINEL_SECOND_CHARACTER');
    expect(out).toContain('SENTINEL_WORN_GARMENT');
    expect(out).toContain('SENTINEL_SETTING');
    expect(out).toContain('AGE & PROPORTIONS');
  });
});
