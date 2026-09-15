import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the three cover-critic notes moved from string literals in
// evalPipeline.js into prompts/cover-evaluation-notes.txt on 2026-09-15, so the
// cover generator/critic pair could become a sibling-registry set over two file
// paths. The strings below are the PRE-EXTRACTION literals, copied byte for
// byte; the move is safe exactly as long as these assertions hold.

const PRE_COVER_NOTE = 'COVER NOTE: a book-cover portrait. Do not deduct for characters facing or looking at the viewer, or for the title being flat 2D rather than three-dimensional.';

const PRE_TEXT_NOTE = 'TEXT NOTE: The title, dedication, and "magicalstory.ch" branding on this cover are handled by the app as a typographic overlay, not painted by the image model. Never flag missing/absent title/dedication/branding text as a defect, and if such text IS present treat it as the intended app-composited overlay — never flag it as unrequested rendered text.';

const preTextRules = (expectedText: string) =>
  `⚠️ TEXT RULES FOR THIS IMAGE:\nAllowed text: "${expectedText}" — and nothing else prominent.\nSeverities for text issues:\n- Allowed text missing or misspelled (any character difference) → severity: CATASTROPHIC.\n- Other prominent unrequested text on the cover (labels, captions, watermarks, extra words) → severity: MAJOR.\n- Small incidental in-world signage in the background → do not flag; if garbled → severity: MINOR.\nIf the only text on the image is exactly the allowed text, evaluate normally.\n\nBefore reporting a title misspelling, RE-READ the rendered text letter-by-letter against the allowed text above. Report a mismatch ONLY if you can quote the exact rendered string and it differs from the allowed text. If you are uncertain whether the rendering matches, do NOT flag it.`;

let sections: Record<string, string>;
let fillTemplate: any;

beforeAll(async () => {
  const prompts = require_('../../server/services/prompts.js');
  await prompts.loadPromptTemplates();
  fillTemplate = prompts.fillTemplate;
  sections = prompts.promptSections(prompts.PROMPT_TEMPLATES.coverEvaluationNotes);
});

describe('cover critic notes — extraction is a move, not an edit', () => {
  it('the template file loaded and split into the three declared sections', () => {
    expect(Object.keys(sections).sort()).toEqual(['COVER_NOTE', 'TEXT_NOTE_APP_OVERLAY', 'TEXT_RULES']);
  });

  it('COVER_NOTE is byte-identical to the pre-extraction literal', () => {
    expect(sections.COVER_NOTE).toBe(PRE_COVER_NOTE);
  });

  it('TEXT_NOTE_APP_OVERLAY is byte-identical to the pre-extraction literal', () => {
    expect(sections.TEXT_NOTE_APP_OVERLAY).toBe(PRE_TEXT_NOTE);
  });

  it('TEXT_RULES renders byte-identical for real expected-text inputs', () => {
    for (const title of ['Die Reise zum Leuchtturm', 'magicalstory.ch', 'For our daughter — with love']) {
      expect(fillTemplate(sections.TEXT_RULES, { EXPECTED_TEXT: title })).toBe(preTextRules(title));
    }
  });

  it('every placeholder in the template is declared by the caller', () => {
    const declared = new Set(['{EXPECTED_TEXT}']);
    const tokens = (sections.TEXT_RULES + sections.COVER_NOTE + sections.TEXT_NOTE_APP_OVERLAY)
      .match(/\{[A-Z][A-Z0-9_]*\}/g) || [];
    for (const t of tokens) expect(declared.has(t), `undeclared placeholder ${t}`).toBe(true);
    // ...and nothing unfilled survives the real fill.
    const built = fillTemplate(sections.TEXT_RULES, { EXPECTED_TEXT: 'A Title' });
    expect(built.match(/\{[A-Z][A-Z0-9_]*\}/g)).toBe(null);
  });
});
