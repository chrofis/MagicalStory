/**
 * GUARD C — every model-facing prompt BUILDER is pinned to the VALUE it carries.
 *
 * Three checks shipped blind on 2026-09-14, all the same shape: a rule that
 * LOOKS present in the template layer but receives nothing at runtime, and
 * fails silently because "no findings" is indistinguishable from "nothing to
 * find".
 *
 *   - the batch eval judge was handed `[]` reference photos (dead since Feb 2026);
 *   - a sheet identification reply was eaten by a greedy regex;
 *   - `evaluateSheetRow`'s heads branch handed the judge the literal string
 *     `{REQUESTED_OUTFIT}` because `fillTemplate` ran on one branch only
 *     (fixed in b15600c49).
 *
 * None had a test asserting the input actually ARRIVED. This file is that
 * assertion, one case per builder. Each case:
 *
 *   1. builds the prompt from realistic inputs carrying a distinctive probe
 *      value (a garment, a place, a page of prose);
 *   2. asserts the probe VALUE is in the built string;
 *   3. asserts no `{PLACEHOLDER}` token survived;
 *   4. asserts the probe is absent when the input is withheld — the negative
 *      control that separates "the value arrived" from "the template's own
 *      boilerplate happens to contain those words".
 *
 * These pin BEHAVIOUR (the value reaching the prompt), never the prompt's
 * wording. A prompt may be reworded freely; it may not stop carrying its input.
 *
 * Offline and free: nothing here calls a paid API. The one builder that can
 * only be reached through a model call (`evaluateSheetRow` — the actual bug
 * site) runs against a stubbed `fetch`.
 */
import { describe, it, beforeAll, expect, vi, afterEach } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, buildEmptyScenePrompt, buildEvaluationPrompt } = require('../../server/services/prompts');
const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
const sheetMod = require('../../server/lib/character2x4Sheet');
// The 2×4 sheet module exposes its builders under `_internal` (it has done so
// since the sheet pipeline was written); `buildStyleTransferPrompt` is the one
// that is also a top-level export.
const sheet = { ...sheetMod, ...sheetMod._internal };

// ---------------------------------------------------------------------------
// Probes — distinctive enough that no template could contain them by accident.
// ---------------------------------------------------------------------------
const GARMENT = 'brown corduroy dungarees with a square bib panel and two shoulder straps';
const COSTUME_NAME = 'lighthouse keeper';
const PLACE = 'the salt-bleached timber pier at Kettlewick';
const PAGE_TEXT = 'The lamp guttered twice and then went out, and nobody said a word.';
const BEFORE_TEXT = 'The lamp guttered and went out.';
const ARC_LINE = 'The keeper must relight the lamp before the tide turns.';
const PLAN_LINE = 'wide — the main character on the pier — she lifts the lantern — the lamp is lit';
const BRIEF_PROSE = `The main character stands on ${PLACE}, lifting a brass lantern above her head.`;
const STYLE = 'Soft watercolour with visible paper grain. Never photographic.';
const ELEMENT_DESC = 'a dented brass lantern with a cracked green glass pane';

const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn', hairColor: 'brown' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy', hairColor: 'black' },
];

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: CHARACTERS,
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  readingLevel: 'beginner',
  pages: 4,
  storyCategory: 'adventure',
  storyType: 'adventure',
  storyTheme: 'Life Skills',
  storyTopic: 'dealing-bully',
  storyDetails: `A night at ${PLACE}.`,
  artStyle: 'watercolor',
  relationships: { 'c1-c2': 'Sister of' },
  relationshipTexts: {},
};

const BEATS = [
  { pageNumber: 1, planLine: PLAN_LINE },
  { pageNumber: 2, planLine: 'close — the main character — she cups the flame — the flame holds' },
];

const PAGES = [
  { pageNumber: 1, text: PAGE_TEXT, sceneBrief: BRIEF_PROSE, planLine: PLAN_LINE },
  { pageNumber: 2, text: 'She cupped the flame with both hands.', sceneBrief: BRIEF_PROSE, planLine: PLAN_LINE },
];

const SCENES = [
  { pageNumber: 1, brief: BRIEF_PROSE },
  { pageNumber: 2, brief: 'The main character kneels beside the lamp housing.' },
];

const VISUAL_BIBLE: any = {
  artifacts: [{ id: 'ART001', name: 'brass lantern', description: ELEMENT_DESC, pages: [1, 2] }],
  locations: [],
  vehicles: [],
  characters: [],
};

const brief = (prose: string) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'the lamp is lit',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide',
    objects: ['ART001'],
    textPosition: 'bottom-left',
  })}`;

const CLOTHING_REQS: any = {
  Mira: { standard: { used: true, description: GARMENT, costume: COSTUME_NAME } },
};

// ---------------------------------------------------------------------------
// The inventory. `build` receives the probe VALUE; `blind` builds the same
// prompt with that input withheld, and is the negative control.
// ---------------------------------------------------------------------------
type Case = {
  name: string;
  probe: string;
  build: () => string;
  blind?: () => string;
};

const CASES: Case[] = [
  {
    name: 'buildImagePrompt (page illustration)',
    probe: PLACE,
    build: () => PB.buildImagePrompt(brief(BRIEF_PROSE), inputData, null, VISUAL_BIBLE, 1, null, {}),
    blind: () => PB.buildImagePrompt(brief('The main character stands in an empty room.'), inputData, null, VISUAL_BIBLE, 1, null, {}),
  },
  {
    name: 'buildCoverPrompt (front cover)',
    probe: PLACE,
    build: () => PB.buildCoverPrompt('front', {
      sceneDescription: BRIEF_PROSE, inputData, characters: [{ name: 'Mira' }],
    }),
    blind: () => PB.buildCoverPrompt('front', {
      sceneDescription: 'The main character stands in an empty room.', inputData, characters: [{ name: 'Mira' }],
    }),
  },
  {
    name: 'buildEmptyScenePrompt (background plate)',
    probe: PLACE,
    build: () => buildEmptyScenePrompt({ style: STYLE, description: BRIEF_PROSE, visualBible: VISUAL_BIBLE, pageNumber: 1 }),
    blind: () => buildEmptyScenePrompt({ style: STYLE, description: 'An empty room.', visualBible: VISUAL_BIBLE, pageNumber: 1 }),
  },
  {
    name: 'buildEvaluationPrompt (quality eval) — the clothing contract',
    probe: GARMENT,
    build: () => buildEvaluationPrompt({ originalPrompt: BRIEF_PROSE, clothingContract: `Mira: ${GARMENT}`, artStyle: STYLE }),
    blind: () => buildEvaluationPrompt({ originalPrompt: BRIEF_PROSE, artStyle: STYLE }),
  },
  {
    name: 'buildReferenceSheetPrompt (Visual Bible element sheet)',
    probe: ELEMENT_DESC,
    build: () => buildReferenceSheetPrompt([{ id: 'ART001', name: 'brass lantern', type: 'object', description: ELEMENT_DESC }], STYLE, VISUAL_BIBLE),
    blind: () => buildReferenceSheetPrompt([{ id: 'ART001', name: 'brass lantern', type: 'object', description: 'a plain wooden crate' }], STYLE, VISUAL_BIBLE),
  },
  {
    name: 'buildSceneExpansionPrompt (Art Director, one page)',
    probe: PAGE_TEXT,
    build: () => PB.buildSceneExpansionPrompt(1, PAGE_TEXT, CHARACTERS, 'en', VISUAL_BIBLE, '', null, {}),
    blind: () => PB.buildSceneExpansionPrompt(1, 'She walked home.', CHARACTERS, 'en', VISUAL_BIBLE, '', null, {}),
  },
  {
    name: 'buildSceneExpansionAllPrompt (Art Director, all pages)',
    probe: PLAN_LINE,
    build: () => PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}),
    blind: () => PB.buildSceneExpansionAllPrompt(inputData, [{ pageNumber: 1, planLine: 'close — she walks home' }], {}),
  },
  {
    name: 'buildSceneReviewPrompt (all briefs at once)',
    probe: BRIEF_PROSE,
    build: () => PB.buildSceneReviewPrompt(inputData, SCENES, { beats: BEATS, visualBible: VISUAL_BIBLE }),
    blind: () => PB.buildSceneReviewPrompt(inputData, [{ pageNumber: 1, brief: 'An empty room.' }], { beats: BEATS, visualBible: VISUAL_BIBLE }),
  },
  {
    name: 'buildBeatsPrompt (page planner)',
    probe: ARC_LINE,
    build: () => PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC_LINE }),
    blind: () => PB.buildBeatsPrompt(inputData, 4, {}),
  },
  {
    name: 'buildPlanCheckPrompt (the beats layer’s only model check)',
    probe: PLAN_LINE,
    build: () => PB.buildPlanCheckPrompt(inputData, BEATS, ARC_LINE, '', ''),
    blind: () => PB.buildPlanCheckPrompt(inputData, [{ pageNumber: 1, planLine: 'close — she walks home' }], ARC_LINE, '', ''),
  },
  {
    name: 'buildArcCreatePrompt (the arc machine)',
    probe: PLACE,
    build: () => PB.buildArcCreatePrompt(inputData, 4),
    blind: () => PB.buildArcCreatePrompt({ ...inputData, storyDetails: 'A quiet afternoon.' }, 4),
  },
  {
    name: 'buildArcRetellPrompt (re-tell, never patch)',
    probe: ARC_LINE,
    build: () => PB.buildArcRetellPrompt(inputData, 4, ARC_LINE, 'Panelist A: relight it from the stove.'),
    blind: () => PB.buildArcRetellPrompt(inputData, 4, 'Something else happens.', 'Panelist A: relight it from the stove.'),
  },
  {
    name: 'buildStoryTextFromBeatsPrompt (page text writer)',
    probe: PLAN_LINE,
    build: () => PB.buildStoryTextFromBeatsPrompt(inputData, BEATS, [], ARC_LINE, { arcHints: '' }),
    blind: () => PB.buildStoryTextFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: 'close — she walks home' }], [], ARC_LINE, { arcHints: '' }),
  },
  {
    name: 'buildStoryBibleFromBeatsPrompt (visual contract)',
    probe: PLAN_LINE,
    build: () => PB.buildStoryBibleFromBeatsPrompt(inputData, BEATS),
    blind: () => PB.buildStoryBibleFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: 'close — she walks home' }]),
  },
  {
    name: 'buildClothingReviewPrompt (wardrobe review) — the garment itself',
    probe: GARMENT,
    build: () => PB.buildClothingReviewPrompt(inputData, CLOTHING_REQS, BEATS),
    blind: () => PB.buildClothingReviewPrompt(inputData, {
      Mira: { standard: { used: true, description: 'a plain grey smock', costume: COSTUME_NAME } },
    }, BEATS),
  },
  {
    name: 'buildTextProofreadPrompt (the lector)',
    probe: PAGE_TEXT,
    build: () => PB.buildTextProofreadPrompt(inputData, PAGES),
    blind: () => PB.buildTextProofreadPrompt(inputData, [{ pageNumber: 1, text: 'She walked home.' }]),
  },
  {
    name: 'buildTextDiffPrompt (post-repair diff pass)',
    probe: BEFORE_TEXT,
    build: () => PB.buildTextDiffPrompt(inputData, [{ pageNumber: 1, before: BEFORE_TEXT, after: PAGE_TEXT }]),
    blind: () => PB.buildTextDiffPrompt(inputData, [{ pageNumber: 1, before: 'She walked home.', after: PAGE_TEXT }]),
  },
  {
    name: 'buildTextAuditPrompt (arc-informed audit)',
    probe: PAGE_TEXT,
    build: () => PB.buildTextAuditPrompt(inputData, PAGES, ARC_LINE),
    blind: () => PB.buildTextAuditPrompt(inputData, [{ pageNumber: 1, text: 'She walked home.', sceneBrief: BRIEF_PROSE }], ARC_LINE),
  },
  {
    name: 'buildTextAuditBlindPrompt (a fresh adult, nothing else)',
    probe: PAGE_TEXT,
    build: () => PB.buildTextAuditBlindPrompt(inputData, PAGES),
    blind: () => PB.buildTextAuditBlindPrompt(inputData, [{ pageNumber: 1, text: 'She walked home.' }]),
  },
  {
    name: 'buildOutlineReviewPrompt (split outline review)',
    probe: PAGE_TEXT,
    build: () => PB.buildOutlineReviewPrompt(inputData, `---STORY TEXT---\nPage 1: ${PAGE_TEXT}`, [], {}),
    blind: () => PB.buildOutlineReviewPrompt(inputData, '---STORY TEXT---\nPage 1: She walked home.', [], {}),
  },
  {
    name: 'buildTextRefinePrompt (iterative refinement)',
    probe: PAGE_TEXT,
    build: () => PB.buildTextRefinePrompt(inputData, PAGES, 'FAULT: the lamp is never lit', ARC_LINE),
    blind: () => PB.buildTextRefinePrompt(inputData, [{ pageNumber: 1, text: 'She walked home.', sceneBrief: BRIEF_PROSE }], 'FAULT: the lamp is never lit', ARC_LINE),
  },
  {
    name: 'buildUnifiedStoryPrompt (unified writer)',
    probe: PLACE,
    build: () => PB.buildUnifiedStoryPrompt(inputData, 4),
    blind: () => PB.buildUnifiedStoryPrompt({ ...inputData, storyDetails: 'A quiet afternoon.' }, 4),
  },
  {
    name: 'buildTrialStoryPrompt (trial writer)',
    probe: PLACE,
    build: () => PB.buildTrialStoryPrompt(inputData, 4),
    blind: () => PB.buildTrialStoryPrompt({ ...inputData, storyDetails: 'A quiet afternoon.' }, 4),
  },
  {
    name: 'buildBodyRowPrompt (2×4 sheet, body row) — the garment',
    probe: GARMENT,
    build: () => sheet.buildBodyRowPrompt(GARMENT, CHARACTERS[0], false, COSTUME_NAME, null),
    blind: () => sheet.buildBodyRowPrompt('a plain grey smock', CHARACTERS[0], false, COSTUME_NAME, null),
  },
  {
    name: 'buildHeadRowPrompt (2×4 sheet, head row) — the garment',
    probe: GARMENT,
    build: () => sheet.buildHeadRowPrompt(CHARACTERS[0], GARMENT),
    blind: () => sheet.buildHeadRowPrompt(CHARACTERS[0], ''),
  },
  {
    name: 'buildStyleTransferPrompt (2×4 sheet, pass 2) — the commissioned style',
    // A distinctive clause of the resolved ART_STYLES descriptor — the style
    // KEY must be resolved into its medium, not passed through as an id.
    probe: 'pigment pooling and granulating',
    build: () => sheet.buildStyleTransferPrompt('watercolor', { hasAnchor: true }),
    blind: () => sheet.buildStyleTransferPrompt('pixar', { hasAnchor: true }),
  },
];

describe('every model-facing prompt builder carries its input VALUE', () => {
  beforeAll(async () => {
    await loadPromptTemplates();
  });

  it.each(CASES.map((c) => [c.name, c] as [string, Case]))(
    '%s',
    (_name, c) => {
      const built = c.build();
      // The builder produced something at all — a null here means the template
      // failed to load, which is itself the blind-check failure mode.
      expect(typeof built, 'builder returned no prompt').toBe('string');
      expect(String(built).length).toBeGreaterThan(50);

      // (2) the substantive VALUE arrived.
      expect(String(built), 'the input value never reached the prompt').toContain(c.probe);

      // (3) no placeholder token survived — the {REQUESTED_OUTFIT} failure.
      expect(unfilled(String(built))).toEqual([]);

      // (4) not boilerplate: withhold the input and the probe must vanish.
      if (c.blind) {
        expect(String(c.blind()), 'the probe is template boilerplate, not the input')
          .not.toContain(c.probe);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The actual 2026-09-14 bug site. `evaluateSheetRow` fills its template inside
// the model call, so the only honest test drives the call with a stubbed
// `fetch` and reads back the `promptUsed` it reports. No network, no cost.
// ---------------------------------------------------------------------------
describe('evaluateSheetRow hands the judge the real outfit, not the token', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  const stubJudge = () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"finalScore":10}' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      text: async () => '',
    })) as any;
  };

  // A 1x1 JPEG is enough — nothing decodes it on this path.
  const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';

  beforeAll(async () => { await loadPromptTemplates(); });

  it.each(['heads', 'bodies'])('%s row: the garment text reaches the judge', async (which) => {
    stubJudge();
    const { promptUsed } = await sheet.evaluateSheetRow(ROW, which, {
      costumeDescription: GARMENT,
      costumeName: COSTUME_NAME,
    });
    expect(promptUsed).toContain(GARMENT);
    expect(unfilled(promptUsed)).toEqual([]);
  });

  it.each(['heads', 'bodies'])('%s row: with no costume, the garment is genuinely absent', async (which) => {
    stubJudge();
    const { promptUsed } = await sheet.evaluateSheetRow(ROW, which, {});
    expect(promptUsed).not.toContain(GARMENT);
    expect(unfilled(promptUsed)).toEqual([]);
  });

  // Two sheet judges fill BARE-WORD tokens (`CHARACTER_AGE`) with a plain
  // `.replace(/WORD/g, …)` instead of a braced placeholder, so neither
  // fillTemplate's warn-then-strip nor the boundary guard's `{TOKEN}` regex can
  // see an unfilled one — the literal word would ship to the judge. Pinned
  // here by VALUE: the declared age arrives, and the token name does not.
  it('the identity judge is told the declared age, not the token name', async () => {
    stubJudge();
    const { promptUsed } = await sheet.evaluateIdentity(ROW, { declaredAge: 8 });
    expect(promptUsed).toContain('8 years old');
    expect(promptUsed).not.toContain('CHARACTER_AGE');
    expect(unfilled(promptUsed)).toEqual([]);
  });

  it('…and says "unknown" rather than leaving the token when no age is declared', async () => {
    stubJudge();
    const { promptUsed } = await sheet.evaluateIdentity(ROW, {});
    expect(promptUsed).not.toContain('CHARACTER_AGE');
    expect(promptUsed).not.toContain('8 years old');
  });
});
