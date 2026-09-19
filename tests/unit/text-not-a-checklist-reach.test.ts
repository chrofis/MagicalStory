/**
 * THE PAGE TEXT IS NOT A CHECKLIST FOR THE PICTURE — reaching all eight sites.
 *
 * Owner directive, 2026-09-18: "Not all characters mentioned in text must
 * appear in the image. Add that rule everywhere! A text can be 3 actions the
 * image must focus on one. You keep getting this wrong."
 *
 * It is ONE exported constant (promptBuilders.TEXT_NOT_A_CHECKLIST_RULE) filled
 * into eight templates from four files — five templates through four builders in
 * promptBuilders.js (buildSceneDescriptionPrompt serves both scene-iteration
 * templates) and one each in evalPipeline.js, sceneValidator.js and bookAudit.js.
 * Hand-kept copies of a shared rule drifted four times in one week in this repo,
 * and this rule already HAD three partial copies that had drifted: two of them
 * covered characters and never actions.
 *
 * WHAT IS PINNED — the constant reaches the BUILT prompt of every one of the
 * eight consumers, byte-identically, with no unfilled placeholder left behind.
 * fillTemplate deletes an undeclared key silently, so a template that "has the
 * rule" can still ship with a hole where it was. Nothing here asserts what the
 * rule SAYS beyond the two halves being structurally present and distinct:
 * wording is the owner's to change without breaking a test.
 *
 * AND THE NINTH, PINNED ABSENT. image-evaluation.txt carried the rule as N-17
 * for one commit (587d8d755) and the owner dropped it the same day: that judge
 * is handed no page text on any path — all three sites that build its prompt
 * pass a BRIEF as ORIGINAL_PROMPT, and `storyText` is a separate argument of
 * evaluateImageQuality that only the semantic and compliance judges receive —
 * so the rule could never fire, and an unreachable line still competes for
 * attention in the heaviest-deducting prompt in the system. The last describe
 * block below keeps it out: template, built prompt, builder contract and
 * sibling set. Re-add it only together with a call site that passes page text.
 *
 * Every judge prompt is captured from the REAL call path with only the network
 * boundary stubbed — never re-filled from the template with a hand-copied key
 * map, which would prove the test's own map and not the call site's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');

const PB = require_('../../server/lib/promptBuilders.js');
const { TEXT_NOT_A_CHECKLIST_RULE: RULE } = PB;
const { loadPromptTemplates, buildEvaluationPrompt, PROMPT_TEMPLATES } = require_('../../server/services/prompts.js');
const { buildSemanticPrompt } = require_('../../server/lib/sceneValidator.js');
const { evaluateThreeStage, buildExpectedCastBlock } = require_('../../server/lib/evalPipeline.js');
const { auditStoryBook } = require_('../../server/lib/bookAudit.js');
const textModels = require_('../../server/lib/textModels.js');

const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/admin/sibling-registry.json'), 'utf8')
);
const SET = registry.sets.find((s: any) => s.id === 'text-not-a-checklist');

const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

// ── Fixtures ────────────────────────────────────────────────────────────────
// The page text deliberately names THREE actions and a character who is not in
// the brief — the exact shape the rule exists for.
const PAGE_TEXT =
  'Mira lifted the lantern, called out to Tobias, and started back along the planks. '
  + 'Far behind them, the harbour master was still counting his ropes.';

const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn', hairColor: 'brown' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy', hairColor: 'black' },
];

const VISUAL_BIBLE: any = {
  secondaryCharacters: [],
  animals: [],
  artifacts: [{
    id: 'ART001', label: 'brass lantern', name: 'brass lantern', pages: [1], type: 'hand tool',
    description: 'a dented brass lantern with a cracked green glass pane',
  }],
  locations: [{
    id: 'LOC001', label: 'timber pier', name: 'timber pier', pages: [1], setting: 'outdoor',
    colors: 'salt-bleached grey', features: 'planked walkway', isRealLandmark: false, landmarkQuery: null,
  }],
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

const BRIEF = `The main character kneels on the planks beside the lantern.

---METADATA---
${JSON.stringify({
  sceneIntent: 'she lifts the lantern on the pier',
  characters: [{ name: 'Mira', position: 'on the pier', depth: 'midground', looksAt: 'ART001', expression: 'eyes wide, mouth set' }],
  shot: 'wide',
  objects: ['ART001', 'LOC001'],
  interactions: [{ character: 'Mira', object: 'ART001', where: 'both hands around the handle' }],
  textPosition: 'top-full',
})}`;

// The compliance judge is driven with the REAL stored page shape.
const complianceFixture = require_('./fixtures/animal-cast-job_1789348171785_9oxos7dwv.json');
const CP = complianceFixture.pages.find((p: any) => p.pageNumber === 7);

const BUILT: Array<{ name: string; template: string; text: string }> = [];

// ── Build every one of the nine, once ───────────────────────────────────────

/** The compliance judge's prompt, captured at the model boundary. */
async function buildCompliancePrompt(): Promise<string> {
  const original = textModels.callTextModel;
  let captured = '';
  textModels.callTextModel = async (input: string) => {
    captured = input;
    return { text: '{"verdict":"PASS","fixable_issues":[]}', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  try {
    await evaluateThreeStage('data:image/jpeg;base64,AAAA', CP.prompt, CP.prompt, {
      pageContext: 'PAGE 7',
      storyText: PAGE_TEXT,
      inventoryPromise: Promise.resolve({
        figures: [], objects: [], interactions: [], setting: null,
        lettering: [], rendering: {}, inputTokens: 0, outputTokens: 0,
      }),
      qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
      visualBible: complianceFixture.visualBible,
      expectedCast: buildExpectedCastBlock({
        sceneCharacters: CP.sceneCharacters,
        sceneMetadata: CP.sceneMetadata,
        sceneHint: CP.prompt,
        originalPrompt: CP.prompt,
        visualBible: complianceFixture.visualBible,
        pageNumber: 7,
      }).block,
    });
  } finally {
    textModels.callTextModel = original;
  }
  return captured;
}

/** The book audit's prompt, captured from the request body it actually sends. */
async function buildBookAuditPrompt(): Promise<string> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  let captured = '';
  process.env.GEMINI_API_KEY = originalKey || 'test-key';
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    captured = String(body?.contents?.[0]?.parts?.[0]?.text || '');
    return {
      ok: true,
      json: async () => ({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'FAULTS: 0' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    };
  }) as any;
  try {
    await auditStoryBook(
      { id: 'test-story', sceneImages: [{ pageNumber: 1, text: PAGE_TEXT }] },
      { imageLoader: async () => 'data:image/jpeg;base64,AAAA' }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
  return captured;
}

beforeAll(async () => {
  await loadPromptTemplates();

  BUILT.push(
    // The two judges that are handed the page text. (The quality judge is not —
    // see the pinned-absent block at the bottom of this file.)
    {
      name: 'image-semantic.txt (semantic judge)',
      template: 'prompts/image-semantic.txt',
      text: String(buildSemanticPrompt(PROMPT_TEMPLATES.imageSemantic, {
        storyText: PAGE_TEXT,
        sceneHint: BRIEF,
        imagePrompt: BRIEF,
        interactionsBlock: 'Mira — brass lantern — both hands around the handle',
        elementsBlock: 'ART001 — brass lantern',
        evalContext: { artStyle: 'watercolor', expectedCast: 'EXPECTED CAST (1): Mira' },
      })),
    },
    {
      name: 'image-prompt-compliance.txt (compliance judge)',
      template: 'prompts/image-prompt-compliance.txt',
      text: await buildCompliancePrompt(),
    },
    // The four brief authors.
    {
      name: 'scene-expansion-all.txt (Art Director, all pages)',
      template: 'prompts/scene-expansion-all.txt',
      text: String(PB.buildSceneExpansionAllPrompt(inputData, BEATS, {})),
    },
    {
      name: 'scene-expansion.txt (Art Director, per page)',
      template: 'prompts/scene-expansion.txt',
      text: String(PB.buildSceneExpansionPrompt(
        1, PAGE_TEXT, CHARACTERS, 'en', VISUAL_BIBLE, '', null, { story: inputData })),
    },
    {
      name: 'scene-iteration.txt (rewrite, strict)',
      template: 'prompts/scene-iteration.txt',
      text: String(PB.buildSceneDescriptionPrompt(
        1, PAGE_TEXT, CHARACTERS, '', 'en', VISUAL_BIBLE, [], {}, '', '',
        { planLine: BEATS[0].planLine },
        { composition: 'a render', fixIssues: ['the lantern is missing'], previousScore: -20 },
        { freeIterate: false, textInImage: true, story: inputData })),
    },
    {
      name: 'scene-iteration-free.txt (rewrite, free)',
      template: 'prompts/scene-iteration-free.txt',
      text: String(PB.buildSceneDescriptionPrompt(
        1, PAGE_TEXT, CHARACTERS, '', 'en', VISUAL_BIBLE, [], {}, '', '',
        { planLine: BEATS[0].planLine },
        { composition: 'a render', fixIssues: ['the lantern is missing'], previousScore: -20 },
        { freeIterate: true, textInImage: true, story: inputData })),
    },
    // The cross-page brief reviewer and the finished-book audit.
    {
      name: 'scene-review.txt (all-briefs reviewer)',
      template: 'prompts/scene-review.txt',
      text: String(PB.buildSceneReviewPrompt(
        inputData,
        [{ pageNumber: 1, brief: BRIEF }, { pageNumber: 2, brief: BRIEF }],
        { beats: BEATS })),
    },
    {
      name: 'book-audit.txt (finished-book audit)',
      template: 'prompts/book-audit.txt',
      text: await buildBookAuditPrompt(),
    },
  );
}, 60_000);

// ── The constant itself ─────────────────────────────────────────────────────

describe('the rule is one exported constant carrying both halves', () => {
  it('promptBuilders exports it', () => {
    expect(typeof RULE).toBe('string');
    expect(RULE.length).toBeGreaterThan(200);
  });

  it('half one scopes the non-fault to a single page, and refuses it as support for another finding', () => {
    // The owner's half: a text may name several characters and several actions;
    // the frame stages one moment. Behaviour, not wording — what is pinned is
    // that the non-fault is stated AND that it cannot be laundered through a
    // different finding.
    expect(RULE).toMatch(/is not a fault/i);
    expect(RULE).toMatch(/not as support for another finding/i);
  });

  it('half two survives: an absence across the WHOLE book is still a fault, charged to the plan', () => {
    // The counterpart that half one must not erase. Staging
    // job_1789681157795_wkt20ckod lost an invented antagonist off three
    // consecutive pages and three of that book's six CRITICAL faults followed —
    // a first-half-only rule would have excused it.
    const second = RULE.slice(RULE.search(/whole book/i));
    expect(second, 'the across-the-book half is gone — half one now excuses a lost character').not.toBe('');
    expect(second).toMatch(/is a fault/i);
    expect(second).toMatch(/plan/i);
    expect(second).toMatch(/never to a picture/i);
  });

  it('the two halves are distinct sentences, so a judge cannot read one and drop the other', () => {
    const at = RULE.search(/whole book/i);
    expect(at).toBeGreaterThan(0);
    expect(RULE.slice(0, at)).toMatch(/is not a fault/i);
  });

  it('carries no story-specific name — prompts stay generic (docs/SETTLED.md)', () => {
    // Every proper-noun-shaped word in the rule must be a sentence opener.
    const stray = RULE.split(/(?<=[.!?])\s+/)
      .flatMap((s: string) => s.trim().split(/\s+/).slice(1))
      .filter((w: string) => /^[A-Z][a-z]{2,}$/.test(w));
    expect(stray, 'a capitalised mid-sentence word reads as a test story leaking into the prompt').toEqual([]);
  });
});

// ── The eight built prompts ─────────────────────────────────────────────────

describe('the constant reaches all eight BUILT prompts', () => {
  it('all eight build non-empty', () => {
    expect(BUILT).toHaveLength(8);
    for (const b of BUILT) expect(b.text.length, `${b.name} built empty`).toBeGreaterThan(400);
  });

  it('every one carries the constant byte-identically', () => {
    const gaps = BUILT.filter(b => !b.text.includes(RULE)).map(b => b.name);
    expect(gaps, 'fillTemplate deletes an undeclared key silently — the rule ships as a hole').toEqual([]);
  });

  it('none leaves {TEXT_NOT_A_CHECKLIST} unfilled', () => {
    const gaps = BUILT.filter(b => b.text.includes('{TEXT_NOT_A_CHECKLIST}')).map(b => b.name);
    expect(gaps).toEqual([]);
  });

  it('no other placeholder was stranded by the edit', () => {
    const gaps = BUILT.filter(b => unfilled(b.text).length > 0)
      .map(b => `${b.name}: ${unfilled(b.text).join(', ')}`);
    expect(gaps).toEqual([]);
  });

  it('each one states the rule exactly once — eight copies, not eight-plus-a-hand-copy', () => {
    const dupes = BUILT
      .map(b => ({ name: b.name, n: b.text.split(RULE).length - 1 }))
      .filter(e => e.n !== 1);
    expect(dupes, 'a second occurrence means a hand-kept copy is back').toEqual([]);
  });
});

// ── The registry keeps the eight together ───────────────────────────────────

describe('the sibling set holds the eight', () => {
  it('is registered, blocks, and names exactly the eight templates the builders fill', () => {
    expect(SET, 'sibling set text-not-a-checklist is gone from the registry').toBeTruthy();
    expect(SET.severity).toBe('block');
    expect(SET.members.slice().sort()).toEqual(BUILT.map(b => b.template).sort());
  });

  it('anchors on the placeholder, and every member template carries it', () => {
    expect(SET.parity.anchors).toContain('{TEXT_NOT_A_CHECKLIST}');
    const gaps = SET.members.filter(
      (m: string) => !fs.readFileSync(path.join(ROOT, m), 'utf8').includes('{TEXT_NOT_A_CHECKLIST}')
    );
    expect(gaps).toEqual([]);
  });

  it('no member keeps a hand-written copy of the rule beside the placeholder', () => {
    const gaps = SET.members.filter(
      (m: string) => fs.readFileSync(path.join(ROOT, m), 'utf8').includes(RULE)
    );
    expect(gaps, 'the prose is in the template as well as the constant — that is the drift this set exists to stop').toEqual([]);
  });
});

// ── The ninth, pinned ABSENT ────────────────────────────────────────────────
//
// image-evaluation.txt carried the rule as N-17 for exactly one commit
// (587d8d755, 2026-09-18) and the owner dropped it the same day. The judge is
// handed no page text on any path: all three sites that build its prompt pass a
// BRIEF as ORIGINAL_PROMPT (evalPipeline's primary build, its safety-retry
// rebuild, and the admin re-evaluate route), while `storyText` is a separate
// argument of evaluateImageQuality that only reaches the semantic and
// compliance judges. A rule that cannot fire still competes for attention in
// the heaviest-deducting prompt in the system.
//
// Pinned so an "add it everywhere" sweep cannot put it back silently — and so
// that WIRING the page text in trips a test rather than arriving with the rule
// missing. If a page-text input is ever added to this judge, both halves change
// together: the placeholder AND the fill in services/prompts.js.
describe('the quality judge is deliberately NOT a consumer', () => {
  const EVAL_TPL = () => String(PROMPT_TEMPLATES.imageEvaluation || '');

  const evalPrompt = () => String(buildEvaluationPrompt({
    originalPrompt: BRIEF,
    artStyle: 'watercolor',
    interactionsBlock: 'Mira — brass lantern — both hands around the handle',
    sceneIntent: 'she lifts the lantern on the pier',
    clothingContract: 'Mira: red raincoat, navy trousers, yellow boots',
    expectedCast: 'EXPECTED CAST (1): Mira',
    requiredObjects: 'brass lantern',
  }));

  it('image-evaluation.txt carries neither the placeholder nor the prose', () => {
    const tpl = EVAL_TPL();
    expect(tpl.length, 'the quality template did not load').toBeGreaterThan(400);
    expect(tpl, 'the placeholder is back in the quality judge — it has no page text to judge against')
      .not.toContain('{TEXT_NOT_A_CHECKLIST}');
    expect(tpl, 'a hand-written copy of the rule is back in the quality judge')
      .not.toContain(RULE);
  });

  it('its BUILT prompt carries neither, and no hole where the rule was', () => {
    const p = evalPrompt();
    expect(p.length).toBeGreaterThan(400);
    expect(p).not.toContain(RULE);
    expect(p).not.toContain('{TEXT_NOT_A_CHECKLIST}');
    expect(unfilled(p), 'the quality prompt ships with a hole').toEqual([]);
  });

  it('the builder has no page-text input — a caller cannot smuggle one in', () => {
    // The premise the removal rests on. buildEvaluationPrompt fills a closed
    // set of named keys, so a page text handed to it under any other name is
    // dropped: the judge scores the picture against its BRIEF, full stop.
    const smuggled = String(buildEvaluationPrompt({
      originalPrompt: BRIEF,
      artStyle: 'watercolor',
      storyText: PAGE_TEXT,
      pageText: PAGE_TEXT,
      STORY_TEXT: PAGE_TEXT,
    } as any));
    expect(smuggled, 'a page text reached the quality judge — the rule belongs back in the template')
      .not.toContain('harbour master');
  });

  it('no page-text placeholder has been wired into the template', () => {
    // The tripwire for the one change that would reverse this decision. Wiring
    // page text in means adding a placeholder for it; when that happens the
    // rule has to come back in the same commit.
    const stray = [...new Set(EVAL_TPL().match(/\{[A-Z][A-Z0-9_]*\}/g) || [])]
      .filter((p: string) => /(STORY|PAGE)_TEXT|^\{TEXT_/.test(p));
    expect(stray, 'the quality judge now receives page text — re-add the rule (it was dropped only because it could never fire)')
      .toEqual([]);
  });

  it('the sibling set does not name it, so gate 9 does not demand it move', () => {
    expect(SET.members).not.toContain('prompts/image-evaluation.txt');
    expect(SET.members).toHaveLength(8);
  });
});
