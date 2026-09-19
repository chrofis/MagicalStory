import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5 }];
const built = () => pb.buildSceneExpansionAllPrompt(
  { pages: 4, season: 'autumn', language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'x', characters: chars, mainCharacters: ['a'] },
  [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing' }],
  { maxCharactersPerScene: 6, finalArc: '1.' });

/**
 * Two rules in one prompt disagreed about gaze, twice.
 *
 * 1. THE VIEWER. 6c: "Never write a gaze to the viewer." Rule 6: "Eyes look at
 *    what they interact with, not at the camera." 8j nevertheless offered
 *    `camera` as a legal `looksAt` value, and the field-rules line in both
 *    templates repeated it. Nothing in the codebase reads looksAt === 'camera',
 *    and of the 16 stored stories that use looksAt at all, 0 use it — the model
 *    guessed right, with no rule telling it which side won.
 *
 * 2. ONE TARGET. 6c: "Name at most one gaze target... Every other figure looks
 *    at that same target." 8j: "When the plan line stages two named characters
 *    facing each other... each one's looksAt is the other" — which is two
 *    targets, so 8j's own prescription broke 6c on every standoff page.
 */
describe('the gaze rules agree about the viewer', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('no rule offers the viewer as a gaze target', () => {
    expect(pb.LOOKS_AT_FIELD_RULE).not.toMatch(/`camera`/);
    expect(pb.LOOKS_AT_FIELD_RULE).toContain('a figure never meets the reader');
  });

  it('and the ban is still stated where it always was', () => {
    expect(pb.GAZE_TARGET_RULE).toContain('Never write a gaze to the viewer');
    expect(built()).toContain('Eyes look at what they interact with, not at the camera');
  });

  it('the value list is gone from the templates too — it was a third copy', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion']) {
      const t = String(PROMPT_TEMPLATES[k] || '');
      expect(t, `${k} still offers \`camera\``).not.toMatch(/`camera`/);
      expect(t, `${k} lost the looksAt field line`).toMatch(/`looksAt` on every foreground\/midground character/);
    }
  });

  it('no BUILT Art Director prompt offers it anywhere', () => {
    expect(built()).not.toMatch(/`camera`/);
  });
});

describe('the gaze rules agree about how many targets a page has', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('6c carves out the mutual gaze 8j prescribes, and names it as one relationship', () => {
    const r = pb.GAZE_TARGET_RULE;
    expect(r).toContain('Name at most one gaze target');
    expect(r).toContain('Two named characters facing each other are the one exception');
    expect(r).toContain('a single relationship, not two targets');
  });

  it('the exception does not open the frame up — everyone else still looks at them or the action', () => {
    expect(pb.GAZE_TARGET_RULE).toContain('nobody else in the frame looks anywhere but at them or at the action');
  });

  it('8j still prescribes the mutual gaze it always did', () => {
    expect(pb.LOOKS_AT_FIELD_RULE).toContain("each one's `looksAt` is the other");
  });

  it('both rules reach the built prompt, so the exception and the rule travel together', () => {
    const p = built();
    expect(p).toContain(pb.GAZE_TARGET_RULE);
    expect(p).toContain(pb.LOOKS_AT_FIELD_RULE);
  });
});
