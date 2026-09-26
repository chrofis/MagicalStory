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

  // Owner ruling 2026-09-25: an image that contradicts the page's DECLARED LIGHT
  // is MAJOR. Staging job_1790277448294_5herh01j7 p15: at MODERATE the daylight
  // inpaint (95) still beat its night original (85, one MAJOR finding).
  it('a contradiction of the declared light is MAJOR, and a daylight repair no longer beats its night original', () => {
    const p = String(buildSemanticPrompt(require_('../../server/services/prompts').PROMPT_TEMPLATES.imageSemantic,
      { storyText: 't', sceneHint: 'h', imagePrompt: 'p', declaredLight: 'night, fog' }));
    const check = p.split('\n').find(l => l.includes('against DECLARED LIGHT only'));
    expect(check).toMatch(/\*\*\[MAJOR\]\*\*\s*$/);

    const S = require_('../../server/lib/scoring');
    const none = { quality: [], semantic: [], compliance: [], entity: [] };
    const original = { ...none, consolidated: [{ type: 'object_presence', severity: 'major', source: 'consolidated', description: 'a lamp the brief keeps unseen is visible' }] };
    const repair = { ...none, consolidated: [{ type: 'setting', severity: 'MAJOR', source: 'consolidated', description: 'the page is declared night; the image is daytime' }] };
    const v0 = { source: 'original', deductions: original, finalScore: S.computeMathFinalScore(original) };
    const v1 = { source: 'inpaint-round-1', deductions: repair, finalScore: S.computeMathFinalScore(repair) };
    expect(v1.finalScore).toBe(v0.finalScore);
    expect(S.pickBestVersionIndex([v0, v1], { tieBreak: 'earliest' })).toBe(0);
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

// REPAIRS KEEP THE DECLARED LIGHT (staging job_1790277448294_5herh01j7 p15).
// The page declared night + fog; the round-1 inpaint was sent only "Remove the
// visible street lamp from the background." and came back in golden daylight.
// Every repair that repaints pixels now closes on the page's LIGHT line, built
// from the brief's fields by sceneLight.buildRepairLightLine.
describe('every repair that repaints pixels carries the declared light', () => {
  const NIGHT_FOG = brief('The dragon sits by the tree trunk; a lamp glows through the mist.', { timeOfDay: 'night', weather: 'fog' });
  const UNDECLARED = brief('The dragon sits by the tree trunk.', {});
  const IMG = require_('../../server/lib/images');
  const faceRepair = require_('../../server/lib/faceRepair');
  const { buildScaleRepairPrompt } = require_('../../server/lib/scaleRepair');
  const { semanticDeclaredLight } = require_('../../server/lib/sceneValidator');
  const { resolveEvalSceneHint } = require_('../../server/lib/sceneMetadata');
  const NAMES = require_('../../server/lib/repairLogic').buildRepairNameMap({ characters: [{ name: 'Mira', age: 8, gender: 'female' }] });

  it('the repair line names the light and forbids changing it; empty when undeclared', () => {
    const line = L.buildRepairLightLine({ timeOfDay: 'night', weather: 'fog' });
    expect(line.startsWith('**LIGHT:**')).toBe(true);
    expect(line).toContain(L.lightPhrase({ timeOfDay: 'night', weather: 'fog' }));
    expect(line).toContain('flat dark grey haze');
    expect(line).toMatch(/keeps exactly this light, sky and weather/);
    expect(L.buildRepairLightLine({ timeOfDay: null, weather: null })).toBe('');
  });

  it('declaredLightOfBrief reads the fields, never the prose', () => {
    expect(L.declaredLightOfBrief(NIGHT_FOG)).toEqual({ timeOfDay: 'night', weather: 'fog' });
    expect(L.declaredLightOfBrief(brief('A moonlit night in the rain.', {}))).toEqual({ timeOfDay: null, weather: null });
  });

  it('the page inpaint instruction ends on the LIGHT line (the p15 instruction, rebuilt)', () => {
    const sent = IMG.buildInpaintInstruction({
      editInstruction: '1. Remove the visible street lamp from the background.',
      sceneDescription: NIGHT_FOG,
    });
    expect(sent).toContain('Remove the visible street lamp');
    expect(sent.endsWith(`\n\n${L.buildRepairLightLine({ timeOfDay: 'night', weather: 'fog' })}`)).toBe(true);
  });

  it('the page inpaint instruction is unchanged for a brief that declares no light', () => {
    const sent = IMG.buildInpaintInstruction({ editInstruction: '1. Open the eyes.', sceneDescription: UNDECLARED });
    expect(sent).toBe("Fix these issues in this children's book illustration:\n1. Open the eyes.");
  });

  it('every character-repair template branch carries it', async () => {
    for (const axes of [
      { treatment: 'blur', regionSource: 'cutout', faceOnly: false },
      { treatment: 'blur', regionSource: 'cutout', faceOnly: true },
      { treatment: 'crosshatch', regionSource: 'box', faceOnly: false },
      { treatment: 'crosshatch', regionSource: 'cutout', faceOnly: false },
    ]) {
      const p = await faceRepair.buildPrompt({ ...axes, charName: 'Mira', opts: { sceneDescription: NIGHT_FOG, artStyle: 'watercolor', repairNames: NAMES } });
      expect(p, JSON.stringify(axes)).toContain('**LIGHT:** night: dark, the scene lit only by');
      const none = await faceRepair.buildPrompt({ ...axes, charName: 'Mira', opts: { sceneDescription: UNDECLARED, artStyle: 'watercolor', repairNames: NAMES } });
      expect(none, JSON.stringify(axes)).not.toContain('**LIGHT:**');
    }
  });

  it('the scale repair (whole-frame edit) carries it', () => {
    const p = buildScaleRepairPrompt({ bgChars: [], fgChars: [], shot: 'wide', interactions: [], light: { timeOfDay: 'night', weather: 'fog' } });
    expect(p).toContain('**LIGHT:** night: dark, the scene lit only by');
    expect(buildScaleRepairPrompt({ bgChars: [], fgChars: [], shot: 'wide', interactions: [] })).not.toContain('**LIGHT:**');
  });

  it("a repaired version's re-eval is given the page's declared light, not the repair instruction's", () => {
    // Pipeline re-eval inputs for an inpaint version (repairPipeline.buildEvalInputs):
    // sceneHint = the version's brief, imagePrompt = the instruction the edit was sent.
    const hint = resolveEvalSceneHint({ evaluationType: 'scene', entryDescription: NIGHT_FOG, sceneDescription: NIGHT_FOG, outlineExtract: 'PLAN: the dragon hides' });
    const instruction = IMG.buildInpaintInstruction({ editInstruction: '1. Remove the lamp.', sceneDescription: NIGHT_FOG });
    expect(semanticDeclaredLight(hint, instruction)).toBe(L.describeLightForJudge({ timeOfDay: 'night', weather: 'fog' }));
    expect(semanticDeclaredLight(hint, instruction)).toMatch(/^night, fog — /);
    const p = String(buildSemanticPrompt(require_('../../server/services/prompts').PROMPT_TEMPLATES.imageSemantic,
      { storyText: 't', sceneHint: hint, imagePrompt: instruction, declaredLight: semanticDeclaredLight(hint, instruction) }));
    expect(p).toMatch(/\*\*DECLARED LIGHT[^\n]*\*\* night, fog/);
  });
});

// WEATHER OWNS THE SKY (owner, 2026-09-26). The LIGHT line appended the weather
// to a time phrase that named the sun or the moon, so a fog page was told to
// paint "warm daylight from a sun past its height; fog softening the distance"
// and Grok did: fog rendered on 1 of 12 staging fog pages and 0 of 6 night-fog
// pages (job_1790277448294_5herh01j7).
describe('weather owns the sky', () => {
  const COVERED = ['overcast', 'rain', 'snow', 'fog', 'storm'];
  const TIMES = [...L.TIMES_OF_DAY, null];
  // A sky light source named anywhere except inside the clause that forbids it.
  const namesSkySource = (s: string) => /sun|moon|blue sky|blue fading|golden/i.test(s.split(L.COVERED_SKY_CLAUSE).join(''));

  it('a covered weather names no sun, moon or blue sky, and forbids them, at every hour', () => {
    for (const weather of COVERED) for (const timeOfDay of TIMES) {
      const phrase = L.lightPhrase({ timeOfDay, weather });
      expect(namesSkySource(phrase), `${timeOfDay}/${weather}: ${phrase}`).toBe(false);
      expect(phrase).toContain(L.COVERED_SKY_CLAUSE);
    }
  });

  it('fog makes the sky flat and pale by day and fades the distance', () => {
    const p = L.lightPhrase({ timeOfDay: 'afternoon', weather: 'fog' });
    expect(p).toMatch(/flat pale/);
    expect(p).toMatch(/distant forms fading/);
    expect(p).not.toMatch(/sun past its height/);
    expect(L.lightPhrase({ timeOfDay: 'night', weather: 'fog' })).not.toMatch(/lit by the moon/);
  });

  it('every line built from the light carries the composition — page, plate, repair, relight, derive', () => {
    const fog = { timeOfDay: 'afternoon', weather: 'fog' };
    const phrase = L.lightPhrase(fog);
    const lines = [
      L.buildLightLine(fog),
      L.buildLightLine(fog, { plate: true }),
      L.buildRepairLightLine(fog),
      L.buildPlateRelightInstruction(fog),
      buildPlateDeriveInstruction('medium', 'high-angle', { relight: L.relightClause(fog) }),
      buildPlateDeriveInstruction('medium', 'high-angle', { keepLight: L.keepLightClause(fog) }),
      buildEmptyScenePrompt({ style: 'watercolour', description: 'A pier.', light: fog }),
      String(PB.buildImagePrompt(brief('The main character stands on the pier.', fog), inputData, null, { artifacts: [], locations: [] }, 1, null, {})),
    ];
    for (const line of lines) {
      expect(line).toContain(phrase);
      expect(namesSkySource(line.split(phrase).join(''))).toBe(false);
    }
  });

  it('a derive that keeps the base light names its weather, never only the hour', () => {
    const kept = buildPlateDeriveInstruction('medium', 'high-angle', { keepLight: L.keepLightClause({ timeOfDay: 'dusk', weather: 'rain' }) });
    expect(kept).toContain('rain falling');
    expect(kept).not.toContain('the light keeps the same direction and time of day');
  });

  it('clear and indoor pages are unchanged', () => {
    expect(L.lightPhrase({ timeOfDay: 'afternoon', weather: 'clear' })).toBe('afternoon: warm daylight from a sun past its height; a clear sky');
    expect(L.lightPhrase({ timeOfDay: 'night', weather: 'clear' })).toBe('night: a dark sky, the scene lit by the moon and by the light sources in it; a clear sky');
    expect(L.lightPhrase({ timeOfDay: 'evening', weather: 'none' })).toBe("evening: a low golden sun, long shadows; indoors: the light comes from the room's own sources and any window");
    expect(L.lightPhrase({ timeOfDay: 'dusk', weather: null })).toBe('dusk: the sun down, a deep blue fading sky, the first lamps lit');
    expect(L.describeLightForJudge({ timeOfDay: 'night', weather: 'clear' })).toBe('night, clear');
    expect(L.describeLightForJudge({ timeOfDay: null, weather: null })).toBe('');
  });

  it('the judges read the sky phrase the illustrator was given', () => {
    const fog = { timeOfDay: 'night', weather: 'fog' };
    const sky = L.describeLightForJudge(fog).split(' — ')[1];
    expect(L.buildLightLine(fog)).toContain(sky);
    expect(buildEmptySceneQcPrompt({ sceneDescription: 'A pier.', light: fog })).toContain(`the plate is painted in ${L.describeLightForJudge(fog)}`);
    const p = String(buildSemanticPrompt(require_('../../server/services/prompts').PROMPT_TEMPLATES.imageSemantic,
      { storyText: 't', sceneHint: 'x', imagePrompt: 'x', declaredLight: L.describeLightForJudge(fog) }));
    expect(p).toContain(sky);
  });
});
