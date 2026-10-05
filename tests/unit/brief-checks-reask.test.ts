/**
 * THE BRIEF CHECKS AND THE ONE RE-ASK (owner, 2026-09-28: "Jev first, then
 * remove the scene review"; answers Q2-Q4). Code checks every page brief; the
 * flagged pages go back to the Art Director's model ONCE, in one batched call;
 * each rewrite is taken only when it resolves a finding (strict) and never when
 * it drops a character the page's who column names; a decided field a rewrite
 * moved is restored. Plus the new `vb_id_label_mismatch` check on the stored
 * case. Pins behaviour, never prompt wording.
 * see docs/decisions.md 2026-09-28 "Jev first, then no scene review"
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const textModels = req('../../server/lib/textModels');
const BC = req('../../server/lib/briefChecks');
const { checkIdLabelMismatch, REVIEWABLE } = req('../../server/lib/sceneBriefCheck');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');
const { loadPromptTemplates } = req('../../server/services/prompts');

const saved = textModels.callTextModelStreaming;
afterEach(() => { textModels.callTextModelStreaming = saved; });
beforeAll(async () => { await loadPromptTemplates(); });

const meta = (m: any) => JSON.stringify({ sceneIntent: 'Ana and Ben look at the lamp.', characters: [{ name: 'Ana', looksAt: 'Ben', depth: 'foreground', expression: 'brows up, eyes wide, mouth open' }, { name: 'Ben', looksAt: 'Ana', depth: 'foreground', expression: 'brows up, eyes wide, mouth open' }], objects: ['LOC001'], shot: 'medium', timeOfDay: 'dusk', population: 'cast_only', interactions: [{ character: 'Ana', object: 'LOC001', where: 'stands on the quay', action: 'standing' }], ...m }, null, 2);
const brief = (m: any, prose = 'Ana and Ben stand on the quay at dusk, looking at each other.') => `${prose}\n\n---METADATA---\n${meta(m)}`;
const PLAN = 'medium — Ana and Ben — they look at each other — the lamp is lit';
const INPUT = { language: 'en', characters: [{ name: 'Ana' }, { name: 'Ben' }] };
const VB = { locations: [{ id: 'LOC001', name: 'quay', label: 'harbour quay', appearsInPages: [1] }] };
const fixed = { shot: 'medium', timeOfDay: 'dusk', indoor: false, cites: [], decidedIds: [], location: 'LOC001' };

function stubModel(reply: (prompt: string) => string | Error) {
  const calls: any[] = [];
  textModels.callTextModelStreaming = async (prompt: string, _s: any, _c: any, model: string, opts: any) => {
    calls.push({ prompt, model, label: opts?.usageLabel, reasoning: opts?.reasoning });
    const r = reply(prompt);
    if (r instanceof Error) throw r;
    return { text: r, modelId: model, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return calls;
}
const events: any[] = [];
const gl = { info: (k: string, m: string) => events.push(['info', k, m]), warn: (k: string, m: string) => events.push(['warn', k, m]), error: (k: string, m: string) => events.push(['error', k, m]), debug() {} };
const runOn = (expansions: any[], briefBeats: any[]) => BC.runBriefChecks({
  inputData: INPUT, expansions, briefBeats, visualBible: VB, clothingRequirements: null,
  visualBibleJson: JSON.stringify(VB), model: 'gemini-3.1-pro', gl,
});

describe('the brief checks and the one re-ask', () => {
  it('a clean book makes no model call', async () => {
    const calls = stubModel(() => 'unused');
    const report = await runOn([{ pageNumber: 1, brief: brief({ weather: 'clear' }) }], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(calls).toHaveLength(0);
    expect(report.reask).toBeNull();
    expect(report.findingsBefore).toEqual([]);
  });

  it('a flagged page is re-asked once, on the Art Director model, with its brief and its findings; a rewrite that resolves it is taken', async () => {
    const calls = stubModel(() => `## Page 1\n${brief({ weather: 'clear' })}`);
    const x = { pageNumber: 1, brief: brief({ weather: 'none' }) };
    const report = await runOn([x], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].label).toBe('beats_brief_reask');
    expect(calls[0].model).toBe('gemini-3.1-pro');
    // The slimmed context (2026-09-30): the call-2 template's own rules travel
    // with the re-ask, never the full prompt that wrote every page's brief.
    expect(calls[0].prompt).toContain('Simplify, don\'t elaborate');
    expect(calls[0].prompt).toContain('[weather_none_outdoors]');
    expect(calls[0].reasoning).toEqual({ effort: 'medium' });
    expect(report.verdicts).toEqual([expect.objectContaining({ pageNumber: 1, accepted: true })]);
    expect(extractSceneMetadata(x.brief).weather).toBe('clear');
    expect(report.findingsAfter).toEqual([]);
    expect(report.pages.map((p: any) => p.pageNumber)).toEqual([1]);
  });

  it('strict: a rewrite that resolves nothing is refused and the page keeps its brief, flagged', async () => {
    stubModel(() => `## Page 1\n${brief({ weather: 'none' }, 'A different prose.')}`);
    const x = { pageNumber: 1, brief: brief({ weather: 'none' }) };
    const before = x.brief;
    const report = await runOn([x], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(report.verdicts[0].accepted).toBe(false);
    expect(x.brief).toBe(before);
    expect(report.survived.map((f: any) => f.type)).toEqual(['weather_none_outdoors']);
  });

  it('a rewrite that drops a character the who column names is refused, whatever it resolved', async () => {
    const onlyAna = brief({ weather: 'clear', characters: [{ name: 'Ana', looksAt: 'away', depth: 'foreground', expression: 'brows up, eyes wide, mouth open' }] }, 'Ana stands on the quay at dusk.');
    stubModel(() => `## Page 1\n${onlyAna}`);
    const x = { pageNumber: 1, brief: brief({ weather: 'none' }) };
    const before = x.brief;
    events.length = 0;
    const report = await runOn([x], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(report.verdicts[0].accepted).toBe(false);
    expect(report.verdicts[0].reason).toMatch(/drops Ben/);
    expect(x.brief).toBe(before);
    expect(events.some(e => e[0] === 'error' && e[1] === 'beats_brief_reask_who_dropped')).toBe(true);
  });

  it('the re-ask writes no decided field: code merges the FIXED shot into the accepted rewrite, and a stray one is overwritten', async () => {
    stubModel(() => `## Page 1\n${brief({ weather: 'clear', shot: 'wide' })}`);
    const x = { pageNumber: 1, brief: brief({ weather: 'none' }) };
    events.length = 0;
    const report = await runOn([x], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(report.verdicts[0].accepted).toBe(true);
    const m = extractSceneMetadata(x.brief) || {};
    expect((m.fullData || m).shot).toBe('medium');
    // Nothing is "disobeyed" any more: the merge is the assembly (decisions.md 2026-10-05).
    expect(events.some(e => e[1] === 'beats_jev_field_disobeyed')).toBe(false);
  });

  it('a failed re-ask ships the briefs as written, flagged — never a failed story, never a second call', async () => {
    const calls = stubModel(() => new Error('provider 503'));
    const x = { pageNumber: 1, brief: brief({ weather: 'none' }) };
    const before = x.brief;
    events.length = 0;
    const report = await runOn([x], [{ pageNumber: 1, planLine: PLAN, jevFixed: fixed }]);
    expect(calls).toHaveLength(1);
    expect(x.brief).toBe(before);
    expect(report.reask.failed).toMatch(/provider 503/);
    expect(events.some(e => e[0] === 'error' && e[1] === 'beats_brief_reask_failed')).toBe(true);
  });

  it('on a page whose fields Jev decided, the field-owned types are withheld from the re-ask', () => {
    const b = brief({ weather: 'clear', shot: 'medium' });
    const beats = [{ pageNumber: 1, planLine: 'close-up — Ana and Ben — they look at each other — the lamp is lit', jevFixed: fixed }];
    const r = BC.collectBriefFindings([{ pageNumber: 1, brief: b }], { inputData: INPUT, clothingRequirements: null, visualBible: VB, briefBeats: beats });
    expect(r.findings.some((f: any) => BC.JEV_OWNED.has(f.type))).toBe(false);
  });
});

describe('the "wearing no clothing" kind reaches the re-ask (Q7)', () => {
  it('a page whose prose never names a character\'s outfit is sent as outfit_missing', () => {
    const reqs = { Ana: { standard: { used: true, description: 'red wool sweater; blue denim jeans; white canvas sneakers' } }, Ben: { standard: { used: true, description: 'green hooded raincoat; grey corduroy trousers; brown leather boots' } } };
    const b = brief({ weather: 'clear', characters: [{ name: 'Ana', clothing: 'standard', looksAt: 'Ben' }, { name: 'Ben', clothing: 'standard', looksAt: 'Ana' }] },
      'Ana in her red wool sweater, blue denim jeans and white canvas sneakers stands on the quay; Ben stands beside her in his standard clothes.');
    const r = BC.collectBriefFindings([{ pageNumber: 1, brief: b }], { inputData: INPUT, clothingRequirements: reqs, visualBible: VB, briefBeats: [{ pageNumber: 1, planLine: PLAN }] });
    const missing = r.findings.filter((f: any) => f.type === 'outfit_missing');
    expect(missing.map((f: any) => f.character)).toEqual(['Ben']);
    expect(BC.REASK_CLOTHING_EXTRA.has('outfit_missing')).toBe(true);
  });
});

describe('cover-only findings ship flagged, never reach the re-ask (owner, 2026-09-30)', () => {
  const coverPlan = 'medium — Ana and Ben — the cover moment — nothing changes';

  it('a cover page whose only fault is cover_cast_dropped makes no model call', async () => {
    const calls = stubModel(() => 'unused');
    // The cover's plan line names a cast the brief does not cite — a cover fault, cover-only.
    const x = { pageNumber: -2, brief: brief({ weather: 'clear' }) };
    const report = await runOn([x], [{ pageNumber: -2, planLine: coverPlan, jevFixed: fixed }]);
    expect(calls).toHaveLength(0);
    expect(report.reask).toBeNull();
    expect(report.coverOnlyShipped.map((f: any) => f.type).sort()).toEqual(['cover_cast_dropped']);
    expect(BC.COVER_ONLY_TYPES.has('cover_cast_dropped')).toBe(true);
    // The gaze is code's on a cover (jevFixed.looksAtAll): no check, no finding type.
    expect(BC.COVER_ONLY_TYPES.has('cover_gaze_not_viewer')).toBe(false);
  });

  it('a cover page with both a cover-only and a non-cover finding sends only the non-cover one to the re-ask', async () => {
    const x = { pageNumber: -2, brief: brief({ weather: 'none' }) };
    const calls = stubModel(() => `## Page -2\n${brief({ weather: 'clear' })}`);
    const report = await runOn([x], [{ pageNumber: -2, planLine: coverPlan, jevFixed: fixed }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('[weather_none_outdoors]');
    expect(calls[0].prompt).not.toContain('[cover_cast_dropped]');
    expect(report.coverOnlyShipped.some((f: any) => f.type === 'cover_cast_dropped')).toBe(true);
    expect(report.verdicts[0].accepted).toBe(true);
  });
});

describe('vb_id_label_mismatch — an id written with another element\'s label', () => {
  // Staging job_1790529840433_ar4u7qry3, covers -1/-2/-3: the prose wrote the
  // kite reel's id with the sash's name.
  const bible = { artifacts: [{ id: 'ART002', name: 'kite reel', label: 'kite reel' }, { id: 'ART004', name: 'black sash', label: 'black Piratentuch' }] };
  it('names the entry the label belongs to', () => {
    const f = checkIdLabelMismatch({ pageNumber: -1, brief: 'Emma wears her striped undershirt, trousers, ART002 (black Piratentuch), boots and bandana.\n\n---METADATA---\n{}' }, bible);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: 'vb_id_label_mismatch', id: 'ART002', named: 'ART004' });
    expect(REVIEWABLE.has('vb_id_label_mismatch')).toBe(true);
  });
  it('is silent when the label is the id\'s own, or names no single entry', () => {
    expect(checkIdLabelMismatch({ pageNumber: 1, brief: 'She winds ART002 (kite reel) tight.' }, bible)).toEqual([]);
    expect(checkIdLabelMismatch({ pageNumber: 1, brief: 'She holds ART002 (the thing).' }, bible)).toEqual([]);
    expect(checkIdLabelMismatch({ pageNumber: 1, brief: 'She holds the black Piratentuch (ART004).' }, bible)).toEqual([]);
  });
});
