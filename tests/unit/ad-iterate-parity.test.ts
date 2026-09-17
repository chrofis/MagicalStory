/**
 * ITERATE IS THE SECOND ART DIRECTOR — and it must hold the same contract.
 *
 * WHY THIS EXISTS — owner directive, 2026-09-17. A page brief is authored at
 * FOUR sites: the two Art Director templates that write it the first time
 * (scene-expansion.txt, scene-expansion-all.txt) and the two iterate templates
 * that REWRITE it when the render proves it unbuildable (scene-iteration.txt,
 * scene-iteration-free.txt). The rewrite replaces the brief wholesale and
 * becomes the page's contract with the image model, so a rule only the first
 * author holds is a rule one repair round deletes — and no diff will ever flag
 * it, because nothing in the tree says the four files are related.
 *
 * MEASURED, over the 11 stored iterate rounds of staging
 * job_1789584708605_rts4wqupm (p4, p6, p9, p10, p13, p16) and
 * job_1789506283204_3kxqshifx (p2, p7, p10, p13, p16): 11 of 11 rewrites came
 * back with no `shot`, no `landmarkView`, no `wornItems` row, and `depth` and
 * `looksAt` on 0 of their characters — where the brief each one replaced
 * carried every one of them.
 *
 * The pre-push gate (check-sibling-paths.js, set `art-director-vs-iterate`)
 * catches a COMMIT that moves one side only. This catches drift already in the
 * tree, and it checks the BUILT prompts rather than the templates: a
 * placeholder nobody fills is stripped silently by fillTemplate, so a template
 * that "has the rule" can still ship without it.
 *
 * Behaviour pinned, never wording: nothing here asserts what a rule SAYS, only
 * that the same constant reaches all four builders and that the fields the
 * first author declares are fields the rewriter is asked for.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');

const PB = nodeRequire('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/admin/sibling-registry.json'), 'utf8'));
const SET = registry.sets.find((s: any) => s.id === 'art-director-vs-iterate');

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

// ── Fixtures: realistic enough that every gated block is switched ON ─────────
const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn', hairColor: 'brown' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy', hairColor: 'black' },
];

const VISUAL_BIBLE: any = {
  secondaryCharacters: [],
  animals: [{ id: 'ANI001', name: 'Sprocket', pages: [1], species: 'small winged creature', coloring: 'moss green', features: 'one blunt horn' }],
  artifacts: [{
    id: 'ART001', label: 'brass lantern', name: 'brass lantern', pages: [1], type: 'hand tool',
    description: 'a dented brass lantern with a cracked green glass pane',
    states: [{ id: 'ART001.1', name: 'unaltered', delta: 'whole, glass intact', pages: [1] },
             { id: 'ART001.2', name: 'cracked', delta: 'one pane split end to end', pages: [2, 3] }],
  }],
  locations: [{ id: 'LOC001', label: 'timber pier', name: 'timber pier', pages: [1], setting: 'outdoor', colors: 'salt-bleached grey', features: 'planked walkway', isRealLandmark: false, landmarkQuery: null }],
  vehicles: [],
  clothing: [],
};

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: CHARACTERS,
  mainCharacters: ['c1'],
  language: 'en',
  pages: 4,
  season: 'autumn',
  storyCategory: 'adventure',
  storyType: 'adventure',
  artStyle: 'watercolor',
  visualBible: VISUAL_BIBLE,
  layout: { textInImage: true },
};

const BEATS = [
  { pageNumber: 1, planLine: 'wide — Mira on the pier — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'medium — Mira and Tobias on the pier — he reaches for her sleeve — they turn back' },
];

const PAGE_TEXT = 'The lamp guttered twice and then went out, and nobody said a word.';

const buildAdAll = () => PB.buildSceneExpansionAllPrompt(inputData, BEATS, {});
const buildAdOne = () => PB.buildSceneExpansionPrompt(
  1, PAGE_TEXT, CHARACTERS, 'en', VISUAL_BIBLE, '', null, { story: inputData });
const buildIterate = (freeIterate: boolean) => PB.buildSceneDescriptionPrompt(
  1, PAGE_TEXT, CHARACTERS, '', 'en', VISUAL_BIBLE, [], {}, '', '',
  { planLine: BEATS[0].planLine }, { composition: 'a render', fixIssues: ['the lantern is missing'], previousScore: -20 },
  { freeIterate, textInImage: true, story: inputData });

/**
 * Which exported constant each registry anchor is filled from. Anchors whose
 * value is computed per story (the season, the creature-tone band, the element
 * budget, the shot enum) carry a probe instead — those are checked separately.
 * An anchor that appears in neither table fails the completeness check below,
 * so adding one to the registry cannot silently go unchecked here.
 */
const CONSTANT_FOR: Record<string, string> = {
  '{ONE_INSTANT}': 'ONE_INSTANT_RULE',
  '{GAZE_TARGET}': 'GAZE_TARGET_RULE',
  '{LOOKS_AT_FIELD}': 'LOOKS_AT_FIELD_RULE',
  '{GARMENT_REMOVED}': 'GARMENT_REMOVED_RULE',
  '{WORN_ON_OTHER}': 'WORN_ON_OTHER_RULE',
  '{NEVER_NAME_ABSENT}': 'ABSENT_THING_RULE',
  '{SCENE_INTENT_FIELD}': 'SCENE_INTENT_FIELD_RULE',
  '{CONCEALED_OBJECT}': 'CONCEALED_OBJECT_RULE',
  '{STAGED_PROP}': 'STAGED_PROP_RULE',
  '{CONTACT_VERB}': 'CONTACT_VERB_RULE',
  '{REACHABLE_CONTACT}': 'REACHABLE_CONTACT_RULE',
  '{PLAN_LINE_CAST}': 'PLAN_LINE_CAST_RULE',
  '{COUNTING_RULE}': 'COUNTING_RULE',
  '{MULTI_PICTURE_PROP}': 'MULTI_PICTURE_PROP_RULE',
};
const COMPUTED = new Set(['{CREATURE_TONE}', '{VB_ELEMENT_BUDGET}', '{SHOT_ENUM}', '{SEASON}']);

let BUILT: Array<{ name: string; text: string }> = [];

describe('the four page-brief authoring sites', () => {
  it('builds all four prompts', async () => {
    await loadPromptTemplates();
    BUILT = [
      { name: 'scene-expansion-all.txt (Art Director, all pages)', text: buildAdAll() },
      { name: 'scene-expansion.txt (Art Director, per page)', text: buildAdOne() },
      { name: 'scene-iteration.txt (rewrite, strict)', text: buildIterate(false) },
      { name: 'scene-iteration-free.txt (rewrite, free)', text: buildIterate(true) },
    ];
    for (const b of BUILT) expect(b.text.length, `${b.name} built empty`).toBeGreaterThan(2000);
  });

  it('the registry set names all four, and every anchor is resolvable here', () => {
    expect(SET, 'sibling set art-director-vs-iterate is gone from the registry').toBeTruthy();
    expect(SET.members.slice().sort()).toEqual([
      'prompts/scene-expansion-all.txt',
      'prompts/scene-expansion.txt',
      'prompts/scene-iteration-free.txt',
      'prompts/scene-iteration.txt',
    ]);
    const unresolved = SET.parity.anchors.filter((a: string) => !CONSTANT_FOR[a] && !COMPUTED.has(a));
    expect(unresolved, 'an anchor was added to the registry with no check in this file').toEqual([]);
    for (const [token, name] of Object.entries(CONSTANT_FOR)) {
      expect(SET.parity.anchors, `${token} is checked here but no longer anchored in the registry`).toContain(token);
      expect(typeof PB[name], `promptBuilders no longer exports ${name}`).toBe('string');
      expect(PB[name].length, `${name} is empty`).toBeGreaterThan(40);
    }
  });

  it('every shared rule constant reaches all four BUILT prompts, byte-identically', () => {
    const gaps: string[] = [];
    for (const [token, name] of Object.entries(CONSTANT_FOR)) {
      for (const b of BUILT) {
        if (!b.text.includes(PB[name])) gaps.push(`${b.name} does not carry ${name} (${token})`);
      }
    }
    expect(gaps, 'a rule the first author holds and the rewriter does not is a rule one repair round deletes').toEqual([]);
  });

  it('the computed page facts reach all four BUILT prompts', () => {
    const { SHOT_ENUM } = nodeRequire('../../server/lib/shotVocabulary.js');
    const { VB_ELEMENT_BUDGET } = nodeRequire('../../server/lib/vbElementBudget.js');
    const gaps: string[] = [];
    for (const b of BUILT) {
      if (!b.text.includes(SHOT_ENUM)) gaps.push(`${b.name}: no shot vocabulary`);
      if (!b.text.includes(String(VB_ELEMENT_BUDGET))) gaps.push(`${b.name}: no element budget`);
      if (!/\bAutumn\b/i.test(b.text)) gaps.push(`${b.name}: no season`);
      // The creature-tone band is emitted only when the story has a readable
      // child age; this fixture does, so all four must carry it.
      if (!/drawn cute|not menacing|formidable/i.test(b.text)) gaps.push(`${b.name}: no creature-tone band`);
    }
    expect(gaps).toEqual([]);
  });

  it('no unfilled {PLACEHOLDER} survives in any of the four', () => {
    const gaps = BUILT.filter(b => unfilled(b.text).length > 0)
      .map(b => `${b.name}: ${unfilled(b.text).join(', ')}`);
    expect(gaps, 'fillTemplate strips an unfilled token silently — the rule just vanishes').toEqual([]);
  });
});

// ── The metadata contract: what the first author declares, the rewriter emits ─

/**
 * Top-level page-brief field names a template declares in its JSON example.
 * Read positionally (two-space-indented quoted key) because the examples carry
 * placeholders and HTML comments and are not parseable JSON. Taken over the
 * whole file rather than after the last `---METADATA---`: the iterate templates
 * mention that marker again in their closing instruction line.
 */
function declaredFields(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^ {2}"([A-Za-z][\w-]*)"\s*:/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Fields the first author declares that the rewriter is deliberately NOT asked
 * for, because iteratePageCore carries the page's own value forward instead —
 * "context fields iterate has no business re-deciding" (the merge in
 * `iterateSceneMetadata`). Each is asserted to be genuinely carried there, so
 * this list cannot be used to wave a field through.
 */
const CARRIED_IN_CODE: Record<string, string> = {
  era: 'the anachronism guard reads the story era, not the round',
  crowdExpected: 'a repaired page must not lose its crowd flag and take a derived extra_character',
  aboard: 'the camera-aboard element is the page composition, decided once',
  textPosition: 'locked at first generation; iteratePageCore passes textPositionOverride',
  textZoneDescription: 'the text-zone surface is the page layout, decided once',
};

describe('the rewrite emits the fields the brief it replaces carried', () => {
  const adFields = declaredFields(read('prompts/scene-expansion.txt'));
  const strict = declaredFields(read('prompts/scene-iteration.txt'));
  const free = declaredFields(read('prompts/scene-iteration-free.txt'));

  it('the per-page Art Director still declares the page-brief schema', () => {
    for (const f of ['sceneIntent', 'characters', 'shot', 'landmarkView', 'objects', 'interactions', 'wornItems']) {
      expect(adFields.has(f), `the Art Director no longer declares ${f}`).toBe(true);
    }
  });

  it.each([['scene-iteration.txt', () => strict], ['scene-iteration-free.txt', () => free]])(
    '%s declares every Art Director field except the ones code carries', (_name, getFields) => {
      const have = getFields();
      const missing = [...adFields].filter(f => !have.has(f) && !(f in CARRIED_IN_CODE));
      expect(missing, 'a field the rewrite does not emit is a field the repaired page loses').toEqual([]);
    });

  it('every exempt field really is carried forward in iteratePageCore', () => {
    const src = read('server/lib/images.js');
    const start = src.indexOf('const iterateSceneMetadata = {');
    expect(start, 'the iterate metadata merge is gone — the exemptions below are unbacked').toBeGreaterThan(-1);
    const merge = src.slice(start, src.indexOf('\n  };', start));
    const unbacked = Object.keys(CARRIED_IN_CODE).filter(f => !merge.includes(`${f}:`));
    // textPosition is carried by its own route (textPositionOverride), not the merge.
    expect(unbacked.filter(f => f !== 'textPosition'), 'an exempt field is neither asked for nor carried').toEqual([]);
    expect(src, 'the locked textPosition no longer reaches the image prompt').toContain('textPositionOverride: lockedTextPosition');
  });

  it('the rewrite is asked for the per-character and per-interaction sub-fields too', () => {
    for (const [name, text] of [['strict', read('prompts/scene-iteration.txt')], ['free', read('prompts/scene-iteration-free.txt')]]) {
      for (const sub of ['"depth"', '"looksAt"', '"action"']) {
        expect(text.includes(sub), `${name} iterate never asks for ${sub}`).toBe(true);
      }
      expect(/`hands`/.test(text), `${name} iterate never asks for hands`).toBe(true);
    }
  });
});
