/**
 * CAPTIONS ON COVERS (2026-09-26).
 *
 * Staging job_1790446348343_z3fw660ie shipped a back cover with a painted
 * caption "THE FIVE FRIENDS STAND TOGETHER". Three defects, three fixes, all
 * pinned here as behaviour:
 *
 *  (A) The undeclared-lettering check ran on scenes only, so the caption was a
 *      judge's MAJOR `rendered_text` at best — below the repair gate. It now
 *      runs on covers briefed as pages (`coverIsPage`). The cover's declared
 *      strings are excused: a baked title (REQUIRED TEXT) and, in appOverlay
 *      mode, the app's own string (`appTexts`: title / dedication /
 *      "magicalstory.ch"), which a post-persist eval sees stamped.
 *  (B) An entity CRITICAL routed every round to char-fix, one method per
 *      round, and the caption was never painted out. A CRITICAL rendered_text
 *      now takes the round; the figure repair waits for the next.
 *  (C) The cover beat's internal label ("BOOK BACK COVER, not a story moment")
 *      was copied by the Art Director into sceneIntent, which leads the image
 *      prompt. The label is gone from the plan line; the page number carries
 *      the identity, explained once in COVER_GAZE_EXCEPTION.
 *
 * The evaluator runs for real with only the two network boundaries stubbed
 * (the same harness as compliance-judge-off.test.ts).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const textModels = require_('../../server/lib/textModels.js');
const { evaluateImageQuality } = require_('../../server/lib/evalPipeline.js');
const { resolveCoverTextContract } = require_('../../server/lib/coverTypography.js');
const { buildEvalReplayOptions } = require_('../../server/lib/evalReplayInputs.js');
const repairLogic = require_('../../server/lib/repairLogic.js');
const CB = require_('../../server/lib/coverBeats.js');
const PB = require_('../../server/lib/promptBuilders.js');
const { MODEL_DEFAULTS } = require_('../../server/config/models.js');

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const realCallTextModel = textModels.callTextModel;
const realFetch = globalThis.fetch;
const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

function geminiReply(text: string) {
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }),
    text: async () => text,
  } as any;
}

const QUALITY_JSON = (issues: any[] = []) => JSON.stringify({
  reasoning: 'ok',
  figures: [{ id: 1, position: 'center', description: 'a child in a coat' }],
  matches: [{ figure: 1, name: 'Mila', confidence: 0.9 }],
  fixable_issues: issues,
});

// The back cover's two strings as the blind inventory reports a stamped cover:
// the model's caption, and the app's brand line.
const BACK_COVER_LETTERING = [
  { text: 'THE FIVE FRIENDS STAND TOGETHER', surface: 'caption band', position: 'bottom-center', placement: 'overlay', spelling: 'correct' },
  { text: 'magicalstory.ch', surface: 'bottom edge', position: 'bottom-left', placement: 'overlay', spelling: 'correct' },
];
const inventoryJson = (lettering: any[]) => JSON.stringify({
  figures: [{ label: 'the child in a coat', zone: 'center-foreground' }],
  interactions: [], objects: [], setting: {}, lettering, rendering: {},
});

/** Run the REAL evaluator; the inventory call is told apart by its prompt. */
async function runEval(evaluationType: 'scene' | 'cover', evalOptions: Record<string, unknown>, { lettering = [] as any[], qualityIssues = [] as any[] } = {}) {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body || '');
    const isInventory = body.includes('Do not name or identify anyone');
    return geminiReply(isInventory ? inventoryJson(lettering) : QUALITY_JSON(qualityIssues));
  }) as any;
  textModels.callTextModel = async (_p: string, _m: any, model: string) => ({
    text: '{}', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', modelId: model, provider: 'mock',
  });
  return evaluateImageQuality(IMAGE, 'The cast stand together on a river landing.', [], evaluationType, null,
    'test', null, 'The cast stand together', null, { complianceJudgeOverride: false, ...evalOptions });
}

beforeAll(async () => {
  await loadPromptTemplates();
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
});
afterEach(() => { textModels.callTextModel = realCallTextModel; globalThis.fetch = realFetch; });
afterAll(() => {
  if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
});

const letteringFindings = (r: any) => (r?.fixableIssues || []).filter((f: any) => f.source === 'lettering-check');

describe('(A) the lettering check runs on covers briefed as pages', () => {
  const backContract = resolveCoverTextContract('backCover', { titleBaked: false });

  it('the contract names the app string of each cover in appOverlay mode, none when painted', () => {
    if (!MODEL_DEFAULTS.appSideCoverType) return; // painted-everywhere configuration: nothing app-side
    expect(backContract).toEqual({ textMode: 'appOverlay', expectedText: null, appTexts: ['magicalstory.ch'] });
    expect(resolveCoverTextContract('frontCover', { titleBaked: false, title: 'The Lantern Keeper' }).appTexts).toEqual(['The Lantern Keeper']);
    expect(resolveCoverTextContract('initialPage', { titleBaked: false, dedication: 'For Ada' }).appTexts).toEqual(['For Ada']);
    expect(resolveCoverTextContract('initialPage', { titleBaked: false, dedication: '' }).appTexts).toEqual([]);
    expect(resolveCoverTextContract('frontCover', { titleBaked: true, title: 'T' }).appTexts).toEqual([]);
  });

  it('a caption on a cover page is a CRITICAL; the stamped brand line is excused', async () => {
    const r = await runEval('cover', { ...backContract, coverIsPage: true }, { lettering: BACK_COVER_LETTERING });
    const found = letteringFindings(r);
    expect(found).toHaveLength(MODEL_DEFAULTS.appSideCoverType ? 1 : 2);
    expect(found[0]).toMatchObject({ type: 'rendered_text', severity: 'CRITICAL' });
    expect(found[0].description).toContain('THE FIVE FRIENDS STAND TOGETHER');
    // The stored record is what the critical-gone-wins re-check compares.
    expect(r.letteringInventory.items).toHaveLength(2);
    if (MODEL_DEFAULTS.appSideCoverType) expect(r.letteringInventory.declared).toContain('magicalstory.ch');
  });

  it('a cover NOT briefed as a page (trial) is not checked', async () => {
    const r = await runEval('cover', { ...backContract, coverIsPage: false }, { lettering: BACK_COVER_LETTERING });
    expect(letteringFindings(r)).toEqual([]);
    expect(r.letteringInventory).toBeNull();
  });

  it('a baked front title is a REQUIRED TEXT and is never a lettering finding', async () => {
    const front = resolveCoverTextContract('frontCover', { titleBaked: true, title: 'Fiona and the Captain' });
    const r = await runEval('cover', { ...front, coverIsPage: true }, {
      lettering: [{ text: 'Fiona and the Captain', surface: 'sky', position: 'top-center', placement: 'overlay', spelling: 'correct' }],
    });
    expect(letteringFindings(r)).toEqual([]);
  });

  it('the Lab / admin replay carries the contract and the page mark from the stored cover record', () => {
    const { options } = buildEvalReplayOptions({
      pageNumber: -3, scene: { briefedAsPage: true, titleBaked: false, referencePhotos: [] }, characters: [], title: 'T',
    });
    expect(options.coverIsPage).toBe(true);
    expect(options.appTexts).toEqual(backContract.appTexts);
    const page = buildEvalReplayOptions({ pageNumber: 4, scene: {}, characters: [] }).options;
    expect(page.coverIsPage).toBe(false);
    expect(page.appTexts).toBeNull();
  });
});

describe('(A, bug 1) the landmark guard runs on the quality record at the eval merge', () => {
  it('a removal aimed at the landmark leaves fixableIssues and is stored as suppressedIssues', async () => {
    const removal = { description: 'The background shows a city that is not the declared one', severity: 'CRITICAL', type: 'setting', landmark_element: true, fix: 'Replace the background skyline with the declared town' };
    const keep = { description: 'The coat is green, the contract says navy', severity: 'MAJOR', type: 'clothing', landmark_element: false, fix: 'Repaint the coat navy' };
    const r = await runEval('scene', {
      landmarkPhotos: [{ name: 'Old Bridge', photoData: 'x' }], era: null,
    }, { qualityIssues: [removal, keep] });
    expect(r.fixableIssues.map((f: any) => f.description)).toEqual([keep.description]);
    expect(r.suppressedIssues).toHaveLength(1);
    expect(r.suppressedIssues[0]).toMatchObject({ severity: 'CRITICAL', suppressed: 'landmark_protected' });
  });
});

describe('(B) lettering goes first when a character CRITICAL shares the page', () => {
  const ENTITY = { characters: { Lorena: { issues: [{ severity: 'CRITICAL', type: 'face_drift', pages: [-3], description: 'face drift' }] } } };
  const ROSTER = [{ name: 'Lorena', avatars: { standard: 'x' }, photos: { face: 'x' } }];
  const withCaption = {
    finalScore: 40, scoreBreakdown: { visual: { score: 70 }, semantic: { score: 80 } }, fixableIssues: [],
    consolidatedPlan: { deduped_issues: [
      { type: 'rendered_text', severity: 'CRITICAL', description: 'A caption is laid over the picture', sources: ['quality'] },
      { type: 'face_drift', severity: 'CRITICAL', character: 'Lorena', description: 'face drift', sources: ['entity'] },
    ] },
  };

  it('the caption takes the round (inpaint); without it the character takes char-fix', () => {
    const opts = { characters: ROSTER, expectedCast: [{ name: 'Lorena' }] };
    const base = repairLogic.decideRepairMethod(-3, { ...withCaption, consolidatedPlan: { deduped_issues: [withCaption.consolidatedPlan.deduped_issues[1]] } }, ENTITY, opts);
    // Guards the fixture: the entity finding alone does route to char-fix.
    expect(base.method).toBe('char-fix');
    const d = repairLogic.decideRepairMethod(-3, withCaption, ENTITY, opts);
    expect(d.method).toBe('inpaint');
    expect(d.reason).toMatch(/rendered_text/);
  });

  it('a MAJOR caption does not jump the queue', () => {
    const major = JSON.parse(JSON.stringify(withCaption));
    major.consolidatedPlan.deduped_issues[0].severity = 'MAJOR';
    expect(repairLogic.decideRepairMethod(-3, major, ENTITY, { characters: ROSTER, expectedCast: [{ name: 'Lorena' }] }).method).toBe('char-fix');
  });
});

describe('(C) no internal cover label in the plan line', () => {
  const input = { characters: [{ name: 'Child1', isMainCharacter: true }, { name: 'Child2' }] };

  it('no beat carries a label the Art Director could copy into sceneIntent', () => {
    for (const b of CB.buildCoverBeats(input)) {
      expect(b.planLine).not.toMatch(/BOOK (FRONT|BACK) COVER|BOOK OPENING PAGE|story moment/i);
      expect(b.planLine.split(' — ')[0]).toBe('wide');
      expect(typeof b.coverKey).toBe('string');
    }
  });

  it('the page number is the identity, explained once to the Art Director and the review', () => {
    for (const n of ['-1', '-2', '-3']) expect(PB.COVER_GAZE_EXCEPTION).toContain(`page ${n}`);
    expect(PB.LOOKS_AT_FIELD_RULE).toContain(PB.COVER_GAZE_EXCEPTION);
  });
});
