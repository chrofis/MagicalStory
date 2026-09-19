import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildExpectedCastBlock, evaluateThreeStage } = require_('../../server/lib/evalPipeline');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require_('../../server/services/prompts');
const textModels = require_('../../server/lib/textModels');

// THE AUDIT (2026-09-19). Stage 1 of the eval — the shared blind inventory from
// `runVisualInventory`, template `prompts/image-inventory-unified.txt` — was read
// finding-by-finding against the pixels of staging story
// job_1789759147125_p08djwhbl. Two defects came out of it, and both fixtures
// below are that story's REAL stored records, nothing hand-built.
const fixture = require_('./fixtures/stage1-inventory-job_1789759147125_p08djwhbl.json');
const page = (n: number) => fixture.pages.find((p: any) => p.pageNumber === n);
const P3 = page(3);
const P8 = page(8);
const animal = fixture.visualBible.animals.find((a: any) => a.id === 'ANI001');

beforeAll(async () => { await loadPromptTemplates(); });

describe('`facing` takes a value, never the instruction that describes one', () => {
  // THE DEFECT. The spec's last alternative read "or toward another figure's
  // label" — a description of a value sitting in a list of values — and the
  // model copied it in. 6 of 48 figures across this story's 18 pages carry
  // `facing: "toward another figure's label"`.
  const LEAKED = "toward another figure's label";

  it('the stored story really does carry the leaked instruction (guards the test)', () => {
    let leaked = 0, total = 0;
    for (const p of fixture.pages) {
      const vi = JSON.parse(p.threeStageResult.visionInventory);
      for (const f of vi.figures || []) { total++; if (f.facing === LEAKED) leaked++; }
    }
    expect(total).toBeGreaterThan(0);
    expect(leaked).toBeGreaterThan(0);
  });

  it('the template never offers that phrase as a copyable value', () => {
    const t = PROMPT_TEMPLATES.imageInventoryUnified;
    expect(t).toBeTruthy();
    expect(t).not.toContain(LEAKED);
  });

  it('the `facing` spec enumerates a closed set of values', () => {
    const line = PROMPT_TEMPLATES.imageInventoryUnified
      .split('\n').find((l: string) => l.trim().startsWith('- `facing`'));
    expect(line).toBeTruthy();
    for (const v of ['`toward viewer`', '`away from viewer`', '`left`', '`right`']) {
      expect(line).toContain(v);
    }
    // The fifth form is a value the model builds from a label it already wrote,
    // not a phrase it may echo.
    expect(line).toMatch(/label/);
  });
});

describe('a declared animal filed in `objects[]` is present, not absent', () => {
  // THE DEFECT. Stage 1 is identity-blind by construction ("Do not name or
  // identify anyone"), so it files the story's dog as `{"what": "a small dog"}`.
  // The compliance judge's animal rule asked it to find the animal NAMED in
  // `objects` — a test that can never pass — and on p8 it filed
  // `unverified_absence` demanding the dog be added to a picture it is in.
  const roster = (p: any) => buildExpectedCastBlock({
    sceneCharacters: p.sceneCharacters,
    sceneHint: p.prompt,
    originalPrompt: p.prompt,
    visualBible: fixture.visualBible,
    sceneMetadata: p.sceneMetadata,
    pageNumber: p.pageNumber,
  });

  it('the roster the judge was handed really did tag the animal (guards the test)', () => {
    const r = roster(P8);
    expect(r.block).toContain(`${animal.name} (animal`);
    expect(r.nonHumanNames.map((n: string) => n.toLowerCase())).toContain(animal.name.toLowerCase());
  });

  it('stage 1 described the animal in `objects[]` and named nobody (guards the test)', () => {
    const vi = JSON.parse(P8.threeStageResult.visionInventory);
    const dog = (vi.objects || []).find((o: any) => /dog/i.test(o.what));
    expect(dog).toBeTruthy();
    expect(JSON.stringify(vi.objects)).not.toContain(animal.name);
    expect((vi.figures || []).some((f: any) => /dog/i.test(f.label || ''))).toBe(false);
  });

  it('the stored page really did file the animal as absent (guards the test)', () => {
    const f = P8.threeStageResult.fixableIssues
      .find((i: any) => i.character === animal.name && i.type === 'unverified_absence');
    expect(f).toBeTruthy();
    expect(P8.threeStageResult.complianceResult.scene.missing).toContain(`${animal.name} (animal, terrier mix dog)`);
  });

  // BUILT PROMPT, not the template: the judge is driven for real with the model
  // call stubbed, so this pins what it is actually sent.
  const buildCompliancePrompt = async (p: any) => {
    const original = textModels.callTextModel;
    let captured = '';
    textModels.callTextModel = async (input: string) => {
      captured = input;
      return { text: '{"verdict":"PASS","fixable_issues":[]}', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      const vi = JSON.parse(p.threeStageResult.visionInventory);
      await evaluateThreeStage('data:image/jpeg;base64,AAAA', p.prompt, p.prompt, {
        pageContext: `PAGE ${p.pageNumber}`,
        inventoryPromise: Promise.resolve({ ...vi, inputTokens: 0, outputTokens: 0 }),
        qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
        visualBible: fixture.visualBible,
        expectedCast: roster(p).block,
      });
    } finally {
      textModels.callTextModel = original;
    }
    return captured;
  };

  it('the animal rule pairs on KIND and forbids the name test that cannot pass', async () => {
    const built = await buildCompliancePrompt(P8);
    const rule = built.split('STEP 1: PAIR FIGURES BY ZONE')[1] || '';
    expect(rule).toMatch(/\(animal\)/);
    expect(rule).toMatch(/objects/);
    // The broken positive test — "Named in `objects` → present" — is gone.
    expect(rule).not.toMatch(/Named in `objects`/);
    // …replaced by one the identity-blind inventory can satisfy.
    expect(rule).toMatch(/never on the name/i);
    expect(rule).toMatch(/species/i);
    for (const code of ['missing_character', 'extra_character', 'duplicate_identity']) {
      expect(rule).toContain(code);
    }
  });

  it('the judge is told `scene` carries no key for what it believes is missing', async () => {
    const built = await buildCompliancePrompt(P8);
    expect(built).toMatch(/`scene` carries `extra` and `setting_match` and no other key/);
  });

  it('the judge really is handed both halves of the pairing it failed', async () => {
    const built = await buildCompliancePrompt(P8);
    expect(built).toContain(`${animal.name} (animal`);
    expect(built).toContain('a small dog');
    expect(built).not.toContain('{EXPECTED_CAST}');
    expect(built).not.toContain('{VISUAL_INVENTORY}');
  });

  it('p3 shows the same rule under strain — the judge recovered only by reasoning descriptively', () => {
    const r = roster(P3);
    expect(r.block).toContain(`${animal.name} (animal`);
    const vi = JSON.parse(P3.threeStageResult.visionInventory);
    expect(JSON.stringify(vi.objects)).not.toContain(animal.name);
  });
});

describe('the three-stage record round-trips as JSON, never as a char-indexed string', () => {
  // REPORTED as stored `{"0":"{","1":"\\"f",...}`. Measured across 40 recent
  // staging stories / 365 pages carrying a threeStageResult: zero such records.
  // `visionInventory` is a JSON STRING by design (evalPipeline.js:1010,
  // `JSON.stringify(...)`) and the TS type says so — reading `vi.figures` off it
  // is undefined because it is a string, not because anything spread it. This
  // pins both halves so a real spread would fail here.
  it('every stored page holds a parseable JSON string, not an object', () => {
    for (const p of fixture.pages) {
      const vi = p.threeStageResult.visionInventory;
      expect(typeof vi).toBe('string');
      const parsed = JSON.parse(vi);
      expect(Array.isArray(parsed.figures)).toBe(true);
      expect(Array.isArray(parsed.objects)).toBe(true);
    }
  });

  it('complianceResult and fixableIssues keep their own shapes', () => {
    for (const p of fixture.pages) {
      const ts = p.threeStageResult;
      expect(Array.isArray(ts.fixableIssues)).toBe(true);
      expect(ts.complianceResult).toBeTypeOf('object');
      expect(Array.isArray(ts.complianceResult)).toBe(false);
      // A string spread into an object is recognisable by its first keys.
      expect(Object.keys(ts.complianceResult).slice(0, 2)).not.toEqual(['0', '1']);
    }
  });

  it('the writer emits a string the reader can parse, end to end', async () => {
    const original = textModels.callTextModel;
    textModels.callTextModel = async () => ({
      text: '{"verdict":"PASS","fixable_issues":[]}', usage: { input_tokens: 1, output_tokens: 1 },
    });
    try {
      const vi = JSON.parse(P8.threeStageResult.visionInventory);
      const res = await evaluateThreeStage('data:image/jpeg;base64,AAAA', P8.prompt, P8.prompt, {
        pageContext: 'PAGE 8',
        inventoryPromise: Promise.resolve({ ...vi, inputTokens: 0, outputTokens: 0 }),
        qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
        visualBible: fixture.visualBible,
        expectedCast: '',
      });
      expect(typeof res.visionInventory).toBe('string');
      const round = JSON.parse(res.visionInventory);
      expect(round.objects.some((o: any) => /dog/i.test(o.what))).toBe(true);
      expect(res.complianceResult).toBeTypeOf('object');
      expect(Object.keys(res.complianceResult).slice(0, 2)).not.toEqual(['0', '1']);
    } finally {
      textModels.callTextModel = original;
    }
  });
});
