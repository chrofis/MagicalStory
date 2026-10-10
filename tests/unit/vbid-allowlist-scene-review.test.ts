import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isVbIdLegitimateLabel } = require('../../server/lib/vbIdGuard.js');

// The scene reviewer's contract IS the VB id vocabulary — its prompt carries
// `"looksAt": "VEH001"` citations it must read back. Production labels the call
// `beats_scene_review` (allow-listed all along); the Lab labels it
// `testlab_scene_review`, which strips to a bare `scene_review` that the list
// did not carry — so the identical prompt warned in the Lab and was silent in
// prod.
describe('vbIdGuard allow-list: the scene reviewer reads VB ids back', () => {
  it('accepts the scene-reviewer labels in prod and in the Lab', () => {
    expect(isVbIdLegitimateLabel('beats_scene_review')).toBe(true);
    expect(isVbIdLegitimateLabel('beats_scene_review_worn')).toBe(true);
    expect(isVbIdLegitimateLabel('scene_review')).toBe(true);
    expect(isVbIdLegitimateLabel('testlab_scene_review')).toBe(true);
    expect(isVbIdLegitimateLabel('testlab_scene_review_replay')).toBe(true);
  });

  it('still rejects an unknown label — a new prompt path must warn', () => {
    expect(isVbIdLegitimateLabel('image_generation')).toBe(false);
    expect(isVbIdLegitimateLabel('testlab_image_generation')).toBe(false);
    expect(isVbIdLegitimateLabel('scene_description')).toBe(false);
    expect(isVbIdLegitimateLabel('')).toBe(false);
  });
});

// Staging 2026-10-08: every trial warned `[VB-ID-LEAK] text call "unified_story"
// carries LOC001, CHR001, ART001, ANI001` (and full stories on beats_visual_bible
// / beats_brief_reask). Those ids are the writer's own OUTPUT SCHEMA keys
// (`"id": "CHR001"`), so the call is a stage whose contract is the id vocabulary.
describe('vbIdGuard allow-list: writers whose output spec carries the id keys', () => {
  it('accepts the trial writer, the Visual Bible writer and the brief re-ask', () => {
    for (const l of ['unified_story', 'beats_visual_bible', 'beats_brief_reask', 'testlab_beats_visual_bible']) {
      expect(isVbIdLegitimateLabel(l)).toBe(true);
    }
  });

  it('the trial writer template really carries schema ids (why it is allow-listed)', async () => {
    const fs = await import('node:fs');
    const t = fs.readFileSync('prompts/story-trial-arc.txt', 'utf8');
    expect(/CHR001/.test(t) && /LOC001/.test(t)).toBe(true);
  });

  it('a prose-rewrite stage that is handed ids still warns', () => {
    expect(isVbIdLegitimateLabel('text_refine')).toBe(false);
    expect(isVbIdLegitimateLabel('scene_translation')).toBe(false);
  });
});
