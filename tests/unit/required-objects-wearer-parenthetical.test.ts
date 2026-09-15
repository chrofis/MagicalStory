import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildImagePrompt } = require_('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

/**
 * The REQUIRED OBJECTS lead carries a trailing parenthetical from the bible
 * name so a two-sided prop keeps its ORIENTATION ("… (turned away)"). The
 * clothing naming convention puts the WEARER in that same parenthetical, and
 * the regex took it too — a character's name reached the image-facing label of
 * a garment, the leak 32c825a61 closed and this rule reopened.
 */
const sceneDescription =
  'A child stands in the centre of a sunny garden, holding a red superhero cape overhead in both hands as it catches the wind.\n'
  + '---METADATA---\n'
  + JSON.stringify({
    characters: [{ name: 'Hero', position: 'center foreground', clothing: 'costumed', depth: 'foreground', expression: 'delighted, broad smile' }],
    objects: ['CLO001', 'ART001'],
    interactions: [{ character: 'Hero', object: 'the red superhero cape', where: 'held overhead in both hands', storyRelevant: true, priority: 'essential' }],
    emptyScenePrompt: 'A sunny garden.',
  });

const visualBible = {
  clothing: [{
    id: 'CLO001',
    name: 'red superhero cape (Hero)',
    description: 'A red superhero cape with golden trim, tied at the neck',
    wornBy: 'Hero',
  }],
  artifacts: [{
    id: 'ART001',
    name: 'hand mirror (turned away)',
    description: 'A small round hand mirror with a brass handle',
  }],
  locations: [],
};

const inputData = { language: 'en', artStyle: 'watercolor', characters: [{ id: 1, name: 'Hero', age: 7 }] };
const sceneCharacters = [{ name: 'Hero', position: 'center foreground', clothing: 'costumed', depth: 'foreground' }];
const referencePhotos = [{ name: 'Hero', photoUrl: 'data:image/jpeg;base64,AAAA', clothingCategory: 'costumed' }];

describe('REQUIRED OBJECTS lead qualifiers', () => {
  it('a wearer parenthetical never reaches the image-facing label; an orientation one does', async () => {
    await loadPromptTemplates();
    const prompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, visualBible, 7, referencePhotos, {});
    // The character's name may appear as a cast reference, never as part of a
    // garment's own label.
    expect(prompt).not.toMatch(/cape[^*\n]*\(Hero\)/);
    expect(prompt).toMatch(/\(turned away\)/);
  });
});
