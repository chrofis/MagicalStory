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
    expect(Object.keys(sections).sort()).toEqual(['COVER_NOTE', 'COVER_TEXT', 'TEXT_NOTE_APP_OVERLAY']);
  });

  it('COVER_NOTE is byte-identical to the pre-extraction literal', () => {
    expect(sections.COVER_NOTE).toBe(PRE_COVER_NOTE);
  });

  it('TEXT_NOTE_APP_OVERLAY is byte-identical to the pre-extraction literal', () => {
    expect(sections.TEXT_NOTE_APP_OVERLAY).toBe(PRE_TEXT_NOTE);
  });

  // TEXT_RULES (the allow-list with {EXPECTED_TEXT}) was replaced by COVER_TEXT on
  // 2026-09-23: the title now rides every judge's structured {TEXT_RULES} slot
  // (requiredText.coverRequiredTexts) and this note only says what that string is.

  it('the notes carry no placeholders — the title reaches the judges through TEXT RULES', () => {
    const tokens = (sections.COVER_TEXT + sections.COVER_NOTE + sections.TEXT_NOTE_APP_OVERLAY)
      .match(/{[A-Z][A-Z0-9_]*}/g) || [];
    expect(tokens).toEqual([]);
  });
});
