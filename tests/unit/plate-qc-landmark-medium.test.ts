/**
 * The plate QC sees people and a photograph (owner, 2026-09-26).
 *
 * - The landmark check is told the sentence the plate author was told
 *   (shotVocabulary.PLATE_LANDMARK_REFERENCE): the plate shows the part of the
 *   place its camera sees, and is judged on that part.
 * - A photographic book's plate is held to a photograph; every other book's
 *   plate fails one (STYLE_CHECK vs STYLE_CHECK_PHOTOGRAPHIC, picked by
 *   isPhotographicArtStyle). The QC used to fail a photograph on every book.
 * - The list of what a plate may not hold is one constant on both sides.
 *
 * No network, no DB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const SV = require_('../../server/lib/shotVocabulary');
const prompts = require_('../../server/services/prompts');

let build: any;
let sections: any;
beforeAll(async () => {
  await prompts.loadPromptTemplates();
  build = require_('../../server/lib/evalPipeline').buildEmptySceneQcPrompt;
  sections = prompts.promptSections(prompts.PROMPT_TEMPLATES.emptySceneQc);
});

describe('the landmark check is told what the plate author was told', () => {
  it('the plate REFERENCE line and the judge carry the one sentence', () => {
    const plate = prompts.buildEmptyScenePrompt({ style: 'A watercolour.', description: 'A square.', referenceKind: 'landmark' });
    expect(plate).toContain(`**REFERENCE:** ${SV.PLATE_LANDMARK_REFERENCE}`);
    const qc = build({ sceneDescription: 'A square.', landmarkName: 'Old Town Tower' });
    expect(qc).toContain(SV.PLATE_LANDMARK_REFERENCE);
    expect(qc.match(/\{[A-Z][A-Z0-9_]*\}/g)).toBe(null);
  });
  it('no landmark photo, no landmark check', () => {
    expect(build({ sceneDescription: 'A square.' })).not.toContain(SV.PLATE_LANDMARK_REFERENCE);
  });
});

describe('what a plate may not hold is one list for author and judge', () => {
  it('PLATE_PEOPLE names a trace of a person and reaches both sides', () => {
    expect(SV.PLATE_PEOPLE).toMatch(/trace/);
    const plate = prompts.buildEmptyScenePrompt({ style: 'A watercolour.', description: 'A square.' });
    expect(plate).toContain(SV.PLATE_NO_PEOPLE_RULE);
    expect(build({ sceneDescription: 'A square.' })).toContain(SV.PLATE_PEOPLE);
  });
});

describe('the medium check follows the book\'s medium', () => {
  const { resolveArtStyle } = require_('../../server/lib/storyHelpers');
  const fill = (section: string, style: string) => prompts.fillTemplate(section, { ART_STYLE: style });
  it('an illustrated book\'s plate gets the illustrated medium check', () => {
    const style = resolveArtStyle('watercolor');
    expect(prompts.isPhotographicArtStyle(style)).toBe(false);
    const p = build({ sceneDescription: 'A square.', artStyle: style });
    expect(p).toContain(fill(sections.STYLE_CHECK, style));
    expect(p).not.toContain(fill(sections.STYLE_CHECK_PHOTOGRAPHIC, style));
  });
  it('a photographic book\'s plate gets the photographic medium check', () => {
    const style = resolveArtStyle('realistic');
    expect(prompts.isPhotographicArtStyle(style)).toBe(true);
    const p = build({ sceneDescription: 'A square.', artStyle: style });
    expect(p).toContain(fill(sections.STYLE_CHECK_PHOTOGRAPHIC, style));
    expect(p).not.toContain(fill(sections.STYLE_CHECK, style));
  });
});
