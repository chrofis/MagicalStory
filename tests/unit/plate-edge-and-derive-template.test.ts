import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED (2026-09-25, staging job_1790277448294_5herh01j7):
// 1. A plate derive (camera move / re-light) is built from its own template,
//    never illustration-edit's "keep identical / do not resize" frame.
// 2. The plate author, the derive edit and the plate QC read the edge-to-edge,
//    no-mark, no-mat rule from one source (shotVocabulary.js).
// Pinned on the BUILT prompts via the real builders, never on template text.

beforeAll(async () => {
  await require_('../../server/services/prompts.js').loadPromptTemplates();
});

const prompts = () => require_('../../server/services/prompts.js');
const shots = () => require_('../../server/lib/shotVocabulary.js');

describe('the plate derive edit has its own template', () => {
  it('fills the instruction, the style and the edge rule, and leaves no placeholder', () => {
    const instruction = shots().buildPlateDeriveInstruction('medium', 'ultra-wide');
    const built = prompts().buildPlateDerivePrompt(instruction, 'soft watercolour');
    expect(built).toContain(instruction);
    expect(built).toContain('soft watercolour');
    expect(built).toContain(shots().PLATE_EDGE_RULE);
    expect(built).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('is not the illustration-edit prompt', () => {
    const { PROMPT_TEMPLATES, fillTemplate } = prompts();
    const built = prompts().buildPlateDerivePrompt('X', 'S');
    const edit = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, { EDIT_INSTRUCTION: 'X', ART_STYLE: 'S' });
    expect(built).not.toBe(edit);
    // The two illustration-edit lines that framed the pull-back as a picture-in-a-picture.
    for (const line of edit.split('\n').filter((l: string) => /identical|resize/i.test(l))) {
      expect(built).not.toContain(line.trim());
    }
  });

  it('editImageWithPrompt routes plateDerive to that builder', () => {
    const src = require_('fs').readFileSync(require_('path').join(__dirname, '..', '..', 'server/lib/images.js'), 'utf8');
    expect(src).toMatch(/plateDerive\s*\n?\s*\? require\('\.\.\/services\/prompts'\)\.buildPlateDerivePrompt\(editInstruction, styleText\)/);
  });
});

describe('the plate edge rule reaches both sides', () => {
  it('the plate author gets it', () => {
    const built = prompts().buildEmptyScenePrompt({ style: 'watercolour', description: 'An empty meadow.' });
    expect(built).toContain(shots().PLATE_EDGE_RULE);
  });

  it('the plate QC checks both lists it names', () => {
    const { buildEmptySceneQcPrompt } = require_('../../server/lib/evalPipeline.js');
    const built = buildEmptySceneQcPrompt({ sceneDescription: 'An empty meadow.' });
    expect(built).toContain(shots().PLATE_MARKS);
    expect(built).toContain(shots().PLATE_SURROUNDS);
    expect(shots().PLATE_EDGE_RULE).toContain(shots().PLATE_MARKS);
    expect(shots().PLATE_EDGE_RULE).toContain(shots().PLATE_SURROUNDS);
    expect(built).not.toMatch(/\{PLATE_[A-Z_]+\}/);
  });
});
