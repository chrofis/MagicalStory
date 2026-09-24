/**
 * SCENE LIGHT — a page's declared time of day and weather (owner, 2026-09-24).
 *
 * Reversal of decisions.md 2026-08-11 ("prose covers lighting/weather") and
 * 2026-08-15 ("rejected for now: a declared time-of-day"). Evidence: prod
 * job_1790107559778_fcmlfa8kn, where the p2/p4/p5/p6 plates were byte-identical
 * with p2's rain, and 7 of 15 staging shared-plate pages whose light differed
 * rendered the wrong light.
 *
 * Every assertion runs the REAL builder or parser — never template text.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const L = require_('../../server/lib/sceneLight');
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates, buildEmptyScenePrompt } = require_('../../server/services/prompts');
const { extractSceneMetadata } = require_('../../server/lib/sceneMetadata');
const { buildSemanticPrompt } = require_('../../server/lib/sceneValidator');
const { buildEmptySceneQcPrompt } = require_('../../server/lib/evalPipeline');
const { shrinkPromptForModel } = require_('../../server/lib/images');
const { checkPage, REVIEWABLE } = require_('../../server/lib/sceneBriefCheck');
const { buildPlateDeriveInstruction } = require_('../../server/lib/shotVocabulary');
const { selectGeometryFacts } = require_('../../server/lib/sceneGeometry');

const brief = (prose: string, meta: Record<string, unknown> = {}) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'The main character lifts the lantern on the pier.',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide',
    objects: [],
    ...meta,
  })}`;

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
  mainCharacters: ['c1'],
  language: 'en',
  pages: 2,
  season: 'autumn',
  artStyle: 'watercolor',
};

beforeAll(async () => { await loadPromptTemplates(); });

describe('the parser publishes the two fields, normalised', () => {
  it('prose + metadata brief', () => {
    const m = extractSceneMetadata(brief('A pier.', { timeOfDay: 'Night', weather: 'rain' }));
    expect(m.timeOfDay).toBe('night');
    expect(m.weather).toBe('rain');
    expect(m.fullData.timeOfDay).toBe('night');
    expect(L.declaredLight(m)).toEqual({ timeOfDay: 'night', weather: 'rain' });
  });
  it('an unknown word is not a declaration', () => {
    const m = extractSceneMetadata(brief('A pier.', { timeOfDay: 'golden hour', weather: 'sunny' }));
    expect(L.declaredLight(m)).toEqual({ timeOfDay: null, weather: null });
  });
  it('a stored brief without the fields declares nothing', () => {
    expect(L.declaredLight(extractSceneMetadata(brief('A pier at night in the rain.')))).toEqual({ timeOfDay: null, weather: null });
  });
  it('the trial JSON scene hint', () => {
    const hint = '```json\n' + JSON.stringify({ scene: { imageSummary: 'x', characters: [{ name: 'Mira' }], objects: [], timeOfDay: 'dusk', weather: 'none' } }) + '\n```';
    expect(L.declaredLight(extractSceneMetadata(hint))).toEqual({ timeOfDay: 'dusk', weather: 'none' });
  });
});

describe('the page prompt carries a fixed LIGHT line the shrink never cuts', () => {
  const lit = () => String(PB.buildImagePrompt(brief('The main character stands on the pier.', { timeOfDay: 'evening', weather: 'rain' }), inputData, null, { artifacts: [], locations: [] }, 1, null, {}));
  it('built from the fields', () => {
    expect(lit()).toContain(L.buildLightLine({ timeOfDay: 'evening', weather: 'rain' }));
  });
  it('absent when the brief declares no light — and nothing dangles', () => {
    const p = String(PB.buildImagePrompt(brief('The main character stands on the pier.'), inputData, null, { artifacts: [], locations: [] }, 1, null, {}));
    expect(p).not.toContain('**LIGHT:**');
    expect(p).not.toContain('{LIGHT_NOTE}');
  });
  it('the plate no longer hands the page its light', () => {
    expect(lit()).not.toContain('geography and light direction');
    expect(lit()).toContain('Its time of day and weather give way to the LIGHT line');
  });
  it('survives a shrink to the cap', async () => {
    const p = lit();
    const out = await shrinkPromptForModel(p, p.length - 400, 'test');
    expect(out.length).toBeLessThanOrEqual(p.length - 400);
    expect(out).toContain(L.buildLightLine({ timeOfDay: 'evening', weather: 'rain' }));
  });
});

describe('the plate prompt and its judge read the same two fields', () => {
  const light = { timeOfDay: 'night', weather: 'clear' };
  it('the plate gets a LIGHT line', () => {
    const p = buildEmptyScenePrompt({ style: 'watercolour', description: 'A pier.', light });
    expect(p).toContain(L.buildLightLine(light, { plate: true }));
    expect(p).not.toContain('{LIGHT_NOTE}');
    expect(buildEmptyScenePrompt({ style: 'watercolour', description: 'A pier.' })).not.toContain('**LIGHT:**');
  });
  it('the plate QC checks that light, and only when one is declared', () => {
    expect(buildEmptySceneQcPrompt({ sceneDescription: 'A pier.', light })).toContain('the plate is painted in night, clear');
    expect(buildEmptySceneQcPrompt({ sceneDescription: 'A pier.' })).not.toContain('- Light:');
  });
  it('a relit derive changes only the light; an angled one moves the camera and re-lights in one edit', () => {
    const relight = L.buildPlateRelightInstruction(light);
    expect(relight).toContain('night');
    expect(relight).toMatch(/keep their shape/);
    const angled = buildPlateDeriveInstruction('medium', 'high-angle', { relight: L.relightClause(light) });
    expect(angled).toContain('The light changes to night');
    expect(angled).not.toContain('the light keeps the same direction and time of day');
    expect(buildPlateDeriveInstruction('medium', 'high-angle')).toContain('the light keeps the same direction and time of day');
  });
});

describe('one rule for every brief author and the scene review', () => {
  it('reaches the all-pages AD, the review and the trial writer, filled', () => {
    const beats = [{ pageNumber: 1, planLine: 'wide — Mira — she lifts the lantern — it glows' }];
    const built = [
      String(PB.buildSceneExpansionAllPrompt(inputData, beats, {})),
      String(PB.buildSceneReviewPrompt(inputData, [{ pageNumber: 1, brief: brief('A pier.') }], { beats })),
      String(PB.buildTrialStoryPrompt(inputData, 4)),
    ];
    for (const text of built) {
      expect(text).toContain(L.SCENE_LIGHT_FIELD_RULE);
      expect(text).not.toMatch(/\{SCENE_LIGHT_FIELD\}|\{TIME_OF_DAY_ENUM\}|\{WEATHER_ENUM\}/);
    }
  });
  it('the AD no longer splits a vantage for light — the plate is re-lit instead', () => {
    const ad = String(PB.buildSceneExpansionAllPrompt(inputData, [{ pageNumber: 1, planLine: 'wide — Mira — x — y' }], {}));
    expect(ad).not.toContain('Split it too when its pages differ in time of day or weather');
    expect(ad).toContain('Never split for a different cast, time of day or weather');
  });
});

describe('a rewrite keeps the declared light it does not restate', () => {
  const parent = brief('Old.', { timeOfDay: 'night', weather: 'rain' });
  it('carries both fields forward from a brief text', () => {
    const r = L.carryForwardLightInBrief(brief('New.'), parent);
    expect(r.carried).toEqual(['timeOfDay', 'weather']);
    expect(L.declaredLight(extractSceneMetadata(r.brief))).toEqual({ timeOfDay: 'night', weather: 'rain' });
  });
  it('and from parsed metadata', () => {
    const r = L.carryForwardLightInBrief(brief('New.'), extractSceneMetadata(parent));
    expect(r.carried).toEqual(['timeOfDay', 'weather']);
  });
  it('a rewrite that states a light wins', () => {
    expect(L.carryForwardLightInBrief(brief('New.', { timeOfDay: 'dawn', weather: 'fog' }), parent)).toBeNull();
  });
});

describe('the scene review is told when a page declares no light', () => {
  it('light_undeclared, REVIEWABLE', () => {
    const f = checkPage({ pageNumber: 1, brief: brief('A pier.', { weather: 'clear' }) }, [], null, {});
    const hit = f.find((x: any) => x.type === 'light_undeclared');
    expect(hit.fields).toEqual(['timeOfDay']);
    expect(REVIEWABLE.has('light_undeclared')).toBe(true);
    expect(checkPage({ pageNumber: 1, brief: brief('A pier.', { timeOfDay: 'morning', weather: 'clear' }) }, [], null, {})
      .some((x: any) => x.type === 'light_undeclared')).toBe(false);
  });
});

describe('the semantic judge judges light against the declared fields', () => {
  it('fills DECLARED LIGHT', () => {
    const p = String(buildSemanticPrompt(PB.PROMPT_TEMPLATES?.imageSemantic || require_('../../server/services/prompts').PROMPT_TEMPLATES.imageSemantic,
      { storyText: 't', sceneHint: 'h', imagePrompt: 'p', declaredLight: 'night, rain' }));
    expect(p).toContain('night, rain');
    expect(p).not.toContain('{DECLARED_LIGHT}');
    expect(p).toMatch(/against DECLARED LIGHT only/);
  });
});

describe('neighbouring hours are not a contradiction', () => {
  it('timeContradicts', () => {
    expect(L.timeContradicts('evening', 'dusk')).toBe(false);
    expect(L.timeContradicts('dusk', 'night')).toBe(false);
    expect(L.timeContradicts('night', 'midday')).toBe(true);
    expect(L.timeContradicts('evening', null)).toBe(false);
  });
});

describe('plate geometry salvages a long sentence instead of dropping it', () => {
  it('keeps the light clause of a sentence over 240 characters', () => {
    // Shape of prod job_1790107559778_fcmlfa8kn p10: a 247-char sentence whose
    // only lighting fact was "at night".
    const long = 'The main character kneels beside the heavy wooden door of the old tower with both hands pressed against the iron-banded planks and her brother crouching close behind her shoulder, while the lantern light from the left falls across the cobbles at night.';
    expect(long.length).toBeGreaterThan(240);
    const { facts } = selectGeometryFacts({ mainScenePrompt: long, castNames: ['Mira'] });
    expect(facts.join(' ')).toMatch(/night/);
    expect(facts.join(' ')).not.toMatch(/brother|hands/);
  });
  it('never keeps a cut clause whose subject was the figure', () => {
    // Measured over 54 stored staging pages: "stands seen from behind on the
    // steep slope", "leaning slightly forward" — figure actions, not the place.
    const long = 'The older boy in a red hooded jacket with navy corduroy trousers and mud-brown rubber boots, carrying the heavy sledge rope over one shoulder and breathing hard, stands seen from behind on the steep autumn slope, leaning slightly forward toward the ridge.';
    expect(long.length).toBeGreaterThan(240);
    const { facts } = selectGeometryFacts({ mainScenePrompt: long, castNames: [] });
    expect(facts.join(' ')).not.toMatch(/stands|leaning/);
  });
});
