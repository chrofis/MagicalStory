/**
 * THE JEV-OUTAGE BACKUP, end to end (owner, 2026-09-27: "Can we keep today's
 * setup as backup if Jev is down?" — an explicit exception to NO FALLBACKS).
 *
 * Runs the real beats pipeline — arc machine, plan, plan check, re-plan, shots,
 * wardrobe, the Art Director's two calls (Visual Bible, then the page briefs),
 * the brief checks and their one re-ask — with every text model mocked and Jev
 * DOWN, and stops in front of the page text. No scene review runs on either
 * path since 2026-09-28 ("Jev first, then remove the scene review"). Pins that the backup path is the
 * planner-authored setup, that the switch is logged and stored once, and that
 * a story that loses Jev half-way keeps what was decided and hands the rest to
 * the planner / Art Director. This test is what keeps the backup from rotting.
 * see docs/decisions.md 2026-09-27 "Jev outage: wait, then today's setup as backup"
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const textModels = require('../../server/lib/textModels.js');
const jevAudit = require('../../server/lib/jevAudit.js');
const JD = require('../../server/lib/jevDecisions.js');
const SV = require('../../server/lib/shotVocabulary.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

const realStreaming = textModels.callTextModelStreaming;
const realJev = jevAudit.callJev;
const realWait = JD.JEV_OUTAGE.waitMs;
afterEach(() => { textModels.callTextModelStreaming = realStreaming; jevAudit.callJev = realJev; JD.JEV_OUTAGE.waitMs = realWait; });
beforeAll(async () => { await loadPromptTemplates(); });

const LOGIC = [
  'STORY LOGIC:',
  'Want and stakes: Mila wants to bring the lost egg home before night.',
  'Opposition: the cold.',
  'Facts:',
  '- Mila (commissioned) — can carry the egg',
  '- Ben (commissioned) — can climb',
  '- An egg left cold does not hatch.',
  'Central figure: none',
  'Chain:',
  '- because the egg is cold, Mila carries it home',
].join('\n');
const CREATE = [LOGIC, '', 'ARC:', '1. Mila and Ben find a lost egg.', '2. Ben climbs to the nest.', '3. Mila carries the egg up.', '4. They watch it hatch.',
  'CRITIQUE:', 'Logic:', '- none', 'Faults:', '1. [MINOR] (s4) quiet — "They watch it hatch"'].join('\n');
const PLAN_LINES = (shot: string) => [
  `Page 1: ${shot} — Mila and Ben — Mila lifts a lost egg from the grass — they have the egg`,
  `Page 2: ${shot} — Ben — Ben climbs the tree to the nest — the nest is found`,
  `Page 3: ${shot} — Mila — Mila carries the egg up in her scarf — the egg is safe`,
  `Page 4: ${shot} — Mila and Ben — they lean over the nest as the egg cracks — the chick is out`,
];
const PLAN_REPLY = (shot: string) => ['---CAST---', 'Mila — deed page 3: carries the egg up, alone — also on pages 1, 4', 'Ben — deed page 2: climbs to the nest, alone — also on pages 1, 4', 'Ending page 4: Mila, Ben', '---PAGE PLAN---', ...PLAN_LINES(shot)].join('\n');
const CHECK_REPLY = ['ROSTER 1: people=Mila, Ben', 'ROSTER 2: people=Ben', 'ROSTER 3: people=Mila', 'ROSTER 4: people=Mila, Ben', 'ACTION Mila: sentence 3, page 3', 'ACTION Ben: sentence 2, page 2'].join('\n');
const brief = (n: number) => [`## Page ${n}`, `Mila and Ben by the tree on page ${n}.`, '', '---METADATA---',
  JSON.stringify({ sceneIntent: `page ${n}`, characters: [{ name: 'Mila', looksAt: 'Ben' }, { name: 'Ben', looksAt: 'Mila' }], shot: 'medium', objects: ['LOC001'], timeOfDay: 'evening', weather: 'clear', population: 'cast_only' })].join('\n');
const VB_REPLY = ['---VISUAL BIBLE---', '```json', JSON.stringify({ locations: [{ id: 'LOC001', name: 'the old oak', description: 'a big oak', pages: [1, 2, 3, 4] }], animals: [], secondaryCharacters: [], artifacts: [], vehicles: [], clothing: [] }), '```', ''].join('\n');
const AD_REPLY = [1, 2, 3, 4].map(brief).join('\n\n');

async function run(jevImpl: any) {
  const prompts: Record<string, string> = {};
  const labels: string[] = [];
  textModels.callTextModelStreaming = async (p: string, _m: any, _c: any, model: string, opts: any) => {
    const label = opts?.usageLabel || '';
    labels.push(label);
    prompts[label] = p;
    const text = label === 'arc_create' ? CREATE
      : label === 'arc_panel' ? '1. [MINOR] (s1) SENSE: fine — "Mila and Ben find a lost egg."'
        : label === 'arc_hints' ? 'ISSUE: x → CHANGE: y'
          : label === 'beats_plan' || label === 'beats_replan' ? PLAN_REPLY(/first field is always the word/.test(p) ? SV.PLAN_SHOT_PLACEHOLDER : 'medium')
            : /plan_(re)?check/.test(label) ? CHECK_REPLY
              : label === 'beats_visual_bible' ? VB_REPLY
                : /scene_expansion|brief_reask/.test(label) ? AD_REPLY
                  : '';
    return { text, usage: { output_tokens: 10 }, stop_reason: 'end_turn', modelId: 'mock', truncation: null };
  };
  const jevCalls: any[] = [];
  jevAudit.callJev = async (req: any) => { jevCalls.push(req); return jevImpl(req); };
  const stop = new Error('stop before the page text');
  const events: { level: string; key: string; msg: string; data: any }[] = [];
  // Stop once the brief checks (and their one re-ask) have run: the page text is next.
  const checkCancellation = async () => { if (events.some(e => /^beats_brief_(checks|reask)$/.test(e.key) && e.level === 'info' && /re-ask by|every brief clean/.test(e.msg))) throw stop; };
  const genLog = {
    info: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'info', key, msg, data }),
    warn: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'warn', key, msg, data }),
    error: (key: string, msg: string, _x: any, data: any) => events.push({ level: 'error', key, msg, data }),
    debug: () => {},
  };
  const { generateStoryViaBeats } = require('../../server/lib/beatsPipeline.js');
  const inputData = {
    language: 'en', languageLevel: 'standard', ageRange: '4-6', pages: 4, storyType: 'adventure', coverTypes: [],
    characters: [{ id: 1, name: 'Mila', age: 5, gender: 'female', isMainCharacter: true }, { id: 2, name: 'Ben', age: 6, gender: 'male' }],
  };
  await expect(generateStoryViaBeats(inputData, { checkCancellation, genLog })).rejects.toBe(stop);
  return { prompts, labels, events, jevCalls };
}

const answerAll = (req: any) => ({ answers: Object.fromEntries(Object.keys(req.questions).map(k => [k, { noul: 0.9 }])), cost: 0, model: 'stub', usage: {} });

describe('Jev down before the story starts: the whole story runs the backup', () => {
  it('the probe fails once, the switch is logged at error level, and the planner authors the shots under the pre-Jev rules', async () => {
    const r = await run(async () => { throw new Error('jevAudit: HTTP 503: upstream down'); });
    const fb = r.events.filter(e => e.key === 'jev_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].level).toBe('error');
    expect(fb[0].data.step).toBe('start');
    expect(r.jevCalls).toHaveLength(1);                                             // the probe, nothing else
    // The planner: the pre-Jev shot rules, real shot words.
    expect(r.prompts.beats_plan).toContain(SV.shotDistributionPhrase(4));
    expect(r.prompts.beats_plan).not.toContain('first field is always the word');
    expect(r.prompts.beats_plan).toContain('Page <N>: <shot> —');
    // The checker: the pre-Jev header and Q14 back in.
    expect(r.prompts.plan_check).toContain('One line per page: shot — who is in frame');
    expect(r.prompts.plan_check).toMatch(/^14\. Over-the-shoulder\./m);
    // The counters: the shot counters run on the planner's shots (4 × medium).
    const check = r.events.find(e => e.key === 'plan_check' && e.data && e.data.counterFindings);
    expect(check.data.counterFindings.join('\n')).toMatch(/SHOT_MEDIUM_WIDE_EXCESS/);
    // No Jev step ran; the Art Director gets no FIXED block and no decided-fields rule.
    expect(r.events.some(e => /^beats_jev_(shots|light|brief_fields|cast_cuts)$/.test(e.key))).toBe(false);
    expect(r.prompts.beats_visual_bible).toBeTruthy();
    expect(r.prompts.beats_scene_expansion).not.toContain('FIXED');
    expect(r.prompts.beats_scene_expansion).not.toContain(JD.JEV_FIXED_FIELDS_RULE);
    // The backup runs the checks and at most one re-ask, never the scene review.
    expect(r.labels.some(l => /scene_review/.test(l))).toBe(false);
    expect(r.labels.filter(l => l === 'beats_brief_reask').length).toBeLessThanOrEqual(1);
  });
});

describe('Jev lost half-way: what was decided stays, the rest goes to the backup', () => {
  it('the probe answers, the shot calls fail after the wait: the plan keeps the placeholder and the Art Director picks the shots', async () => {
    JD.JEV_OUTAGE.waitMs = 30;
    // The probe and the challenge draw (jevSelection, one call of c<id> nouls) answer; the shot calls fail.
    const r = await run(async (req: any) => { if (!Object.keys(req.questions).some(k => /^S\d$/.test(k))) return answerAll(req); throw new Error('jevAudit: HTTP 502: bad gateway'); });
    const fb = r.events.filter(e => e.key === 'jev_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].data.step).toBe('shots');
    expect(r.prompts.beats_plan).toContain('first field is always the word');       // the plan was written for Jev
    expect(r.prompts.beats_scene_expansion).toContain(`PLAN: ${SV.PLAN_SHOT_PLACEHOLDER} —`);
    expect(r.prompts.beats_scene_expansion).toContain(JD.JEV_BACKUP_SHOT_RULE);
    expect(r.prompts.beats_scene_expansion).not.toContain('FIXED');                  // no later Jev step ran
    expect(r.labels.some(l => /scene_review/.test(l))).toBe(false);
    // Before the shots only the probe and the challenge ranking asked Jev anything.
    const selection = (c: any) => c.questions.PROBE || Object.keys(c.questions).every(k => /^c\d+$/.test(k));
    expect(r.jevCalls.filter((c: any) => Object.keys(c.questions).every(k => /^c\d+$/.test(k)))).toHaveLength(1);
    expect(r.jevCalls.filter((c: any) => !selection(c)).every((c: any) => Object.keys(c.questions).some(k => /^S\d$/.test(k)))).toBe(true);
  });

  it('Jev live throughout: no switch, every decided step runs', async () => {
    const r = await run(async (req: any) => {
      const answers: any = {};
      for (const [k, q] of Object.entries<any>(req.questions)) {
        if (q.type === 'noul') answers[k] = { noul: 0.6 };
        else { const keys = Object.keys(q.criteria); answers[k] = { choice: keys[0], probabilities: Object.fromEntries(keys.map((x, i) => [x, i ? 0.1 : 0.9])) }; }
      }
      return { answers, cost: 0, model: 'stub', usage: {} };
    });
    expect(r.events.some(e => e.key === 'jev_fallback')).toBe(false);
    for (const key of ['beats_jev_shots', 'beats_jev_light', 'beats_jev_brief_fields', 'jev_challenge_selection']) expect(r.events.some(e => e.key === key), key).toBe(true);
    // The arc is offered Jev's draw: 12 catalogue lines.
    expect((r.prompts.arc_create.match(/^- \[C\d+\]/gm) || []).length).toBe(12);
    // Every decided field reaches the page-brief call BEFORE it writes (2026-09-28).
    expect(r.prompts.beats_scene_expansion).toContain('FIXED — copy each into METADATA exactly');
    expect(r.prompts.beats_scene_expansion).toContain('- timeOfDay: ');
    expect(r.prompts.beats_scene_expansion).toContain('- objects: LOC001');
    expect(r.prompts.beats_scene_expansion).toContain(JD.JEV_FIXED_FIELDS_RULE);
    // The Visual Bible call came first and carries no FIXED block.
    expect(r.labels.indexOf('beats_visual_bible')).toBeLessThan(r.labels.indexOf('beats_scene_expansion'));
    expect(r.prompts.beats_visual_bible).not.toContain('FIXED —');
    expect(r.labels.some(l => /scene_review/.test(l))).toBe(false);
  });
});
