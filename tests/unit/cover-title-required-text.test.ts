/**
 * A PAINTED COVER TITLE IS REQUIRED LETTERING, on every side (2026-09-23).
 *
 * Staging job_1790100385959_1nitlympp shipped its front cover without a title.
 * v0 had the title painted correctly. The semantic judge had been told "no
 * lettering" and was handed an empty TEXT RULES allow-list, so it filed the
 * title as CRITICAL unrequested text. The consolidator, which was told only the
 * scene, wrote "Remove the text '<title>'", and the inpaint did exactly that.
 * The titleless v1 then scored 100, because the title had reached the quality
 * judge only as a note outside its structured TEXT RULES slot, and D-33 skips an
 * empty TEXT RULES.
 *
 * The contract this file pins:
 *   - every cover judge (quality, semantic) gets the painted title in its
 *     TEXT RULES input, so a correct title is permitted and a missing or
 *     misspelled one is a `required_text` finding;
 *   - the eval result carries the same items, and the consolidator is told
 *     them as lettering that must never be removed;
 *   - the repair clause keeps them;
 *   - an app-overlay (textless) cover requires nothing, as before;
 *   - the generator's title block carries the header its own preamble names
 *     as the one lettering exception.
 *
 * BEHAVIOUR ONLY: which strings reach which judge input. No sentence of prompt
 * wording is pinned.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);

const requiredText = require_('../../server/lib/requiredText.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts.js');
const { buildFeedbackInput } = require_('../../server/lib/feedbackConsolidator.js');
const { buildCoverPrompt } = require_('../../server/lib/promptBuilders.js');
const sceneValidator = require_('../../server/lib/sceneValidator.js');
const { evaluateImageQuality } = require_('../../server/lib/evalPipeline.js');

const TITLE = 'Der Fuchs im Nebelwald';

describe('coverRequiredTexts: the cover text contract as a required-text item', () => {
  it('a painted cover requires its expected text', () => {
    const items = requiredText.coverRequiredTexts({ expectedText: TITLE, textMode: 'painted' });
    expect(items.map((i: any) => i.text)).toEqual([TITLE]);
  });

  it('an app-overlay cover is textless art and requires nothing', () => {
    expect(requiredText.coverRequiredTexts({ expectedText: TITLE, textMode: 'appOverlay' })).toEqual([]);
  });

  it('no expected text means no item, never an empty string', () => {
    expect(requiredText.coverRequiredTexts({ expectedText: '  ', textMode: 'painted' })).toEqual([]);
    expect(requiredText.coverRequiredTexts({})).toEqual([]);
  });

  it('the judge block and the repair clause both quote the title', () => {
    const items = requiredText.collectImageRequiredTexts({ expectedText: TITLE, textMode: 'painted' });
    expect(requiredText.buildRequiredTextRulesBlock(items)).toContain(`"${TITLE}"`);
    expect(requiredText.buildRequiredTextRepairClause(items)).toContain(`"${TITLE}"`);
  });

  it('a page with no cover contract gets exactly its Visual Bible strings, as before', () => {
    const vb = { artifacts: [{ id: 'ART001', name: 'Signpost', description: 'a wooden signpost', text: 'NORD' }] };
    const page = requiredText.collectImageRequiredTexts({ objectIds: ['ART001'], visualBible: vb });
    expect(page).toEqual(requiredText.collectRequiredTexts({ objectIds: ['ART001'], visualBible: vb }));
  });
});

// ── The real evaluateImageQuality, network boundaries stubbed ───────────────

const IMAGE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const realFetch = globalThis.fetch;
const realSemantic = sceneValidator.evaluateSemanticFidelity;
const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

const QUALITY_JSON = JSON.stringify({
  score: 100, reasoning: 'clean', figures: [], matches: [], fixable_issues: [],
});
const INVENTORY_JSON = JSON.stringify({
  figures: [], interactions: [], objects: [], setting: 'a forest', lettering: [], rendering: {},
});

function geminiReply(text: string) {
  return {
    ok: true, status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
    text: async () => text,
  } as any;
}

type Seen = { visionBodies: string[]; semantic: { storyText: string; textRules: string } | null };

/**
 * The judges' ORIGINAL_PROMPT is the part of the cover prompt BEFORE the
 * protected tail, which is where the title block sits — so, exactly as in
 * production, the prompt handed in here does not contain the title.
 */
async function runCoverEval(evalOptions: Record<string, unknown>): Promise<{ result: any; seen: Seen }> {
  const seen: Seen = { visionBodies: [], semantic: null };
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body || '');
    seen.visionBodies.push(body);
    return geminiReply(seen.visionBodies.length > 1 ? INVENTORY_JSON : QUALITY_JSON);
  }) as any;
  sceneValidator.evaluateSemanticFidelity = async (_img: any, storyText: string, _prompt: any, _hint: any, _tpl: any, ctx: any) => {
    seen.semantic = { storyText: String(storyText || ''), textRules: String(ctx?.textRules || '') };
    return { score: 100, semanticIssues: [], usage: {} };
  };
  const result = await evaluateImageQuality(
    IMAGE,
    'A fox cub sits on a mossy log in a misty forest. No lettering on any surface.',
    [], 'cover', null, 'frontCover-test', null,
    'A fox cub sits on a mossy log in a misty forest, looking at the viewer.',
    null,
    { complianceJudgeOverride: false, ...evalOptions },
  );
  return { result, seen };
}

beforeAll(async () => {
  await loadPromptTemplates();
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sceneValidator.evaluateSemanticFidelity = realSemantic;
});

afterAll(() => {
  if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
});

describe('a painted cover title reaches every judge as required lettering', () => {
  it('the semantic judge gets the title in its TEXT RULES input', async () => {
    const { seen } = await runCoverEval({ expectedText: TITLE, textMode: 'painted' });
    expect(seen.semantic, 'the semantic judge must run on a cover with a brief').toBeTruthy();
    expect(seen.semantic!.textRules).toContain(`"${TITLE}"`);
  });

  it('the semantic judge is also told what that string is on a cover', async () => {
    const { seen } = await runCoverEval({ expectedText: TITLE, textMode: 'painted' });
    const sections = require_('../../server/services/prompts.js')
      .promptSections(PROMPT_TEMPLATES.coverEvaluationNotes);
    expect(seen.semantic!.storyText).toContain(sections.COVER_TEXT);
  });

  it('the quality judge prompt carries the title even though the scene prompt does not', async () => {
    const { seen } = await runCoverEval({ expectedText: TITLE, textMode: 'painted' });
    const quality = seen.visionBodies.find(b => b.includes('TEXT RULES')) || '';
    expect(quality).toContain(TITLE);
  });

  it('the result carries the same items for the consolidator', async () => {
    const { result } = await runCoverEval({ expectedText: TITLE, textMode: 'painted' });
    expect((result.requiredTexts || []).map((i: any) => i.text)).toEqual([TITLE]);
  });

  it('a title found only in a raw generation prompt (no structured contract) is still required', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_u: any, init: any) => { seen.push(String(init?.body || '')); return geminiReply(seen.length > 1 ? INVENTORY_JSON : QUALITY_JSON); }) as any;
    sceneValidator.evaluateSemanticFidelity = async () => ({ score: 100, semanticIssues: [], usage: {} });
    const result = await evaluateImageQuality(IMAGE,
      `A fox cub on a log.\n\n**REQUIRED TEXT:**\nPaint "${TITLE}" in the upper third of the canvas.`,
      [], 'cover', null, 'frontCover-test', null, null, null, { complianceJudgeOverride: false });
    expect((result.requiredTexts || []).map((i: any) => i.text)).toEqual([TITLE]);
  });
});

describe('an app-overlay cover requires no lettering, as before', () => {
  it('no judge input and no result item names the title', async () => {
    const { result, seen } = await runCoverEval({ expectedText: null, textMode: 'appOverlay' });
    expect(seen.semantic!.textRules).toBe('');
    expect(result.requiredTexts).toEqual([]);
    for (const b of seen.visionBodies) expect(b).not.toContain(TITLE);
  });
});

describe('the consolidator is told the required lettering', () => {
  const base = { sceneDescription: 'A fox cub on a log in a misty forest.' };

  it('a required string appears in its input', () => {
    const input = buildFeedbackInput({ ...base, requiredTexts: [{ id: null, label: 'cover', text: TITLE }] });
    expect(input).toContain(`"${TITLE}"`);
  });

  it('no required strings, no section — the input is unchanged', () => {
    expect(buildFeedbackInput({ ...base, requiredTexts: [] })).toBe(buildFeedbackInput({ ...base }));
  });

  it('consolidateFeedback reads the items off the evaluation it is handed', () => {
    const src = readFileSync(fileURLToPath(new URL('../../server/lib/feedbackConsolidator.js', import.meta.url)), 'utf8');
    expect(src).toMatch(/requiredTexts:\s*evaluation\.requiredTexts/);
  });
});

describe('repair keeps a baked title', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('the production inpaint dispatch hands inpaintPage the cover text contract', () => {
    const src = read('../../server/lib/repairPipeline.js');
    const call = src.slice(src.indexOf('images().inpaintPage(inputImage'), src.indexOf('images().inpaintPage(inputImage') + 3000);
    expect(call).toMatch(/expectedText:/);
    expect(call).toMatch(/textMode:/);
  });

  it('inpaintPage builds its required-text clause from that contract', () => {
    const src = read('../../server/lib/images.js');
    expect(src).toMatch(/collectImageRequiredTexts\(\{[^}]*expectedText,\s*textMode/);
  });
});

describe('generator: the title block is the exception its own preamble names', () => {
  it('the baked front-cover prompt carries the REQUIRED TEXT header with the title under it', () => {
    const p = buildCoverPrompt('front', {
      sceneDescription: 'The main character stands in a misty forest.',
      inputData: { artStyle: 'watercolor', language: 'de' },
      characters: [{ name: 'Mila' }],
      options: { bakeTitle: TITLE },
    });
    // The preamble's one exception is "a REQUIRED TEXT block below".
    expect(PROMPT_TEMPLATES.imageGeneration).toContain('REQUIRED TEXT block');
    const idx = p.lastIndexOf('**REQUIRED TEXT:**');
    expect(idx).toBeGreaterThan(-1);
    expect(p.slice(idx)).toContain(`"${TITLE}"`);
  });
});
