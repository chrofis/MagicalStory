import { describe, it, expect } from 'vitest';

// @ts-expect-error - plain CommonJS module, no types
import * as storyShape from '../../server/lib/storyShape.js';

const { rollUpScenePrompts, resolveScenePrompt, projectSceneCast, resolveSceneCast } = storyShape as {
  rollUpScenePrompts: (scenes: any[]) => { prompts: any[]; refByPage: Map<number, number> };
  resolveScenePrompt: (storyData: any, pageNumber: number) => string | null;
  projectSceneCast: (characters: any[]) => Array<{ id: any; name: string }>;
  resolveSceneCast: (storyData: any, stored: any[]) => any[];
};

const AD_PROMPT = 'ART DIRECTOR: expand every page.';

describe('rollUpScenePrompts — the Art Director prompt is stored once', () => {
  it('collapses one shared all-pages prompt into a single entry every page points at', () => {
    const scenes = [1, 2, 3].map(pageNumber => ({
      pageNumber, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm1',
    }));
    const { prompts, refByPage } = rollUpScenePrompts(scenes);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].pages).toEqual([1, 2, 3]);
    expect([...refByPage.values()]).toEqual([0, 0, 0]);
  });

  it('gives a per-page fallback prompt its own entry', () => {
    const { prompts, refByPage } = rollUpScenePrompts([
      { pageNumber: 1, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm1' },
      { pageNumber: 2, sceneDescriptionPrompt: 'PER-PAGE for page 2', sceneDescriptionModelId: 'm1' },
      { pageNumber: 3, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm1' },
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].pages).toEqual([1, 3]);
    expect(prompts[1].pages).toEqual([2]);
    expect(refByPage.get(2)).toBe(1);
  });

  it('separates the same prompt text answered by two different models', () => {
    const { prompts } = rollUpScenePrompts([
      { pageNumber: 1, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm1' },
      { pageNumber: 2, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm2' },
    ]);
    expect(prompts).toHaveLength(2);
  });

  it('stores nothing for a run that expanded no scenes (trial mode)', () => {
    const { prompts, refByPage } = rollUpScenePrompts([
      { pageNumber: 1, sceneDescriptionPrompt: null, sceneDescriptionModelId: null },
    ]);
    expect(prompts).toEqual([]);
    expect(refByPage.size).toBe(0);
  });

  it('never stores the same prompt text twice', () => {
    const scenes = Array.from({ length: 18 }, (_, i) => ({
      pageNumber: i + 1, sceneDescriptionPrompt: AD_PROMPT, sceneDescriptionModelId: 'm1',
    }));
    const { prompts } = rollUpScenePrompts(scenes);
    const texts = prompts.map(p => p.prompt);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toEqual([AD_PROMPT]);
  });
});

describe('resolveScenePrompt', () => {
  const stored = {
    sceneDescriptions: [
      { pageNumber: 1, scenePromptRef: 0 },
      { pageNumber: 2, scenePromptRef: 1 },
      { pageNumber: 3, scenePromptRef: null },
    ],
    sceneExpansionReport: { prompts: [{ prompt: AD_PROMPT, modelId: 'm1', pages: [1] }, { prompt: 'OTHER', modelId: 'm1', pages: [2] }] },
  };

  it('resolves a page through its ref', () => {
    expect(resolveScenePrompt(stored, 1)).toBe(AD_PROMPT);
    expect(resolveScenePrompt(stored, 2)).toBe('OTHER');
  });

  it('returns null for a page whose run stored no prompt', () => {
    expect(resolveScenePrompt(stored, 3)).toBeNull();
    expect(resolveScenePrompt(stored, 99)).toBeNull();
  });

  it('reads the pre-2026-09-21 inline shape', () => {
    const legacy = { sceneDescriptions: [{ pageNumber: 1, scenePrompt: 'LEGACY INLINE' }] };
    expect(resolveScenePrompt(legacy, 1)).toBe('LEGACY INLINE');
  });

  it('returns null rather than a wrong prompt when the table cannot answer the ref', () => {
    const broken = { sceneDescriptions: [{ pageNumber: 1, scenePromptRef: 7 }], sceneExpansionReport: { prompts: [] } };
    expect(resolveScenePrompt(broken, 1)).toBeNull();
  });
});

describe('page cast is stored as identity only', () => {
  const full = (id: number, name: string) => ({
    id, name, age: 5, gender: 'male',
    avatars: { prompts: { standard: 'x'.repeat(2000) }, storyHistory: [{ storyId: 's' }] },
    physical: { hair: 'blonde' },
  });
  const storyData = { characters: [full(1, 'Levin'), full(2, 'Julian')] };

  it('projects to {id, name} only', () => {
    expect(projectSceneCast(storyData.characters)).toEqual([{ id: 1, name: 'Levin' }, { id: 2, name: 'Julian' }]);
  });

  it('round-trips back to the FULL record, so no reader loses a field', () => {
    const resolved = resolveSceneCast(storyData, projectSceneCast(storyData.characters));
    expect(resolved).toEqual(storyData.characters);
    // The fields readers actually reach for through the stored cast.
    expect(resolved[0].age).toBe(5);
    expect(resolved[0].physical.hair).toBe('blonde');
  });

  it('resolves a legacy row full record against the live roster', () => {
    const legacyStored = [{ id: 1, name: 'Levin', avatars: { prompts: { standard: 'STALE' } } }];
    expect(resolveSceneCast(storyData, legacyStored)[0]).toBe(storyData.characters[0]);
  });

  it('falls back to name when the id is absent (bare-string cast)', () => {
    expect(resolveSceneCast(storyData, ['Julian'] as any)[0]).toBe(storyData.characters[1]);
  });

  it('never drops a cast member the roster does not know', () => {
    const out = resolveSceneCast(storyData, [{ id: 9, name: 'Ghost' }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Ghost');
  });
});
