import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildImagePrompt, buildRequiredCastRule } = require('../../server/lib/promptBuilders.js');
const { extractSceneMetadata, POPULATION_LEVELS } = require('../../server/lib/sceneMetadata.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

// Replay (rung 1, free): a trial-shaped scene hint — the JSON block
// prompts/story-trial-pages.txt asks for, as storyJobPipeline's trial page passes it
// to extractSceneMetadata and buildImagePrompt — with and without the
// `population` field the trial writer declares since 2026-10-07. Before that
// field every trial page read as cast_only, so the image prompt said
// "no one else is added" under a BACKGROUND line the same hint had written as
// "busy crowd". A hint WITHOUT the field keeps exactly that reading (stored
// trials predate the field), and a hint WITH it gets the REQUIRED CAST tail
// of its level.

const trialHint = (extra: Record<string, unknown>) => JSON.stringify({
  scene: {
    imageSummary: 'A child weaves through a busy market square holding a paper kite.',
    setting: { location: 'Market Square [LOC001]', indoorOutdoor: 'outdoor', description: 'cobbled square with striped stalls', lighting: 'afternoon sun from the left', camera: 'medium', depthLayers: 'stalls in front, square behind, church far back' },
    timeOfDay: 'afternoon',
    weather: 'clear',
    characters: [{ id: null, name: 'Mia', position: 'center', action: 'weaves between stalls', expression: 'eager', clothing: 'standard', depth: 'foreground', perspective: 'front' }],
    objects: [{ id: 'ART001', name: 'paper kite', position: 'under her arm' }],
    interactions: [{ character: 'Mia', object: 'paper kite', where: 'holds the paper kite under one arm', priority: 'essential' }],
    background: 'busy market crowd',
    ...extra,
  },
});

const inputData = { trialMode: true, artStyle: 'pixar', language: 'de', characters: [{ name: 'Mia', age: 6, isMain: true }] };
const render = (hint: string) => String(buildImagePrompt(hint, inputData, [{ name: 'Mia' }], null, 1, [], {}));
const requiredCastLine = (prompt: string) => (prompt.match(/^\*\*REQUIRED CAST:\*\*.*$/m) || [''])[0];

beforeAll(async () => { await loadPromptTemplates(); });

describe('the trial hint parser reads `population`', () => {
  it.each(POPULATION_LEVELS)('%s survives extractSceneMetadata as itself', (level: string) => {
    const meta = extractSceneMetadata(trialHint({ population: level }));
    expect(meta.population).toBe(level);
    expect(meta.crowdExpected).toBe(level === 'crowd');
  });

  it('a hint without the field reads as cast_only, exactly as every stored trial hint does', () => {
    const meta = extractSceneMetadata(trialHint({}));
    expect(meta.population).toBe('cast_only');
    expect(meta.crowdExpected).toBe(false);
    expect(meta.fullData.background).toBe('busy market crowd');
  });
});

describe('REQUIRED CAST and BACKGROUND agree on a crowded trial page', () => {
  it('a crowd page asks for the unnamed people the scene places, never "no one else is added"', () => {
    const prompt = render(trialHint({ population: 'crowd' }));
    expect(prompt).toContain('**BACKGROUND:** busy market crowd');
    const cast = requiredCastLine(prompt);
    expect(cast).toBe(buildRequiredCastRule('crowd'));
    expect(cast).toContain('Paint the unnamed people the scene description places');
    expect(cast).not.toContain(', and no one else is added.');
  });

  it('an ambient page asks for a few distant passers-by', () => {
    const cast = requiredCastLine(render(trialHint({ population: 'ambient', background: 'a few passersby' })));
    expect(cast).toBe(buildRequiredCastRule('ambient'));
    expect(cast).toContain('a few unnamed passers-by far behind the cast');
  });

  it('a hint without `population` renders byte-identically to a hint that says cast_only', () => {
    const before = render(trialHint({}));
    const explicit = render(trialHint({ population: 'cast_only' }));
    expect(requiredCastLine(before)).toBe(buildRequiredCastRule('cast_only'));
    expect(requiredCastLine(before)).toContain(', and no one else is added.');
    expect(before).toContain('**BACKGROUND:** busy market crowd');
    expect(explicit).toBe(before);
  });
});
