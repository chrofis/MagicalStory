import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// THE BACK COVER PROMPT CARRIES NO "THIS IMAGE DEPICTS:" HEADER (owner, 2026-11-06).
//
// Prod back covers drew the header's sentence as a caption under the picture:
// job_1793893086454_ao77wh9j5 v0 "POLINA, MELODI, JANNA, AND MELISA AT ST. JOSEF",
// job_1793959308869_fre2mb4d0 v1 "HONERET WOOD MEADOW / JANNA, POLINA, MELISA,
// MELODI". The bold header reads like a title, so on the back cover the scene
// sentence stays and the header goes. Story pages keep it.

const require_ = createRequire(import.meta.url);
const { COVER_PAGE_NUMBERS } = require_('../../server/lib/coverKeys');
// @ts-expect-error - JS module without types
import { buildImagePrompt } from '../../server/lib/promptBuilders.js';

beforeAll(async () => { await require_('../../server/services/prompts').loadPromptTemplates(); });

const INTENT = 'The four friends stand together facing the viewer on a meadow.';
const scene = () =>
  `A group portrait of the main character.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: INTENT,
    characters: [{ name: 'Ada', position: 'center', depth: 'foreground' }],
    shot: 'wide',
  })}`;
const bible = () => ({
  mainCharacters: [{ id: 'CHR001', name: 'Ada' }],
  secondaryCharacters: [], animals: [], vehicles: [], clothing: [], locations: [], artifacts: [],
});
const build = (pageNumber: number) =>
  buildImagePrompt(scene(), { language: 'en' }, null, bible(), pageNumber, null, {});

describe('THIS IMAGE DEPICTS header', () => {
  it('the back cover keeps the scene sentence without the header', () => {
    const p = build(COVER_PAGE_NUMBERS.backCover);
    expect(p).toContain(INTENT);
    expect(p).not.toMatch(/THIS IMAGE DEPICTS/i);
  });
  it('a story page and the front cover keep the header', () => {
    expect(build(3)).toContain(`**THIS IMAGE DEPICTS:** ${INTENT}`);
    expect(build(COVER_PAGE_NUMBERS.frontCover)).toContain(`**THIS IMAGE DEPICTS:** ${INTENT}`);
  });
});
