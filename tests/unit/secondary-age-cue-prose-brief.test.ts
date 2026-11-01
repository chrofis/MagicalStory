import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
// @ts-expect-error - JS module without types
import { buildImagePrompt } from '../../server/lib/promptBuilders.js';

beforeAll(async () => { await createRequire(import.meta.url)('../../server/services/prompts').loadPromptTemplates(); });

// Prod job_1793561351885_kkg5gxkbj: the stage prose brief names no age for an
// invented 2-year-old, and the old `isProseFormat ? [] : ...` gate emptied the
// invented cast, so AGE & PROPORTIONS listed only the commissioned people. The
// child was drawn as an adult. On a prose page the invented character is filed
// under objects[] by its bible id (characters[] holds only the commissioned
// cast), so membership must also be read from there.

const CHILD = {
  id: 'CHR001', name: 'Nerina', age: 2,
  description: '2. a girl, slim. hair: long wavy auburn hair. Clothing: a violet scaled mermaid tail',
  pages: [8], appearsInPages: [8],
};
const vb = { mainCharacters: [], secondaryCharacters: [CHILD], animals: [], vehicles: [], clothing: [], locations: [], artifacts: [] };
const HERO = { id: 1, name: 'Ludovica', age: '2', gender: 'female' };

const prose = (objects: string[]) =>
  'A small figure swims in the far distance of the cove while Ludovica watches from the rock.\n\n---METADATA---\n' +
  JSON.stringify({ sceneIntent: 'x', characters: [{ name: 'Ludovica', position: 'on the rock', depth: 'foreground' }], objects });

const build = (desc: string, pageNumber = 8) =>
  buildImagePrompt(desc, { language: 'de-ch', artStyle: 'watercolor', layout: { textInImage: true }, characters: [HERO] }, [HERO], vb, pageNumber, null, { skipVisualBible: true }) as string;

const ageBlock = (p: string) => (p.includes('AGE & PROPORTIONS') ? p.slice(p.indexOf('AGE & PROPORTIONS')).split('\n\n')[0] : '');

describe('an invented child on a prose-format brief gets its age cue', () => {
  it('names the invented child in AGE & PROPORTIONS when filed under objects[] by id', () => {
    expect(ageBlock(build(prose(['CHR001'])))).toMatch(/Nerina[^\n]*toddler|toddler[^\n]*Nerina/);
  });

  it('does not duplicate the description the prose already weaves in', () => {
    expect(build(prose(['CHR001']))).not.toContain('CAST WITHOUT A REFERENCE IMAGE');
  });

  it('leaves a page that cites no invented character unchanged (no cue, no id leak)', () => {
    const p = build(prose([]));
    expect(ageBlock(p)).not.toContain('Nerina');
    expect(p).not.toMatch(/CHR001/);
  });
});
