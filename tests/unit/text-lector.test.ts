import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// @ts-ignore — CommonJS lib
const {
  refineStoryText, parseFaultLines, mergeAuditFindings,
  parseLectorFindings, applyLectorFindings, locateQuote,
} = require('../../server/lib/textRefine.js');

/**
 * THE CHAIN (owner ruling 2026-09-03): two audits in parallel → merge+dedupe →
 * ONE repair → ONE lector whose quoted-span findings are applied in code.
 *
 * Three things are tested here because three things replaced deleted machinery:
 * the merge that replaced the sequential re-audit, the code-side applier that
 * replaced the model apply pass, and the call order itself (nothing may
 * re-audit, nothing may apply findings with a second model call).
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

// ────────────── LECTOR: FINDINGS PARSED, CORRECTIONS APPLIED IN CODE ───────────

/**
 * The lines below are the REAL gemini-3.1-pro and grok-4.6 output from the
 * 6-model A/B on job_1788380714660_4p9mr11xszu (scratchpad
 * piraterun4/lector-ab/out-*.txt). Two properties have to hold for the code-side
 * applier to be safe: a line parses into page + span + replacement, and a
 * finding whose quote is not verbatim on the page it names is DROPPED, never
 * applied.
 */
const AB_GEMINI = [
  "PAGE 1: 'alt: das Papier' → 'alt: Das Papier'",
  "PAGE 3: 'Wer als Zweite ankommt' → 'Wer als Zweiter ankommt'",
  "PAGE 6: 'nicht Wrack' → 'kein Wrack'",
  "PAGE 9: 'könnte dort oben sitzen' → 'könnte dort oben liegen' (oder 'versteckt sein')",
  "PAGE 9: 'beugte den Kopf in den Nacken' → 'legte den Kopf in den Nacken'",
  "PAGE 11: 'schwamm die Leine zurück' → 'schwamm mit der Leine zurück'",
  "PAGE 11: 'schwamm er es durch die Brandung' → 'zog er es schwimmend durch die Brandung' (oder 'schwamm er damit')",
  "PAGE 13: 'fragte einmal, ruhig: «Das Buch.»' → 'fragte einmal, ruhig: «Das Buch?»'",
  "PAGE 13: 'wütend auf das verlorene Buch' → 'wütend über das verlorene Buch'",
  "PAGE 15: 'war einen Moment lang traurig für sie' → 'hatte einen Moment lang Mitleid mit ihr' (oder 'tat ihr einen Moment lang leid')",
].join('\n');

// grok-4.6 quoted the faulty span but left the correction BARE on every line.
const AB_GROK = [
  "PAGE 3: 'Wer als Zweite ankommt' → Wer als Zweiter ankommt",
  "PAGE 13: 'wütend auf das verlorene Buch' → wütend über das verlorene Buch",
  "PAGE 16: 'was jetzt am Mast hing, was ein Flickwerk' → was jetzt am Mast hing, war ein Flickwerk",
].join('\n');

describe('parseLectorFindings', () => {
  it('parses page, quoted span and replacement from the measured A/B output', () => {
    const f = parseLectorFindings(AB_GEMINI);
    expect(f).toHaveLength(10);
    expect(f[0]).toMatchObject({ pageNumber: 1, quote: 'alt: das Papier', correction: 'alt: Das Papier' });
    expect(f[5]).toMatchObject({ pageNumber: 11, quote: 'schwamm die Leine zurück' });
  });

  it('keeps only the first correction when the model offers an alternative', () => {
    const f = parseLectorFindings(AB_GEMINI);
    expect(f[3].correction).toBe('könnte dort oben liegen');
    expect(f[9].correction).toBe('hatte einen Moment lang Mitleid mit ihr');
  });

  it('reads a bare (unquoted) correction, as grok-4.6 emitted every line', () => {
    const f = parseLectorFindings(AB_GROK);
    expect(f).toHaveLength(3);
    expect(f[0]).toMatchObject({ quote: 'Wer als Zweite ankommt', correction: 'Wer als Zweiter ankommt' });
    expect(f[2].correction).toBe('was jetzt am Mast hing, war ein Flickwerk');
  });

  it('keeps guillemets inside a quoted span intact', () => {
    const f = parseLectorFindings("PAGE 13: 'fragte einmal, ruhig: «Das Buch.»' → 'fragte einmal, ruhig: «Das Buch?»'");
    expect(f[0].quote).toBe('fragte einmal, ruhig: «Das Buch.»');
    expect(f[0].correction).toBe('fragte einmal, ruhig: «Das Buch?»');
  });

  it('ignores everything that is not a finding line', () => {
    const noise = [
      'Let me work through this carefully page by page.',
      'NONE',
      '',
      "PAGE 4: 'kniete hin' → 'kniete sich hin'",
      'FAULTS: 1',
    ].join('\n');
    const f = parseLectorFindings(noise);
    expect(f).toHaveLength(1);
    expect(f[0].pageNumber).toBe(4);
  });

  it('accepts guillemet quoting, list bullets and an ASCII arrow', () => {
    const f = parseLectorFindings('- PAGE 7: «Bei erstem Tageslicht» -> «Beim ersten Tageslicht»');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ pageNumber: 7, quote: 'Bei erstem Tageslicht', correction: 'Beim ersten Tageslicht' });
  });

  it('drops a line whose correction equals the quote', () => {
    expect(parseLectorFindings("PAGE 2: 'das Boot' → 'das Boot'")).toHaveLength(0);
  });
});

describe('applyLectorFindings', () => {
  const pages = () => [
    { pageNumber: 1, text: 'Die Karte ist alt: das Papier ist dünn und der Rand ist eingerissen.' },
    { pageNumber: 11, text: 'Er schwamm die Leine zurück zum Schiff und band sie am Mast fest.' },
    { pageNumber: 15, text: 'Sie war einen Moment lang traurig für sie, dann lachte sie wieder.' },
  ];

  it('substitutes the quoted span, keeping umlauts and the rest of the page character for character', () => {
    const { pages: out, applied, dropped } = applyLectorFindings(pages(), parseLectorFindings([
      "PAGE 1: 'alt: das Papier' → 'alt: Das Papier'",
      "PAGE 15: 'war einen Moment lang traurig für sie' → 'hatte einen Moment lang Mitleid mit ihr'",
    ].join('\n')));
    expect(dropped).toHaveLength(0);
    expect(applied).toHaveLength(2);
    expect(out[0].text).toBe('Die Karte ist alt: Das Papier ist dünn und der Rand ist eingerissen.');
    expect(out[2].text).toBe('Sie hatte einen Moment lang Mitleid mit ihr, dann lachte sie wieder.');
    expect(out[1].text).toBe(pages()[1].text);
  });

  it('replaces a span the page wraps across a line break', () => {
    const wrapped = [{ pageNumber: 11, text: 'Er schwamm die\nLeine zurück zum Schiff.' }];
    const { pages: out, applied } = applyLectorFindings(wrapped, parseLectorFindings(
      "PAGE 11: 'schwamm die Leine zurück' → 'schwamm an der Leine zurück'"));
    expect(applied).toHaveLength(1);
    expect(out[0].text).toBe('Er schwamm an der Leine zurück zum Schiff.');
  });

  it('substitutes inside guillemets', () => {
    const p = [{ pageNumber: 13, text: 'Lorena fragte einmal, ruhig: «Das Buch.» Niemand antwortete.' }];
    const { pages: out, applied } = applyLectorFindings(p, parseLectorFindings(
      "PAGE 13: '«Das Buch.»' → '«Das Buch?»'"));
    expect(applied).toHaveLength(1);
    expect(out[0].text).toBe('Lorena fragte einmal, ruhig: «Das Buch?» Niemand antwortete.');
  });

  it('applies several findings on one page without shifting each other', () => {
    const p = [{ pageNumber: 1, text: 'Die Karte ist alt: das Papier ist dünn, und die Kapitänin kniete hin.' }];
    const { pages: out, applied } = applyLectorFindings(p, parseLectorFindings([
      "PAGE 1: 'alt: das Papier' → 'alt: Das Papier'",
      "PAGE 1: 'kniete hin' → 'kniete sich hin'",
    ].join('\n')));
    expect(applied).toHaveLength(2);
    expect(out[0].text).toBe('Die Karte ist alt: Das Papier ist dünn, und die Kapitänin kniete sich hin.');
  });

  it('drops the second of two findings whose spans overlap, keeping the first', () => {
    const p = [{ pageNumber: 11, text: 'Er schwamm die Leine zurück zum Schiff.' }];
    const { pages: out, applied, dropped } = applyLectorFindings(p, parseLectorFindings([
      "PAGE 11: 'schwamm die Leine zurück' → 'schwamm an der Leine zurück'",
      "PAGE 11: 'die Leine' → 'an der Leine'",
    ].join('\n')));
    expect(applied).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('overlap');
    expect(out[0].text).toBe('Er schwamm an der Leine zurück zum Schiff.');
  });

  it('drops a finding whose quote is not on the page it names — the hallucination guard', () => {
    // The measured false-positive class: a claim about two distinct cast
    // members being the same person, and a suggestion to write the eszett.
    // Neither quotes anything the page contains.
    const { pages: out, applied, dropped } = applyLectorFindings(pages(), parseLectorFindings(
      "PAGE 1: 'die Karte war grösser' → 'die Karte war groesser'"));
    expect(applied).toHaveLength(0);
    expect(dropped[0].reason).toBe('quote-absent');
    expect(out[0].text).toBe(pages()[0].text);
  });

  it('drops a finding pointing at a page the story does not have', () => {
    const { applied, dropped } = applyLectorFindings(pages(), parseLectorFindings(
      "PAGE 99: 'das Papier ist dünn' → 'das Papier war dünn'"));
    expect(applied).toHaveLength(0);
    expect(dropped[0].reason).toBe('no-such-page');
  });

  it('leaves every page alone when there are no findings', () => {
    const before = pages();
    const { pages: out, applied } = applyLectorFindings(before, []);
    expect(applied).toHaveLength(0);
    expect(out.map(p => p.text)).toEqual(before.map(p => p.text));
  });
});

describe('locateQuote', () => {
  it('returns source offsets that slice the original characters', () => {
    const text = 'Er schwamm die\nLeine zurück zum Schiff.';
    const span = locateQuote(text, 'schwamm die Leine zurück');
    expect(text.slice(span.start, span.end)).toBe('schwamm die\nLeine zurück');
  });

  it('returns null when the span is absent', () => {
    expect(locateQuote('Er schwamm zurück.', 'schwamm die Leine')).toBeNull();
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
        text = [
          "PAGE 2: 'schwamm die Leine zurück' → 'schwamm mit der Leine zurück'",
          // Quotes nothing that is on page 1 — the hallucination guard drops it.
          "PAGE 1: 'die Karte war grösser' → 'die Karte war weiter'",
        ].join('\n');
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

    // The audits merged to ONE finding, credited to both — and the word-budget
    // counter (third source, 2026-09-05) adds one FAULT[LENGTH] per page
    // outside the 1st-grade 25-50 budget (both stub pages sit under 25 words).
    expect(res.mergedFindings).toHaveLength(3);
    const transition = res.mergedFindings.find((f: any) => f.category === 'TRANSITION');
    expect(transition.sources).toEqual(['arc-informed', 'blind']);
    const counterFindings = res.mergedFindings.filter((f: any) => f.category === 'LENGTH');
    expect(counterFindings.map((f: any) => f.pageNumber)).toEqual([1, 2]);
    for (const f of counterFindings) expect(f.sources).toEqual(['counter']);
    expect(res.audits.map((a: any) => a.source)).toEqual(['arc-informed', 'blind']);

    // The lector's finding was applied IN CODE — there is no apply call in the
    // ledger — and the one quoting nothing on its page was dropped.
    expect(res.pages[1].text).toContain('mit der Leine');
    expect(res.pages[0].text).toBe(PAGES[0].text);
    expect(res.lectorFindings).toHaveLength(2);
    expect(res.lectorApplied.map((f: any) => f.pageNumber)).toEqual([2]);
    expect(res.lectorDropped.map((f: any) => f.reason)).toEqual(['quote-absent']);
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
    // One finding from the audit that answered + one from the word-budget
    // counter (the 8-word stub page is under the 1st-grade 25-word floor) —
    // the counter never stalls, so it contributes even when an auditor does.
    expect(res.mergedFindings).toHaveLength(2);
    expect(res.mergedFindings.map((f: any) => f.sources)).toEqual([['arc-informed'], ['counter']]);
    expect(res.rounds.map((r: any) => r.kind)).toEqual(['repair', 'lector']);
    expect(res.changed).toEqual([1]);
    expect(labels).toContain('text_lector');
  });
});
