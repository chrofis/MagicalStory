import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// Regression for tasks/bugs.json `trial-page-unrequested-caption-shipped`: pages
// came back with a painted title/caption/name/signature although the preamble
// already banned lettering. The fix is ONE sentence in the shared page template
// (docs/decisions.md 2026-10-15), so trial pages, full pages and covers (all
// built by buildImagePrompt from image-generation.txt) carry it together.
const { loadPromptTemplates } = require('../../server/services/prompts');
const PB = require('../../server/lib/promptBuilders');

const SENTENCE = "That includes a title or caption for the picture, a character's name, a phrase describing the moment, and an artist's signature: the picture carries no label of its own.";

beforeAll(async () => { await loadPromptTemplates(); });

describe('page image prompt carries the no-label sentence', () => {
  it('is in the shared template file, right after the lettering exception', () => {
    const t = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'image-generation.txt'), 'utf8');
    expect(t).toContain('nothing in the image is lettered. ' + SENTENCE);
  });

  it('reaches the built prompt (the one builder every page path calls)', () => {
    const out = String(PB.buildImagePrompt('A girl crouches by a stone fountain.', {
      title: 'T', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }], mainCharacters: ['c1'],
      language: 'en', languageLevel: 'medium', pages: 4, artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
    } as any, null, null, 1, null, {}));
    expect(out).toContain(SENTENCE);
  });
});
