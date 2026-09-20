import { describe, it, expect } from 'vitest';

const { evalSceneDescription, evalSceneHint } = require('../../server/lib/testlab');

// The judge reads the commission TWICE: once as the eval contract, once as
// SCENE_HINT, which its own prompt calls authoritative. A Lab A/B that replaces
// the brief must move BOTH, or the new image is scored against the brief the
// override was written to replace.
//
// Measured 2026-09-20 on staging job_1789853503332_riqncqg1i: six page-10 arms
// rendered from overrides came back with issues of the form "the authoritative
// SCENE_HINT states Julian should be clutching the egg tightly against his
// chest" — the exact staging those overrides removed. Two arms that rendered
// the commissioned event scored -130 and 0 for it.
//
// These pin the AGREEMENT of the two slots, never the wording of either.

const STORED_BRIEF = 'A toddler stands holding a large egg pressed to his chest.';
const STORED_HINT = 'A toddler clutches the egg tightly against his chest.';
const OVERRIDE = 'The egg hangs in the air, unsupported, with nothing touching it.';

const ctx = () => ({
  scene: { sceneDescription: STORED_BRIEF },
  outlineHint: STORED_HINT,
});

describe('a Lab brief override reaches both copies of the commission', () => {
  it('sends the override as the eval contract', () => {
    expect(evalSceneDescription(ctx(), { sceneDescriptionOverride: OVERRIDE })).toBe(OVERRIDE);
  });

  it('sends the override as SCENE_HINT too — the slot the judge calls authoritative', () => {
    expect(evalSceneHint(ctx(), { sceneDescriptionOverride: OVERRIDE })).toBe(OVERRIDE);
  });

  it('never leaves the judge holding one brief in one slot and another in the other', () => {
    const params = { sceneDescriptionOverride: OVERRIDE };
    expect(evalSceneHint(ctx(), params)).toBe(evalSceneDescription(ctx(), params));
  });

  it('leaves both slots on the stored values when no override is given', () => {
    expect(evalSceneDescription(ctx(), {})).toBe(STORED_BRIEF);
    expect(evalSceneHint(ctx(), {})).toBe(STORED_HINT);
    expect(evalSceneDescription(ctx(), null)).toBe(STORED_BRIEF);
    expect(evalSceneHint(ctx(), null)).toBe(STORED_HINT);
    expect(evalSceneHint(ctx())).toBe(STORED_HINT);
  });

  it('treats a blank or whitespace override as no override, in both slots', () => {
    for (const blank of ['', '   ']) {
      const params = { sceneDescriptionOverride: blank };
      expect(evalSceneDescription(ctx(), params)).toBe(STORED_BRIEF);
      expect(evalSceneHint(ctx(), params)).toBe(STORED_HINT);
    }
  });

  it('returns null rather than a stale hint when a page has none and no override', () => {
    expect(evalSceneHint({ scene: {}, outlineHint: null }, {})).toBeNull();
  });
});
