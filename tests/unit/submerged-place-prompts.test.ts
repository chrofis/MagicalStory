/**
 * A SUBMERGED PLACE IN THE PROMPTS (owner, 2026-10-07). Staging job_1791315635053_t0t8qpebu:
 *  - autumn leaves drifted in the water of p4 and p6 (the SEASON block named foliage and ground cover on every page);
 *  - p4's underwater plate kept the beach's bench and dunes (the LOCATION line carried the location's features and
 *    signature element into a vantage whose camera could see neither);
 *  - p6's exterior of a wreck came out as its interior ("ribs forming the enclosed hull space" and "never draw that
 *    structure seen from outside").
 * Pins behaviour, never prompt wording. Archetypal fixtures. see docs/decisions.md 2026-10-07.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { SEASON_NO_SKY_RULE, buildSeasonNote } = require_('../../server/lib/season');
const { vantageSettingText } = require_('../../server/lib/sceneMetadata');
const { englishLocationRef } = require_('../../server/lib/visualBible');
const { PLATE_STRUCTURE_PART_RULE } = require_('../../server/services/prompts');
const { loadPromptTemplates } = require_('../../server/services/prompts');

const inputData: any = { season: 'autumn', language: 'en', characters: [{ name: 'Ana', age: 7, gender: 'female' }] };
const BEATS = [{ pageNumber: 1, planLine: 'medium — Ana — x — y' }];
const VB: any = { artifacts: [], locations: [], vehicles: [], animals: [], secondaryCharacters: [], clothing: [] };

describe('the season rule for a picture with no sky is one constant in every brief author', () => {
  let built: Record<string, string>;
  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      'AD all-pages': String(PB.buildSceneBriefsAllPrompt(inputData, BEATS, { jevBackup: true })),
      'AD per-page': String(PB.buildSceneExpansionPrompt(1, 'page text', inputData.characters, 'en', VB, '', null, { jevBackup: true, story: inputData })),
      'iterate strict': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: false, story: inputData })),
      'iterate free': String(PB.buildSceneDescriptionPrompt(1, 'page text', inputData.characters, '', 'en', VB, [], 'standard', '', '',
        { planLine: BEATS[0].planLine }, { fixIssues: ['x'] }, { freeIterate: true, story: inputData })),
      'Visual Bible': String(PB.buildVisualBibleCallPrompt(inputData, BEATS, { jevBackup: true })),
    };
  });
  it('every built prompt carries SEASON_NO_SKY_RULE and no unfilled {SEASON_NO_SKY}', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(prompt.includes(SEASON_NO_SKY_RULE), `${site} lacks the rule`).toBe(true);
      expect(prompt.includes('{SEASON_NO_SKY}'), `${site} ships the placeholder`).toBe(false);
    }
  });
  it('the Visual Bible call asks for the `submerged` fact on a location and on a vehicle', () => {
    const tpl = fs.readFileSync(path.resolve(__dirname, '../../prompts/visual-bible.txt'), 'utf8');
    expect(tpl.match(/"submerged":/g)).toHaveLength(2);
  });
});

describe('the page prompt carries no SEASON line for a picture with no sky', () => {
  it('skyless: nothing; an interior: the window only; outdoors: unchanged', () => {
    expect(buildSeasonNote(inputData, { skyless: true })).toBe('');
    expect(buildSeasonNote(inputData, { indoor: true })).toMatch(/window or door/);
    expect(buildSeasonNote(inputData, {})).toMatch(/Foliage, ground cover, sky and daylight colour/);
  });
});

describe('a vantage plate\'s LOCATION line holds only what its camera sees', () => {
  const loc = { name: 'The Shore', features: 'sandy shoreline, rolling dunes', colors: 'pale yellow, dark blue', signatureElement: 'a weathered wooden bench' };
  it('with its own description: the place\'s name and colours, never its features or signature element', () => {
    const text = vantageSettingText({ location: loc, locationName: 'The Shore', name: 'Under the Surface', description: 'Water all around, a sandy seabed below.' }, '');
    expect(text).toContain('The Shore (pale yellow, dark blue)');
    expect(text).not.toMatch(/bench|dunes|shoreline/);
    expect(text).toContain('Water all around');
  });
  it('without a description of its own the whole place is all the plate has, as before', () => {
    const text = vantageSettingText({ location: loc, locationName: 'The Shore', name: 'Wide' }, '');
    expect(text).toMatch(/bench/);
    expect(text).toMatch(/dunes/);
  });
  it('englishLocationRef keeps its default: features, colours and signature', () => {
    expect(englishLocationRef(loc)).toBe('The Shore (sandy shoreline, rolling dunes; pale yellow, dark blue; a weathered wooden bench)');
  });
});

describe('a structure seen from outside is drawn from outside', () => {
  it('the plate\'s structure rule (also read by the plate QC) and the plate template both say it', () => {
    expect(PLATE_STRUCTURE_PART_RULE).toMatch(/outside it, show the vessel from outside/);
    const tpl = fs.readFileSync(path.resolve(__dirname, '../../prompts/empty-scene.txt'), 'utf8');
    expect(tpl).toMatch(/stands outside a vehicle or structure, draw it from outside/);
  });
});
