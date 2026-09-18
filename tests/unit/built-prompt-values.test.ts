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
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEmptyScenePrompt, buildEvaluationPrompt } = require('../../server/services/prompts');
const { buildReferenceSheetPrompt } = require('../../server/lib/referenceSheets');
const { buildSemanticPrompt } = require('../../server/lib/sceneValidator');
const { buildLandmarkContextBlock } = require('../../server/lib/landmarkProtection');
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
// The landmark block, from the ONE builder all three judges are filled from.
const LANDMARK_NAME = 'Lindenhof plaza with linden trees';
const LANDMARK_BLOCK = buildLandmarkContextBlock({
  protect: true, landmarkPresent: true, names: [LANDMARK_NAME],
});
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
    // THE LANDMARK BLOCK reaches all three judges from ONE builder
    // (landmarkProtection.buildLandmarkContextBlock). The semantic judge went
    // without it for two weeks and produced the one landmark removal that
    // reached production; the placeholder is filled in a different file for
    // each judge, so each fill site is pinned separately.
    name: 'buildEvaluationPrompt (quality eval) — the landmark block',
    probe: LANDMARK_NAME,
    build: () => buildEvaluationPrompt({ originalPrompt: BRIEF_PROSE, artStyle: STYLE, landmarkContext: LANDMARK_BLOCK }),
    blind: () => buildEvaluationPrompt({ originalPrompt: BRIEF_PROSE, artStyle: STYLE }),
  },
  {
    name: 'buildSemanticPrompt (semantic judge) — the landmark block',
    probe: LANDMARK_NAME,
    build: () => buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: PAGE_TEXT, sceneHint: BRIEF_PROSE, imagePrompt: BRIEF_PROSE,
      evalContext: { landmarkContext: LANDMARK_BLOCK },
    }),
    blind: () => buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
      storyText: PAGE_TEXT, sceneHint: BRIEF_PROSE, imagePrompt: BRIEF_PROSE,
    }),
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

// ---------------------------------------------------------------------------
// The Art Director's size-ratio requirement (backlog #77).
//
// Measured across three finished stories, the AD emitted ONE ratio clause in
// 18 pages, ONE in 19, and NONE in 18 — the rule read as a condition the model
// could decide did not apply. The rule was made unconditional. What must hold
// from here on is the BEHAVIOUR, not the sentence:
//
//   - both Art Director prompts (all-pages and the per-page fallback) reach
//     the model still demanding a ratio;
//   - the two share the requirement verbatim, so a future edit to one cannot
//     silently leave the other behind — the two files share their PAGE rule
//     set by design;
//   - no prompt-shrink path sits between the builder and the model on the
//     beats route, so the rule's position in the prompt cannot cost it its
//     life (shrinkPromptForModel is an IMAGE-prompt path only).
// ---------------------------------------------------------------------------
describe('the Art Director is told to name a size ratio', () => {
  const ruleOf = (prompt: string) =>
    (String(prompt).split('\n').find((l) => l.startsWith('8f.')) || '');

  it('both Art Director prompts carry the rule, worded identically', () => {
    const all = ruleOf(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}));
    const one = ruleOf(PB.buildSceneExpansionPrompt(1, PAGE_TEXT, CHARACTERS, 'en', VISUAL_BIBLE, '', null, {}));
    expect(all.length, 'the all-pages Art Director prompt lost rule 8f').toBeGreaterThan(50);
    expect(one, 'the per-page Art Director fallback drifted from the all-pages rule set').toBe(all);
  });

  it('the rule demands a ratio unconditionally', () => {
    const rule = ruleOf(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}));
    // A ratio is asked for...
    expect(rule).toMatch(/\bratio\b/);
    // ...and not behind a condition the model can rule out. The only carve-out
    // that may remain is the page where the element is alone.
    expect(rule).not.toMatch(/When such an element shares the frame/);
    expect(rule).toMatch(/alone/);
  });

  it('nothing shrinks the Art Director prompt on the beats route', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    expect(src, 'a shrink path appeared between the AD builder and the model')
      .not.toMatch(/shrinkPromptForModel|truncatePromptForModel/);
  });
});

// ---------------------------------------------------------------------------
// The re-plan asks for the NAMED pages only (owner decision, 2026-09-14).
//
// The RE-DIVIDE block used to contradict itself in one breath — "Return ONLY
// the pages a finding names ... and nothing else" next to "Output the full plan
// again" — and the template's OUTPUT FORMAT broke the tie the wrong way ("One
// line per page, through page N"). Two of three signals demanded the whole
// book, and that is what the planner delivered: 8 and 9 unnamed pages rewritten
// in consecutive rounds. What is pinned here is the CONTRACT, not the wording:
// a re-plan build asks for the named pages and carries no full-plan demand; a
// first-plan build still demands every page through the page count.
// ---------------------------------------------------------------------------
describe('the re-plan asks for only the pages a finding named', () => {
  const FINDINGS = [{ check: 9, line: 'Page 3 holds two actions.', pages: [3] }];
  const PLAN = 'Page 1: wide — the main character — she sets out — she is on the road\nPage 3: close — the main character — she opens the box and runs — the box is open';
  const replanSection = () => PB.buildReplanSection(PLAN, FINDINGS);
  const replanPrompt = () => PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC_LINE, replan: replanSection() });
  const firstPrompt = () => PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC_LINE });

  it('the RE-DIVIDE block still demands the named pages and nothing else', () => {
    const block = replanSection();
    expect(block).toMatch(/ONLY the pages a finding names/);
    expect(block, 'the full-plan demand is back — it contradicts the named-pages contract')
      .not.toMatch(/full plan/i);
  });

  it('must-fix precedence and the one-action/merge paragraph survive', () => {
    const block = replanSection();
    expect(block).toMatch(/must-fix wins/);
    expect(block).toMatch(/more than one action/);
    expect(block).toMatch(/Keep the page count by merging/);
  });

  it('a re-plan build does not demand every page through the page count', () => {
    const p = replanPrompt();
    expect(p).toMatch(/RE-DIVIDE/);
    expect(p, 'the template still orders a whole-book reply on a re-plan')
      .not.toMatch(/One line per page, through page/);
    expect(p).toMatch(/named under RE-DIVIDE/);
    expect(unfilled(p)).toEqual([]);
  });

  it('a first plan still demands every page through the page count', () => {
    const p = firstPrompt();
    expect(p).toMatch(/One line per page, through page 4\./);
    expect(p).not.toMatch(/named under RE-DIVIDE/);
    expect(unfilled(p)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// An object's OWN light is a state (owner verdict, 2026-09-14 — backlog #37).
//
// The same object got opposite treatment depending on which template authored
// the bible: the beats Art Director called its own emission a state, while
// `story-trial.txt` said a change of light never is.
// A state is drawn as its own reference cell, and a reference cell is the only
// way a glowing look actually reaches the page — an emission carried only in
// `description` is on every page or none. Story B
// `job_1789343124794_z2c779f7i` ART003 held the glow in `description` with no
// state for it, part of the chain that rendered the wrong object on three
// pages (backlog #63).
//
// Both halves are pinned, in SUBSTANCE not wording: the world lighting the
// object stays NOT a state, its own emission IS one, and the emission belongs
// in `states[]`. A fourth template stating the rule differently is the way
// this recurs, so the guard runs over every template that states it.
// ---------------------------------------------------------------------------
describe('the light rule agrees across every template that states it', () => {
  const fs = require('fs');
  const path = require('path');
  const PROMPTS = path.join(__dirname, '../../prompts');
  // story-unified.txt was a member until 2026-09-15 (deleted as unreachable).
  const FILES = ['scene-expansion-all.txt', 'story-trial.txt'];

  const lightLine = (file: string) =>
    fs.readFileSync(path.join(PROMPTS, file), 'utf8')
      .split('\n')
      .find((l: string) => /is not a state/i.test(l) && /light/i.test(l)) || '';

  for (const file of FILES) {
    it(`${file} keeps the world's lighting out of states and its own emission in`, () => {
      const line = lightLine(file);
      expect(line, `${file} no longer states the light rule at all`).not.toBe('');
      // The half that was always right: the scene decides the world's light.
      expect(line, `${file} stopped excluding the world's lighting`)
        .toMatch(/world lights it is not a state/i);
      expect(line, `${file} no longer hands the world's light to the scene`)
        .toMatch(/scene decides/i);
      // The half the owner settled: the object's own emission IS a state...
      expect(line, `${file} reverted to "a change of light is not a state"`)
        .toMatch(/own light is a state/i);
      // ...and it lives in the states, not in `description`.
      expect(line, `${file} no longer sends the emission to states[]`)
        .toMatch(/states(\[\])?`?[^.]*never in `description`|emission/i);
    });
  }

  it('no template still says a change of light is never a state', () => {
    const offenders = fs.readdirSync(PROMPTS)
      .filter((f: string) => f.endsWith('.txt'))
      .filter((f: string) => /change of light is not a state/i.test(
        fs.readFileSync(path.join(PROMPTS, f), 'utf8')));
    expect(offenders, 'a template still carries the reversed light rule').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Object counts: exact up to THREE, "more than three" above (owner, 2026-09-15:
// "For the count increase limit to three. Judge also just gets more than three
// no exact nr.").
//
// The generator-side limit used to be TWO while the judge scored a wrong count
// as MAJOR — accuracy checked on a number the Art Director was never allowed to
// write. What is pinned here is the CONTRACT, not the wording: both Art
// Director templates carry the SAME counting rule string (one constant), the
// rule permits three and refuses an exact number above it, the illustrator is
// told the same in the protected tail, and the judge holds no exact expectation
// above three.
// ---------------------------------------------------------------------------
describe('object counts are exact up to three and non-numeric above', () => {
  const fs = require('fs');
  const path = require('path');
  const PROMPTS = path.join(__dirname, '../../prompts');
  const countingLineOf = (prompt: string) =>
    (String(prompt).split('\n').find((l) => l.startsWith('Counting rule:')) || '');

  it('both Art Director prompts carry the rule from ONE constant', () => {
    const all = countingLineOf(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}));
    const one = countingLineOf(
      PB.buildSceneExpansionPrompt(1, PAGE_TEXT, CHARACTERS, 'en', VISUAL_BIBLE, '', null, {}));
    expect(all, 'the all-pages Art Director prompt lost the counting rule').toBe(PB.COUNTING_RULE);
    expect(one, 'the per-page Art Director fallback drifted from the all-pages counting rule').toBe(all);
  });

  it('the rule allows three and refuses an exact number above it', () => {
    const rule = countingLineOf(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}));
    expect(rule).toMatch(/only up to three/i);
    expect(rule).toMatch(/more than three/i);
    expect(rule, 'the old limit of two is back').not.toMatch(/above two/i);
  });

  it('the illustrator is told the same limit, in the protected tail', () => {
    const tpl = fs.readFileSync(path.join(PROMPTS, 'image-generation.txt'), 'utf8');
    const idx = tpl.indexOf('**REQUIRED OBJECTS');
    const counts = tpl.indexOf('**COUNTS:**');
    expect(counts, 'the illustrator carries no counting rule').toBeGreaterThan(-1);
    expect(counts, 'the counting rule sits ahead of the protected tail').toBeGreaterThan(idx);
    expect(tpl.slice(counts, counts + 400)).toMatch(/three or fewer/i);
    expect(tpl.slice(counts, counts + 400)).toMatch(/more than three/i);
  });

  it('the judge checks no exact number above three', () => {
    const tpl = fs.readFileSync(path.join(PROMPTS, 'image-evaluation.txt'), 'utf8');
    const rule = tpl.split('\n').find((l: string) => l.startsWith('**D-22 `object_count`')) || '';
    expect(rule, 'D-22 is gone').not.toBe('');
    expect(rule).toMatch(/three or fewer/i);
    expect(rule).toMatch(/no exact expectation/i);
  });
});

// ---------------------------------------------------------------------------
// OBJECT ID STABILITY (2026-09-16). An iterate round answered an evaluator
// complaint about an object's COLOUR by citing a different Visual Bible id --
// the creature that object becomes later in the story -- and staged the
// transformation pages early (staging job_1789506283204_3kxqshifx p16).
// The rule is one JS constant reaching BOTH iterate templates through one
// placeholder; what is pinned is arrival and sameness, never wording.
// ---------------------------------------------------------------------------
describe('both iterate templates carry the object-id rule from ONE constant', () => {
  const iterate = (freeIterate: boolean) => PB.buildSceneDescriptionPrompt(
    1, PAGE_TEXT, CHARACTERS, '', 'en', VISUAL_BIBLE, [], {}, '', '', null, null, { freeIterate });

  it('the strict template receives the constant', () => {
    expect(iterate(false)).toContain(PB.OBJECT_ID_STABILITY_RULE);
  });

  it('the free template receives the same constant', () => {
    expect(iterate(true)).toContain(PB.OBJECT_ID_STABILITY_RULE);
  });

  it('no placeholder token survives in either', () => {
    expect(iterate(false)).not.toContain('{OBJECT_ID_STABILITY}');
    expect(iterate(true)).not.toContain('{OBJECT_ID_STABILITY}');
  });

  it('the rule names a state complaint and forbids a different id', () => {
    expect(PB.OBJECT_ID_STABILITY_RULE).toMatch(/STATE complaint/);
    expect(PB.OBJECT_ID_STABILITY_RULE).toMatch(/never a different id/i);
  });
});

// ---------------------------------------------------------------------------
// One proper name, one id. ART001.properName and ANI003.name were both "Lindi"
// on the job above -- the same name across a transformation boundary, which is
// what let the rewriter treat the two entries as interchangeable. Both LIVE
// Visual Bible authoring sites must state it (sibling set `vb-authoring-sites`).
// ---------------------------------------------------------------------------
describe('both Visual Bible authoring templates forbid a shared proper name', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const DIR = path2.join(__dirname, '../../prompts');
  const properNameLine = (file: string) =>
    (fs2.readFileSync(path2.join(DIR, file), 'utf8').split(String.fromCharCode(10))
      .map((l: string) => l.trim())
      .find((l: string) => l.includes('`properName`') && l.includes('nowhere else')) || '');

  it('the all-pages Art Director states it', () => {
    expect(properNameLine('scene-expansion-all.txt')).toMatch(/never share a name/i);
  });

  it('the trial writer states it identically', () => {
    expect(properNameLine('story-trial.txt')).toBe(properNameLine('scene-expansion-all.txt'));
  });

  it('the rule names the transformation case without naming a story', () => {
    const line = properNameLine('scene-expansion-all.txt');
    expect(line).toMatch(/transforms later/i);
    expect(line).toMatch(/separate ids/i);
  });
});
