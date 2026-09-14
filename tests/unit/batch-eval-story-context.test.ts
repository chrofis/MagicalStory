import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the judge's evalOptions carry the story context. Without
// storyData the cast resolver has no main-cast index and every main-cast token
// logs unresolved; without clothingRequirements there is no clothing contract.
// Own file: images.js destructures evaluateImageQuality at load, so the stub
// must be installed before anything requires images.js.

describe('evaluateImageBatch forwards the story context to the judge', () => {
  it('storyData and clothingRequirements reach evalOptions', async () => {
    // images.js destructures evaluateImageQuality at load — stub first.
    const ep = require_('../../server/lib/evalPipeline.js');
    const calls: any[] = [];
    ep.evaluateImageQuality = vi.fn(async (...args: any[]) => {
      calls.push(args);
      return { score: 50, figures: [{ label: 'x' }], matches: [], detectedProblems: [] };
    });
    const { evaluateImageBatch } = require_('../../server/lib/images.js');

    const storyData = { id: 'story-1', clothingRequirements: { Levin: { standard: { used: true } } } };
    await evaluateImageBatch(
      [{
        pageNumber: 1,
        imageData: 'data:image/jpeg;base64,AAAA',
        prompt: 'a prompt',
        sceneDescription: 'a scene',
        characterPhotos: [{ name: 'Levin', photoUrl: 'p1', clothingDescription: 'pirate coat' }],
        allCharacterPhotos: [{ name: 'Julian', photoUrl: 'c2', clothingDescription: 'green shirt' }],
      }],
      { concurrency: 1, storyData, clothingRequirements: storyData.clothingRequirements, artStyle: 'watercolor' }
    );

    expect(calls).toHaveLength(1);
    const evalOptions = calls[0][9];
    expect(evalOptions.storyData).toBe(storyData);
    expect(evalOptions.clothingRequirements).toBe(storyData.clothingRequirements);
    // And the refs the judge got are page-first + the missing cast member.
    const refs = calls[0][2];
    expect(refs.map((r: any) => r.name)).toEqual(['Levin', 'Julian']);
  });
});
