/**
 * scene_expansion_ab renders both briefs inside the stage, so an image refusal
 * (IMAGE_OTHER — 1 of 5 pages in exp 815, 2026-08-23) used to throw before
 * `newSceneDescriptionA/B` were stored: the page lost the brief comparison the
 * experiment was asked for, not only the image.
 *
 * The run loop (server/routes/admin/testlab.js executeExperiment) already
 * merges `err.partialResult` into a failed entry; the stage now attaches the
 * text arms there. Only the DB, the text model and the image call are stubbed.
 * No paid call is made.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const database = require_('../../server/services/database');
const textModels = require_('../../server/lib/textModels');
const images = require_('../../server/lib/images');

const SCENE = {
  pageNumber: 3,
  text: 'Mira hält den Drachen an der Pfote.',
  sceneDescription: 'Mira holds the dragon by its paw in the garden.',
  sceneCharacters: ['Mira'],
  sceneMetadata: { textPosition: 'top' },
};
const STORY = {
  title: 'Der Gartendrache',
  language: 'de',
  artStyle: 'pixar',
  layout: { textInImage: true },
  characters: [{ id: 'c1', name: 'Mira', age: 6 }],
  sceneImages: [SCENE],
};

database.dbQuery = async (sql: string) => {
  if (/FROM stories WHERE id/.test(sql)) return [{ data: STORY, user_id: 1 }];
  if (/jsonb_array_elements\(data->'sceneImages'\)/.test(sql)) {
    return [{
      scene_text: JSON.stringify(SCENE),
      art_style: STORY.artStyle, language: 'de', language_level: 'standard',
      title: STORY.title, layout: STORY.layout,
      visual_bible: null, clothing_reqs: null, page_clothing: null, cover_hints: null,
      characters_json: JSON.stringify(STORY.characters), character_avatars: null,
    }];
  }
  return [];
};

const BRIEF_A = '{"imageSummary":"A: Mira holds the paw"}\nMira holds the dragon by its paw.';
const BRIEF_B = '{"imageSummary":"B: clear contact"}\nMira grips the paw; clear contact, no reaching.';
let textCalls = 0;
textModels.callTextModel = async () => ({ text: textCalls++ === 0 ? BRIEF_A : BRIEF_B, modelId: 'stub-ad' });

// The refusal, as the provider branch raises it.
images.generateImageOnly = async () => {
  throw new Error('IMAGE_OTHER: the model returned no image');
};

const { runStageOnTarget } = require_('../../server/lib/testlab');

describe('scene_expansion_ab under an image refusal', () => {
  it('keeps both text arms on err.partialResult so the failed entry still shows the brief comparison', async () => {
    let caught: any = null;
    try {
      await runStageOnTarget('scene_expansion_ab', { storyId: 'story_ab', pageNumber: 3 }, { experimentId: 815, params: { autoEval: false } });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/IMAGE_OTHER/);
    expect(caught.partialResult).toMatchObject({
      newSceneDescriptionA: BRIEF_A,
      newSceneDescriptionB: BRIEF_B,
      promptOverridden: false,
    });
    expect(typeof caught.partialResult.extraRule).toBe('string');
    expect(caught.partialResult.promptUsedA).toContain(SCENE.text);
    expect(caught.partialResult.promptUsedB).toContain(caught.partialResult.extraRule);
    // Nothing rendered, so no image slot is claimed on the failed entry.
    expect(caught.partialResult.versionIndex).toBeUndefined();
  });

  it('scene_variant (the one-arm sibling) keeps its text arm the same way', async () => {
    textCalls = 0;
    let caught: any = null;
    try {
      await runStageOnTarget('scene_variant', { storyId: 'story_ab', pageNumber: 3 }, { experimentId: 815, params: { autoEval: false, extraRule: 'Hands touch or stay apart.' } });
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toMatch(/IMAGE_OTHER/);
    expect(caught.partialResult).toMatchObject({
      newSceneDescription: BRIEF_A,
      storedSceneDescription: SCENE.sceneDescription,
      extraRule: 'Hands touch or stay apart.',
      promptOverridden: false,
    });
    expect(caught.partialResult.promptUsed).toContain('Hands touch or stay apart.');
    expect(caught.partialResult.versionIndex).toBeUndefined();
  });
});
