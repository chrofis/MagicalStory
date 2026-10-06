import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Jev wired into the text chain (owner, 2026-09-27: "slop + logic/arc
 * rewrites"). What this pins:
 *   - Jev is a third auditor in refineStoryText: its FAULT lines join
 *     mergeAuditFindings and reach the ONE repair pass, which is sent only
 *     the pages they name;
 *   - a Jev failure is an ERROR and the source contributes nothing — no
 *     partial Jev findings, the ß / «» / suddenly checks included;
 *   - an unevaluated language is reported as not run, never silently skipped;
 *   - rejected checks (grammar, appears-without-setup, object continuity,
 *     plan MATCH, shot) are never asked; the cast-beat check is not asked here;
 *   - the writer's STYLE_RULEBOOK carries every slop rule Jev judges;
 *   - the arc cast check never opens the re-tell gate; it is feedback for the
 *     re-telling when the gate opens on its own findings.
 */
// @ts-ignore CommonJS
const textModels = require('../../server/lib/textModels');
// @ts-ignore CommonJS
const { refineStoryText } = require('../../server/lib/textRefine.js');
// @ts-ignore CommonJS
const J = require('../../server/lib/jevAudit');
// @ts-ignore CommonJS
const { SLOP_TYPES, SLOP_RULES } = require('../../server/lib/proseSlop');
// @ts-ignore CommonJS
const PB = require('../../server/lib/promptBuilders');

const PAGES = [
  { pageNumber: 1, text: 'Mia ging in den Garten. Sie suchte den Ball.', sceneIntent: 'garden', sceneBrief: 'garden', planLine: 'wide — Mia — Mia looks for the ball — the search begins' },
  { pageNumber: 2, text: 'Ihr Herz schwoll vor Stolz. Plötzlich lachte sie, und plötzlich rannte sie.', sceneIntent: 'garden', sceneBrief: 'garden', planLine: 'medium — Mia — Mia finds the ball — found' },
  { pageNumber: 3, text: 'Am Abend ging Mia nach Hause.', sceneIntent: 'home', sceneBrief: 'home', planLine: 'wide — Mia — Mia walks home — the end' },
];
const STORY = { language: 'de-ch', languageLevel: 'standard', pages: 3, characters: [{ id: 'c1', name: 'Mia', age: 6, isMainCharacter: true }], mainCharacters: ['c1'] };

/** Jev stub: page 2 has a body cliché, everything else is clean. */
function jevStub(log: any[]) {
  return async ({ state, questions }: any) => {
    log.push({ state, ids: Object.keys(questions) });
    const answers: any = {};
    for (const id of Object.keys(questions)) {
      const hit = id === 'SLOP_BODY_CLICHE' && state.includes('Herz schwoll');
      answers[id] = { type: 'noul', noul: hit ? 0.97 : 0.02 };
    }
    return { answers, cost: 0.00001 };
  };
}

describe('Jev in the text chain', () => {
  const original = textModels.callTextModelStreaming;
  const prompts: Record<string, string> = {};
  beforeAll(() => {
    textModels.callTextModelStreaming = async (prompt: string, _m: number, _i: unknown, model: string, opts: any = {}) => {
      const label = String(opts.usageLabel || '');
      prompts[label] = String(prompt || '');
      let text = '';
      if (label === 'text_audit' || label === 'text_audit_blind') text = 'FAULTS: 0';
      else if (label === 'text_refine') text = '---ANALYSIS---\nnone\n---STORY TEXT---\nNONE';
      return { text, modelId: `stub-${model}`, usage: { input_tokens: 1, output_tokens: 1, direct_cost: 0 } };
    };
  });
  afterAll(() => { textModels.callTextModelStreaming = original; });

  it('its flags reach the one repair pass, for the flagged page only', async () => {
    const calls: any[] = [];
    const res = await refineStoryText(STORY, PAGES, { jevOptions: { callImpl: jevStub(calls) } });
    const jev = res.audits.find((a: any) => a.source === 'jev');
    expect(jev).toMatchObject({ ok: true, modelKey: J.JEV_MODEL });
    const fromJev = res.mergedFindings.filter((f: any) => f.sources.includes('jev'));
    expect(fromJev.map((f: any) => [f.pageNumber, f.category])).toEqual([[2, 'SLOP'], [2, 'MECH']]);
    expect(fromJev[0].text).toContain('[SLOP_BODY_CLICHE]');
    expect(fromJev[1].text).toContain('[MECH_SUDDENLY]');
    // The repair prompt carries the Jev lines verbatim.
    expect(prompts.text_refine).toContain('FAULT[SLOP]: p2 — [SLOP_BODY_CLICHE]');
    expect(prompts.text_refine).toContain('FAULT[MECH]: p2 — [MECH_SUDDENLY]');
    // Only the adopted questions were asked: slop, the three logic checks, the plan contradiction.
    const asked = new Set(calls.flatMap(c => c.ids));
    for (const id of ['GRAM_ANY', 'LOGIC_APPEAR', 'LOGIC_OBJECT', 'ARC_PAGE_MATCH', 'ARC_CAST_BEAT', 'SHOT_TYPE']) expect(asked.has(id)).toBe(false);
    for (const id of ['SLOP_BODY_CLICHE', 'LOGIC_VANISH', 'LOGIC_ANIMAL', 'LOGIC_MOTIVE', 'ARC_PAGE_CONTRADICT']) expect(asked.has(id)).toBe(true);
    // The plan line reached Jev without its shot token.
    const planQ = calls.find(c => c.ids.includes('ARC_PAGE_CONTRADICT'));
    expect(planQ).toBeTruthy();
  });

  it('a Jev failure is loud and contributes nothing, the string checks included', async () => {
    const fail = async () => { throw new Error('jevAudit: HTTP 503: upstream down'); };
    const res = await refineStoryText(STORY, PAGES, { jevOptions: { callImpl: fail } });
    const jev = res.audits.find((a: any) => a.source === 'jev');
    expect(jev).toMatchObject({ ok: false, error: 'jevAudit: HTTP 503: upstream down', faults: 0 });
    expect(res.mergedFindings.filter((f: any) => f.sources.includes('jev'))).toEqual([]);
    // page 2 has "plötzlich" twice, yet no MECH line: the source failed as a whole
    expect(res.mergedFindings.find((f: any) => f.category === 'MECH')).toBeUndefined();
  });

  it('a language the evaluation did not cover is reported as not run', async () => {
    const calls: any[] = [];
    const res = await refineStoryText({ ...STORY, language: 'it' }, PAGES, { jevOptions: { callImpl: jevStub(calls) } });
    const jev = res.audits.find((a: any) => a.source === 'jev');
    expect(jev.ok).toBe(false);
    expect(jev.error).toMatch(/^not run: language "it"/);
    expect(calls).toEqual([]);
  });
});

describe('runJevTextSource', () => {
  it('turns the $0 string checks into MECH lines', () => {
    expect(J.mechanicalFaultLines([{ pageNumber: 3, questionId: 'MECH_ESZETT', evidence: 'Straße' }]))
      .toEqual(['FAULT[MECH]: p3 — [MECH_ESZETT] Swiss German never writes ß: «Straße» takes ss.']);
  });
  it('drops the shot token of a plan line', () => {
    expect(J.planLineForJev('over-the-shoulder — Julian — Julian finds the egg — found')).toBe('Julian — Julian finds the egg — found');
    expect(J.planLineForJev('Julian finds the egg')).toBe('Julian finds the egg');
    expect(J.planLineForJev('')).toBe('');
  });
});

describe('the Jev cast check in the arc machine: feedback for the one re-telling, never a gate', () => {
  // Owner, 2026-09-27: "There is one arc rewrite, add it as feedback there."
  const ARC_BLOCK = 'STORY LOGIC:\nWANT: the egg\n\nFINAL ARC:\n1. Levin finds an egg.\n2. Julian carries it.\n3. They bring it home.';
  const stub = (scores: Record<string, number>) => async ({ state, questions }: any) => {
    expect(state.startsWith('1. Levin')).toBe(true);
    const answers: any = {};
    for (const [id, q] of Object.entries(questions) as any) {
      const name = Object.keys(scores).find(n => q.instructions.includes(`, ${n} does`));
      answers[id] = { type: 'noul', noul: scores[name as string] };
    }
    return { answers, cost: 0 };
  };
  // A panelist's real MAJOR issue, quoting the arc — what opens the gate on its own.
  const MAJOR_PANEL = [{ letter: 'A', findings: PB.filterPanelFindings('1. [MAJOR] (s2) CAUSE: "Julian carries it" has no reason. Smallest change: give one.', ARC_BLOCK).findings }];

  it('a weak name alone does NOT open the gate; the flag is recorded report-only', async () => {
    const { gate, jevCast } = await J.arcRepairFindingsWithCastCheck(
      { critique: '', reviewedArc: ARC_BLOCK, panel: [], castNames: ['Levin', 'Julian', 'Max'] },
      { callImpl: stub({ Levin: 0.95, Julian: 0.9, Max: 0.1 }) },
    );
    expect(gate.retell).toBe(false);
    expect(gate.text).not.toContain('Max');
    expect(jevCast).toMatchObject({ ok: true, delivered: 'report-only', weak: [{ name: 'Max', score: 0.1 }] });
  });

  it('when the gate opens on its own findings, the weak names ride into the re-tell prompt as feedback', async () => {
    expect(MAJOR_PANEL[0].findings).toHaveLength(1);
    const { gate, jevCast } = await J.arcRepairFindingsWithCastCheck(
      { critique: '', reviewedArc: ARC_BLOCK, panel: MAJOR_PANEL, castNames: ['Levin', 'Julian', 'Max'] },
      { callImpl: stub({ Levin: 0.95, Julian: 0.2, Max: 0.1 }) },
    );
    expect(gate.retell).toBe(true);
    expect(gate.count).toBe(1); // the cast flag is not counted as an issue
    expect(jevCast.delivered).toBe('retell');
    expect(gate.text).toContain(J.CAST_FEEDBACK_HEADING);
    expect(gate.text).toContain('- Julian is a child on the character list');
    expect(gate.text).toContain('- Max is a child on the character list');
    // …and it reaches the built re-tell prompt, in the section the re-telling repairs from.
    await require('../../server/services/prompts').loadPromptTemplates();
    const prompt = PB.buildArcRetellPrompt({ characters: [{ name: 'Levin' }, { name: 'Julian' }, { name: 'Max' }], language: 'de', pages: 10 }, 10, ARC_BLOCK, gate.text);
    expect(prompt).toContain('- Max is a child on the character list');
  });

  it('all names acting: no feedback even with the gate open', async () => {
    const { gate, jevCast } = await J.arcRepairFindingsWithCastCheck(
      { critique: '', reviewedArc: ARC_BLOCK, panel: MAJOR_PANEL, castNames: ['Levin', 'Julian'] },
      { callImpl: stub({ Levin: 0.95, Julian: 0.9 }) },
    );
    expect(gate.retell).toBe(true);
    expect(gate.text).not.toContain(J.CAST_FEEDBACK_HEADING);
    expect(jevCast.delivered).toBe(null);
  });

  it('a Jev failure: the gate decides as without it, the failure is recorded', async () => {
    const { gate, jevCast } = await J.arcRepairFindingsWithCastCheck(
      { critique: '', reviewedArc: ARC_BLOCK, panel: MAJOR_PANEL, castNames: ['Levin'] },
      { callImpl: async () => { throw new Error('down'); } },
    );
    expect(gate.retell).toBe(true);
    expect(gate.text).not.toContain(J.CAST_FEEDBACK_HEADING);
    expect(jevCast).toMatchObject({ ok: false, error: 'down' });
  });

  it('no names, no call', async () => {
    expect(await J.jevCastBeatVoice(ARC_BLOCK, [], { callImpl: async () => { throw new Error('no call'); } })).toBe(null);
  });
});

describe('generator side: the writer is told every slop rule Jev judges', () => {
  it('STYLE_RULEBOOK carries every SLOP_RULES line', () => {
    for (const r of SLOP_RULES) expect(PB.STYLE_RULEBOOK).toContain(r);
  });
  it('every slop type Jev asks has a writer rule, here or an existing rulebook line', () => {
    for (const t of SLOP_TYPES) {
      expect(Boolean(t.rule) || Boolean(t.coveredBy), t.id).toBe(true);
      expect(Object.keys(J.buildSlopQuestions())).toContain(t.id);
    }
  });
});

describe('the built writer prompts carry the slop rules (real builders)', () => {
  const story = { characters: [{ name: 'Mara', age: 7, isMain: true }], language: 'de', pages: 4, storyDetails: 'A day at the lake.' };
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });
  it('beats writer, trial writer and the text repair', () => {
    const built = {
      beats: PB.buildStoryTextFromBeatsPrompt(story, [{ pageNumber: 1, planLine: 'wide — Mara — Mara pulls the rope — the sail is up' }], [], 'An arc.'),
      trial: PB.buildTrialStoryPrompt(story, 4),
      refine: PB.buildTextRefinePrompt(story, [{ pageNumber: 1, text: 'Mara zog am Seil.' }], 'FAULT[SLOP]: p1 — [SLOP_BODY_CLICHE] x', '1. An arc.'),
    };
    for (const [name, p] of Object.entries(built)) {
      expect(p, name).toBeTruthy();
      for (const r of SLOP_RULES) expect(p.includes(r), `${name}: ${r.slice(0, 40)}`).toBe(true);
    }
  });
});
