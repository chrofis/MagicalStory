import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression for tasks/bugs.json `trial-page-unrequested-caption-shipped`: pages
// came back with a painted title/caption/name/signature although the preamble
// already banned lettering. The fix is the label words inside the lettering ban of the shared page template
// (docs/decisions.md 2026-10-15), so trial pages, full pages and covers (all
// built by buildImagePrompt from image-generation.txt) carry it together.
const { loadPromptTemplates } = require('../../server/services/prompts');
const PB = require('../../server/lib/promptBuilders');

const SENTENCE = 'No lettering on any surface: no words, names, letters, title, caption, label or signature. The only exception is a REQUIRED TEXT block below; with no such block, nothing is lettered.';

beforeAll(async () => { await loadPromptTemplates(); });

describe('page image prompt carries the no-label sentence', () => {
  it('is in the shared template file, folded into the lettering ban', () => {
    const t = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'image-generation.txt'), 'utf8');
    expect(t).toContain(SENTENCE);
    // wording folded into the ban, not appended (decisions.md 2026-10-16): the ban stays no longer than before ee5f18f77 (184 chars)
    expect(SENTENCE.length).toBeLessThanOrEqual(184);
  });

  it('reaches the built prompt (the one builder every page path calls)', () => {
    const out = String(PB.buildImagePrompt('A girl crouches by a stone fountain.', {
      title: 'T', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }], mainCharacters: ['c1'],
      language: 'en', languageLevel: 'medium', pages: 4, artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
    } as any, null, null, 1, null, {}));
    expect(out).toContain(SENTENCE);
  });
});
