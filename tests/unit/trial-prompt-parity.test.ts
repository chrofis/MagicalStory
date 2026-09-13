import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildTrialStoryPrompt, buildImagePrompt } = require('../../server/lib/promptBuilders.js');
const { extractSceneMetadata } = require('../../server/lib/sceneMetadata.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

// Trial writes its own scene hints and never runs an Art Director, so rules
// that live only in scene-expansion*.txt reach no trial page. These tests pin
// the BEHAVIOUR — that each rule class arrives in the built trial prompt, and
// that a trial-shaped scene hint's interactions[] survive the parser into the
// image prompt's protected tail — not the wording of any one rule.

const trialInput = (age: number) => ({
  trialMode: true,
  language: 'de',
  storyTheme: 'realistic',
  storyDetails: 'a kite caught in a tree',
  characters: [{ name: 'Mia', age, gender: 'female', isMain: true }],
});

let prompts: Record<number, string>;

beforeAll(async () => {
  await loadPromptTemplates();
  prompts = { 3: '', 6: '', 9: '' };
  for (const age of [3, 6, 9]) prompts[age] = buildTrialStoryPrompt(trialInput(age), 5);
});

describe('trial story prompt — the template is actually used', () => {
  it('renders the full template, not the one-line fallback', () => {
    for (const age of [3, 6, 9]) expect(prompts[age].length).toBeGreaterThan(5000);
  });

  it('leaves no unfilled placeholder', () => {
    for (const age of [3, 6, 9]) expect(prompts[age].match(/\{[A-Z_]+\}/g)).toBeNull();
  });
});

describe('page-opening variety reaches the trial writer', () => {
  it('states the vary-the-opening rule', () => {
    expect(prompts[6]).toMatch(/Vary how each page begins/);
  });

  it('scopes the start-with-action rule to page 1 so the two do not contradict', () => {
    expect(prompts[6]).toMatch(/Page 1 starts with action/);
    expect(prompts[6]).not.toMatch(/^- Start with action, not weather/m);
  });

  it('forbids prose asserting what the scene hint does not stage', () => {
    expect(prompts[6]).toMatch(/never asserts a position, an action or an object/);
  });
});

describe('Art Director composition rules reach the trial scene hints', () => {
  const rules: Array<[string, RegExp]> = [
    ['one focal point', /One moment, one focal point/],
    ['one instant, no history', /One instant, no history/],
    ['one level per frame', /One level per frame/],
    ['no partial immersion', /No partial immersion/],
    ['footing', /^- Footing\./m],
    ['close-up ends at the waist', /frame ends at the waist/],
  ];
  for (const [name, re] of rules) {
    it(`carries: ${name}`, () => expect(prompts[6]).toMatch(re));
  }
});

describe('creature tone is banded by the main character age', () => {
  it('0-4 gets cute, 5-6 not-menacing, 7+ formidable', () => {
    expect(prompts[3]).toMatch(/drawn cute/);
    expect(prompts[6]).toMatch(/open friendly face/);
    expect(prompts[6]).not.toMatch(/drawn cute/);
    expect(prompts[9]).toMatch(/powerful, wild or formidable/);
    expect(prompts[9]).not.toMatch(/open friendly face/);
  });

  it('comes from the shared resolver, not a trial-local copy of the level text', () => {
    // buildCreatureToneSection appends CREATURE_TONE_PAGE_RULE to every level;
    // a hand-copied level string would not carry it.
    for (const age of [3, 6, 9]) {
      expect(prompts[age]).toMatch(/a creature's entry does not travel to the page/);
    }
  });

  it('omits the section entirely when no age is known', () => {
    const noAge = buildTrialStoryPrompt({ ...trialInput(6), characters: [{ name: 'Mia', isMain: true }] }, 5);
    expect(noAge).not.toMatch(/drawn cute|open friendly face|powerful, wild or formidable/);
  });
});

describe('interactions[] survive from a trial scene hint to the image prompt', () => {
  const hint = JSON.stringify({
    scene: {
      imageSummary: 'A child runs across a bridge holding a kite string.',
      setting: { location: 'Bridge [LOC001]', indoorOutdoor: 'outdoor', description: 'wooden bridge', lighting: 'afternoon', weather: 'sunny', camera: 'medium', depthLayers: 'a, b, c' },
      characters: [{ id: null, name: 'Mia', position: 'center', action: 'runs', expression: 'eager', clothing: 'standard', depth: 'foreground', perspective: 'front' }],
      objects: [{ id: 'ART001', name: 'kite', position: 'above' }],
      interactions: [{ character: 'Mia', object: 'kite', where: 'grips the kite string in both hands', priority: 'essential' }],
    },
  });

  it('the trial prompt asks for interactions in the scene hint schema', () => {
    expect(prompts[6]).toMatch(/"interactions":\s*\[/);
  });

  it('the parser keeps the row in the shape buildExactPosesBlock reads', () => {
    const meta = extractSceneMetadata(hint);
    expect(meta.interactions).toEqual([
      { character: 'Mia', object: 'kite', where: 'grips the kite string in both hands', priority: 'essential' },
    ]);
  });

  it('the image prompt emits EXACT POSES inside the shrink-protected tail', () => {
    const meta = extractSceneMetadata(hint);
    expect(meta.interactions).toBeTruthy();
    const prompt = buildImagePrompt(hint, { trialMode: true, artStyle: 'pixar', language: 'de', characters: [{ name: 'Mia', age: 6, isMain: true }] }, [{ name: 'Mia' }], null, 1, [], {});
    const posesAt = prompt.indexOf('EXACT POSES');
    expect(posesAt).toBeGreaterThan(-1);
    expect(prompt).toMatch(/- Mia: grips the kite string in both hands/);
    // shrinkPromptForModel compresses only the head before this marker.
    const tailAt = Math.max(prompt.indexOf('**REQUIRED OBJECTS'), prompt.indexOf('**ART STYLE'));
    expect(tailAt).toBeGreaterThan(-1);
    expect(posesAt).toBeGreaterThan(tailAt);
  });
});
