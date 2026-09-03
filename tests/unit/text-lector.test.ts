import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// @ts-ignore — CommonJS lib
const {
  refineStoryText, parseFaultLines, mergeAuditFindings,
  pageDiffRatio, screenLectorPages, LECTOR_MAX_DIFF_RATIO,
} = require('../../server/lib/textRefine.js');

/**
 * THE CHAIN (owner ruling 2026-09-03): two audits in parallel → merge+dedupe →
 * ONE repair → ONE lector that returns the corrected pages itself.
 *
 * Three things are tested here because three things replaced deleted machinery:
 * the merge that replaced the sequential re-audit, the edit-distance cap that
 * replaced the verbatim-quote check, and the call order itself (nothing may
 * re-audit, nothing may apply findings in a second pass).
 */

// ─────────────────────────────── MERGE + DEDUPE ────────────────────────────────

// Real fault-line shape from both templates.
const ARC_AUDIT = [
  'Walking the pages in order.',
  'FAULT[TRANSITION]: p4 — the main character is on the far bank with no page showing the crossing.',
  'FAULT[LOADBEARING]: p7 — the story\'s named cause becomes "the map", losing what made it unique.',
  'FAULT[ASSUMED]: p9 — the rival knows the hiding place no page ever told them.',
  'FAULTS: 3',
].join('\n');

const BLIND_AUDIT = [
  'FAULT[TRANSITION]: p4 — suddenly on the far bank of the water, nothing says how the crossing happened.',
  'FAULT[CONFUSION]: p2 — a listener cannot tell who is speaking here.',
  'FAULT[PAYOFF]: p9 — the closed box is never opened.',
  'FAULTS: 3',
].join('\n');

describe('parseFaultLines', () => {
  it('parses category, page and sentence, and tags the source', () => {
    const f = parseFaultLines(ARC_AUDIT, 'arc-informed');
    expect(f).toHaveLength(3);
    expect(f[0]).toMatchObject({ category: 'TRANSITION', pageNumber: 4, sources: ['arc-informed'] });
    expect(f[0].text).toContain('far bank');
  });

  it('ignores prose, the FAULTS total and bullets, and accepts the bare untagged form', () => {
    const f = parseFaultLines('Let me think about this.\n- FAULT: p3 — something is wrong.\nFAULTS: 1', 'blind');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: 'UNTAGGED', pageNumber: 3 });
  });
});

describe('mergeAuditFindings', () => {
  const merged = mergeAuditFindings([
    { source: 'arc-informed', raw: ARC_AUDIT },
    { source: 'blind', raw: BLIND_AUDIT },
  ]);

  it('folds the same fault found by both auditors into one finding', () => {
    // p4 TRANSITION: both name it, in different words.
    const p4 = merged.findings.filter(f => f.pageNumber === 4);
    expect(p4).toHaveLength(1);
    expect(merged.duplicates).toHaveLength(1);
  });

  it('keeps the source tags of every auditor that found a merged fault', () => {
    const p4 = merged.findings.find(f => f.pageNumber === 4);
    expect(p4.sources).toEqual(['arc-informed', 'blind']);
    // The first list wins the wording.
    expect(p4.text).toContain('no page showing the crossing');
  });

  it('keeps genuinely different faults on the same page apart', () => {
    // p9 carries an ASSUMED fault and an unrelated PAYOFF one.
    const p9 = merged.findings.filter(f => f.pageNumber === 9);
    expect(p9).toHaveLength(2);
  });

  it('keeps the findings only one auditor found, tagged with that one', () => {
    expect(merged.findings.find(f => f.pageNumber === 2).sources).toEqual(['blind']);
    expect(merged.findings.find(f => f.pageNumber === 7).sources).toEqual(['arc-informed']);
  });

  it('reports per-source counts and renders the prompt block as verbatim FAULT lines', () => {
    expect(merged.bySource).toEqual({ 'arc-informed': 3, blind: 3 });
    expect(merged.findings).toHaveLength(5);
    expect(merged.text.split('\n')).toHaveLength(5);
    expect(merged.text.split('\n').every(l => l.startsWith('FAULT'))).toBe(true);
    // Sorted by page, so the repair pass reads them in reading order.
    expect(merged.findings.map(f => f.pageNumber)).toEqual([2, 4, 7, 9, 9]);
  });

  it('survives one auditor failing entirely', () => {
    const only = mergeAuditFindings([{ source: 'arc-informed', raw: ARC_AUDIT }]);
    expect(only.findings).toHaveLength(3);
    expect(mergeAuditFindings([]).findings).toHaveLength(0);
  });
});

// ─────────────────── LECTOR GUARD: PER-PAGE EDIT-DISTANCE CAP ──────────────────

describe('pageDiffRatio', () => {
  const PAGE =
    'Er schwamm die Leine zurück zum Schiff und band sie fest. Das Papier war alt und dünn, '
    + 'und der Wind zog daran. Niemand sagte ein Wort, bis der Knoten hielt.';

  it('is 0 for the same text and for a page only re-wrapped', () => {
    expect(pageDiffRatio(PAGE, PAGE)).toBe(0);
    expect(pageDiffRatio(PAGE, PAGE.replace(' und band', '\nund band'))).toBe(0);
  });

  it('stays far under the cap for a real language fix', () => {
    const fixed = PAGE.replace('schwamm die Leine', 'schwamm mit der Leine');
    expect(pageDiffRatio(PAGE, fixed)).toBeLessThan(LECTOR_MAX_DIFF_RATIO / 2);
  });

  it('stays under the cap for two fixes on one page', () => {
    const fixed = PAGE
      .replace('schwamm die Leine', 'schwamm mit der Leine')
      .replace('Das Papier war alt', 'Das Papier war uralt');
    expect(pageDiffRatio(PAGE, fixed)).toBeLessThan(LECTOR_MAX_DIFF_RATIO);
  });

  it('goes far over the cap when the page is re-narrated', () => {
    const rewritten =
      'Mit der Leine zwischen den Zähnen kämpfte er sich zurück, Zug um Zug, bis der Rumpf '
      + 'über ihm aufragte. Erst dann atmete er wieder.';
    expect(pageDiffRatio(PAGE, rewritten)).toBeGreaterThan(LECTOR_MAX_DIFF_RATIO);
  });
});

describe('screenLectorPages', () => {
  const pages = [
    { pageNumber: 1, text: 'Die Karte ist alt: das Papier ist dünn und der Rand ist eingerissen.' },
    { pageNumber: 2, text: 'Er schwamm die Leine zurück zum Schiff und zog sie über die Reling.' },
  ];

  it('accepts a bounded correction and records its ratio', () => {
    const { accepted, rejected } = screenLectorPages(pages, [
      { pageNumber: 2, text: 'Er schwamm mit der Leine zurück zum Schiff und zog sie über die Reling.' },
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].pageNumber).toBe(2);
    expect(accepted[0].ratio).toBeGreaterThan(0);
    expect(rejected).toHaveLength(0);
  });

  it('rejects a page the lector rewrote instead of correcting', () => {
    const { accepted, rejected } = screenLectorPages(pages, [
      { pageNumber: 1, text: 'Uralt war die Karte, brüchig wie ein trockenes Blatt, und niemand wagte es, sie ganz zu entfalten.' },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].ratio).toBeGreaterThan(LECTOR_MAX_DIFF_RATIO);
  });

  it('drops a page number the story does not have', () => {
    const { accepted, stray } = screenLectorPages(pages, [{ pageNumber: 99, text: 'anything' }]);
    expect(accepted).toHaveLength(0);
    expect(stray).toEqual([99]);
  });

  it('counts a page returned unchanged as neither accepted nor rejected', () => {
    const { accepted, rejected } = screenLectorPages(pages, [{ pageNumber: 1, text: pages[0].text }]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });
});

// ──────────────────────── CHAIN ORDER, WITH STUBBED MODELS ────────────────────

/**
 * Real templates and real prompt builders, stubbed model calls: this asserts
 * the SHAPE of the chain — two audits concurrently, then one repair, then one
 * lector — and that the deleted steps (`text_audit2`, `text_lector_apply`) are
 * not reachable from any path.
 */
describe('refineStoryText — chain order', () => {
  const textModels = require('../../server/lib/textModels');
  const original = textModels.callTextModelStreaming;
  const calls: { label: string; model: string; prompt: string }[] = [];
  let maxConcurrent = 0;
  let inFlight = 0;

  const PAGES = [
    { pageNumber: 1, text: 'Die Karte ist alt: das Papier ist dünn und der Rand ist eingerissen.', sceneIntent: 'a hand holds a map', sceneBrief: 'a hand holds a map', planLine: '' },
    { pageNumber: 2, text: 'Er schwamm die Leine zurück zum Schiff und zog sie über die Reling.', sceneIntent: 'a swimmer reaches a hull', sceneBrief: 'a swimmer reaches a hull', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 2, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (_prompt: string, _max: number, _img: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      calls.push({ label, model, prompt: String(_prompt || '') });
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      let text = '';
      if (label === 'text_audit') text = 'FAULT[TRANSITION]: p2 — no page shows how he reached the water.\nFAULTS: 1';
      else if (label === 'text_audit_blind') text = 'FAULT[TRANSITION]: p2 — he is suddenly in the water, nothing says how.\nFAULTS: 1';
      else if (label === 'text_refine') text = '---ANALYSIS---\nthe crossing is stated on p2\n---STORY TEXT---\nNONE';
      else if (label === 'text_lector') {
        text = '---STORY TEXT---\n## Page 2\nEr schwamm mit der Leine zurück zum Schiff und zog sie über die Reling.'
          // p1 is an overhaul — the cap must throw it out.
          + '\n\n## Page 1\nUralt war die Karte, brüchig wie ein trockenes Blatt, und niemand wagte es, sie ganz zu entfalten.';
      }
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('runs the two audits in parallel, then one repair, then one lector', async () => {
    const res = await refineStoryText(STORY, PAGES, { arc: 'the arc, read-only' });

    const labels = calls.map(c => c.label);
    expect(labels.filter(l => l === 'text_audit' || l === 'text_audit_blind')).toHaveLength(2);
    expect(labels.slice(0, 2).sort()).toEqual(['text_audit', 'text_audit_blind']);
    expect(labels.slice(2)).toEqual(['text_refine', 'text_lector']);
    // Both audits were open at the same time — the parallelism, not two
    // sequential calls that happen to come first.
    expect(maxConcurrent).toBe(2);

    // The deleted steps are unreachable.
    expect(labels).not.toContain('text_audit2');
    expect(labels).not.toContain('text_lector_apply');

    // Exactly one repair pass and one lector pass in the ledger.
    expect(res.rounds.map((r: any) => r.kind)).toEqual(['repair', 'lector']);

    // The audits merged to ONE finding, credited to both.
    expect(res.mergedFindings).toHaveLength(1);
    expect(res.mergedFindings[0].sources).toEqual(['arc-informed', 'blind']);
    expect(res.audits.map((a: any) => a.source)).toEqual(['arc-informed', 'blind']);

    // The lector's bounded fix landed; its overhaul of page 1 did not.
    expect(res.pages[1].text).toContain('mit der Leine');
    expect(res.pages[0].text).toBe(PAGES[0].text);
    expect(res.lectorAccepted.map((p: any) => p.pageNumber)).toEqual([2]);
    expect(res.lectorRejected.map((p: any) => p.pageNumber)).toEqual([1]);
    expect(res.changed).toEqual([2]);
  });

  it('fills every placeholder of every template in the chain', () => {
    // An unfilled {PLACEHOLDER} reaching a model is the failure mode a renamed
    // or deleted template field produces, and it is invisible in the output.
    for (const c of calls) {
      const left = c.prompt.match(/\{[A-Z][A-Z0-9_]*\}/g) || [];
      expect(left, `${c.label} left ${left.join(', ')} unfilled`).toEqual([]);
      expect(c.prompt.length).toBeGreaterThan(200);
    }
  });

  it('uses the configured model per role', () => {
    const { MODEL_DEFAULTS } = require('../../server/config/models');
    const byLabel = Object.fromEntries(calls.map(c => [c.label, c.model]));
    expect(byLabel.text_audit).toBe(MODEL_DEFAULTS.textAuditModel);
    expect(byLabel.text_audit_blind).toBe(MODEL_DEFAULTS.textAuditBlindModel);
    expect(byLabel.text_refine).toBe(MODEL_DEFAULTS.textRefineModel);
    expect(byLabel.text_lector).toBe(MODEL_DEFAULTS.textProofreadModel);
  });
});

/**
 * A stalled auditor must not hold the chain hostage. Measured on Lab #984:
 * the arc-informed audit answered in 101s while the blind grok auditor streamed
 * reasoning past 20 minutes, and with a plain Promise.all that blocks the merge,
 * the repair and the lector — and the pipeline's join then salvages nothing,
 * because the first publish() happens after the merge.
 */
describe('refineStoryText - a stalled audit is abandoned, the chain continues', () => {
  const textModels = require('../../server/lib/textModels');
  const original = textModels.callTextModelStreaming;
  const labels: string[] = [];

  const PAGES = [
    { pageNumber: 1, text: 'Die Karte ist alt und der Rand ist eingerissen.', sceneIntent: 'a map', sceneBrief: 'a map', planLine: '' },
  ];
  const STORY = { language: 'de', languageLevel: '1st-grade', pages: 1, characters: [{ id: 'c1', name: 'Alba', age: 8, isMainCharacter: true }], mainCharacters: ['c1'] };

  beforeAll(() => {
    textModels.callTextModelStreaming = async (_p: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      labels.push(label);
      // The blind auditor never answers.
      if (label === 'text_audit_blind') return new Promise(() => {});
      let text = '';
      if (label === 'text_audit') text = ['FAULT[CAUSE]: p1 — nothing says how the map tore.', 'FAULTS: 1'].join('\n');
      else if (label === 'text_refine') text = ['---ANALYSIS---', 'fixed', '---STORY TEXT---', '## Page 1', 'Die Karte ist alt, und der Rand riss beim Auspacken ein.'].join('\n');
      else if (label === 'text_lector') text = ['---STORY TEXT---', 'NONE'].join('\n');
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 10, output_tokens: 20, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('merges the audit that answered and runs repair + lector anyway', async () => {
    const res = await refineStoryText(STORY, PAGES, { auditTimeoutMs: 300 });
    const blind = res.audits.find((a: any) => a.source === 'blind');
    expect(blind.ok).toBe(false);
    expect(blind.error).toMatch(/no answer within/);
    expect(res.audits.find((a: any) => a.source === 'arc-informed').ok).toBe(true);
    expect(res.mergedFindings).toHaveLength(1);
    expect(res.rounds.map((r: any) => r.kind)).toEqual(['repair', 'lector']);
    expect(res.changed).toEqual([1]);
    expect(labels).toContain('text_lector');
  });
});
