/**
 * Bug trial-back-cover-empty-hint (2026-09-24).
 *
 * The trial writer emits no cover-hints section, and extractCoverHints returned
 * a truthy EMPTY hint per cover, so the trial start block's default-hint branch
 * never ran and every trial back cover rendered from nothing ("A portrait of a
 * single character set before <place>"). An absent section now yields null, and
 * the trial's missing covers get a STRUCTURED default hint the scene builder reads.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { UnifiedStoryParser } = require_('../../server/lib/outlineParser/unified');
const { trialDefaultCoverHint, buildCoverSceneFromHint } = require_('../../server/lib/coverIterate');

const trialInput = {
  trialMode: true,
  characters: [{ id: 1, name: 'Child1', isMainCharacter: true }, { id: 2, name: 'Child2' }],
};
const vb = { locations: [{ id: 'LOC001', name: 'the park', description: 'a green park' }] };

describe('an absent cover hint is no hint', () => {
  it('no cover-hints section → null', () => {
    expect(new UnifiedStoryParser('---COVER SCENE---\n{"scene":{}}\n---STORY PAGES---\n').extractCoverHints()).toBeNull();
  });
  it('a section with one cover → only that cover', () => {
    const raw = ['---COVER SCENE HINTS---', '**Back Cover**', 'Mood: calm', 'Objects: LOC001',
      'Characters:', '- Child1 (center): standard, holds: nothing, priority: essential'].join('\n');
    const hints = new UnifiedStoryParser(raw).extractCoverHints();
    expect(Object.keys(hints)).toEqual(['backCover']);
    expect(hints.frontCover).toBeUndefined();
  });
});

describe('the trial default cover hint', () => {
  it('is structured: mood, the main cast, and the builder reads it', () => {
    const back = trialDefaultCoverHint('backCover', trialInput);
    expect(back.characters).toEqual(['Child1']);
    expect(back.mood).toMatch(/calm/);
    back.objects = ['LOC001']; // the pipeline's backdrop check gives it the story's location
    const scene = buildCoverSceneFromHint(back, vb, trialInput.characters, { language: 'en' });
    expect(scene).toMatch(/^Calm/);
    expect(scene).toContain('the park');
    expect(scene).toContain('Child1');
  });
  it('a costume trial dresses the cast in its costume', () => {
    const back = trialDefaultCoverHint('backCover', { ...trialInput, _trialCostumeType: 'pirate' });
    expect(back.characterClothing).toEqual({ Child1: 'costumed', Child2: 'costumed' });
  });
  it('the trial renders front and back only', () => {
    expect(() => trialDefaultCoverHint('initialPage', trialInput)).toThrow(/front and a back cover/);
  });
  it('the pipeline sets the defaults right after the parse, and the start block has no inline fallback left (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/coverHints\[coverType\] = trialDefaultCoverHint\(coverType, inputData\)/);
    expect(src).not.toContain('A calm closing back-cover scene featuring ${mainCharNames}');
  });
});
