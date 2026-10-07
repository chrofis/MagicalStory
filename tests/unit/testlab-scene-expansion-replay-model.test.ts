/**
 * The scene_expansion family sent its prompt to the global TEXT_MODEL
 * (callTextModel with no override) and read `modelOverrides` off the top of
 * `stories.data`, while the run authors its briefs with
 * `modelOverrides.sceneDescriptionModel || MODEL_DEFAULTS.sceneDescription`
 * and the beats replays read the run's overrides from `replayInputs`
 * (docs/testlab-prod-parity.md). A Lab brief measured a model the run never
 * called. Since 2026-10-07 the three stages read `replayInputs` through the
 * same resolver and call the run's brief author.
 *
 * Only the DB and the model call are stubbed. No paid call is made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const database = require_('../../server/services/database');
const textModels = require_('../../server/lib/textModels');
const { MODEL_DEFAULTS } = require_('../../server/config/models');

const SCENE = {
  pageNumber: 1,
  text: 'Mira stand vor dem Tor.',
  sceneDescription: 'Mira stands before a garden gate.',
  sceneCharacters: [{ name: 'Mira' }],
  sceneMetadata: { sceneIntent: 'Mira reaches the gate.' },
};
const baseStory = () => ({
  title: 'Das Tor im Garten',
  language: 'de',
  artStyle: 'pixar',
  characters: [{ id: 'c1', name: 'Mira', age: 6, description: 'a girl with red curls' }],
  sceneImages: [SCENE],
  // What a story stored before replayInputs carried at the top: NOT the run's record.
  modelOverrides: { sceneDescriptionModel: 'claude-opus' },
});

let story: any = baseStory();
let calls: Array<{ prompt: string; model: string | null; label: string }> = [];
database.dbQuery = async (sql: string) => {
  if (/jsonb_array_elements\(data->'sceneImages'\)/.test(sql)) {
    return [{ scene_text: JSON.stringify(SCENE), art_style: story.artStyle, language: story.language, layout: {}, characters_json: JSON.stringify(story.characters) }];
  }
  if (/SELECT data, user_id FROM stories/.test(sql)) return [{ data: story, user_id: 1 }];
  return [];
};
textModels.callTextModel = async (prompt: string, _max: number | null, model: string | null, opts: any) => {
  calls.push({ prompt, model, label: opts?.usageLabel });
  return { text: 'SCENE: stub brief', modelId: model || 'stub', usage: { input_tokens: 10, output_tokens: 5 } };
};

const { runStageOnTarget } = require_('../../server/lib/testlab');
const run = () => runStageOnTarget('scene_expansion', { storyId: 'job_test', pageNumber: 1 }, { params: {} });

beforeEach(() => { calls = []; story = baseStory(); });

describe('scene_expansion calls the run\'s brief author', () => {
  it('the stored replayInputs.modelOverrides.sceneDescriptionModel is the model called', async () => {
    story.replayInputs = { modelOverrides: { sceneDescriptionModel: 'claude-haiku' } };
    const r = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe('testlab_scene_expansion');
    expect(calls[0].model).toBe('claude-haiku');
    expect(r.modelId).toBe('claude-haiku');
    expect(calls[0].prompt).toContain('Mira');
  });

  it('a story stored before replayInputs replays on the run\'s default brief model, not the top-level record or the global model', async () => {
    await run();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(MODEL_DEFAULTS.sceneDescription);
  });
});
