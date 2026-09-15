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
