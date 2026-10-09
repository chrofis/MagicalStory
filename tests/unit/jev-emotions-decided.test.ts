/**
 * EACH FIGURE'S EMOTION IS JEV'S (owner, 2026-10-09: "Metadata and review should come from Jev where
 * possible"). One Jev call per story picks every figure's emotion from the closed list; the Art Director
 * copies it from the page's FIXED block and draws `expression` to show it; code pins it into the brief.
 * Measured: 158/211 = 74.9% against the Art Director's 60.7% (docs/decisions.md 2026-10-09
 * "Jev decides each figure's emotion before the briefs", evals/results/results.jsonl).
 * Pins behaviour (what is asked once, what is written where, what the Art Director is no longer asked), never wording.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const JD = req('../../server/lib/jevDecisions');
const PB = req('../../server/lib/promptBuilders');
const { EMOTIONS, EMOTION_MOOD } = req('../../server/lib/emotionVocabulary');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');
const { assembleBriefs } = req('../../server/lib/jevBriefFields');
const { checkEmotionEnum } = req('../../server/lib/sceneBriefCheck');
const { loadPromptTemplates } = req('../../server/services/prompts');

const metaOf = (b: string) => { const m = extractSceneMetadata(b) || {}; return m.fullData || m; };
// A stored-shape brief: what the Art Director wrote BEFORE this change (every figure carries an emotion of its own).
const storedBrief = `Ana kneels by the dragon.\n\n---METADATA---\n${JSON.stringify({
  characters: [
    { name: 'Ana', clothing: 'standard', depth: 'foreground', looksAt: 'ANI001', expression: 'brows up, eyes wide', emotion: 'happy' },
    { name: 'Ben', clothing: 'standard', depth: 'midground', looksAt: 'Ana', expression: 'calm, eyes steady', emotion: 'neutral' },
  ],
  creatures: [{ id: 'ANI001', depth: 'midground', looksAt: 'Ana', expression: 'brows level, eyes wide', emotion: 'neutral' }],
  shot: 'medium', objects: ['LOC001', 'ANI001'], timeOfDay: 'dusk', weather: 'clear',
}, null, 2)}`;

const pages = [1, 2].map(n => ({ pageNumber: n, planLine: `wide — Ana and Ben — she does thing ${n} — change ${n}` }));
const perPage = [
  { pageNumber: 1, figures: [{ key: 'Ana', label: 'Ana' }, { key: 'ANI001', label: 'Drako' }] },
  { pageNumber: 2, figures: [{ key: 'Ana', label: 'Ana' }, { key: 'Ben', label: 'Ben' }] },
];
/** A Jev stand-in that answers each emotion question with `pick(instructions)`. */
const stub = (pick: (q: string) => string) => {
  const calls: any[] = [];
  const impl = async ({ state, questions }: any) => {
    calls.push({ state, questions });
    return { answers: Object.fromEntries(Object.entries<any>(questions).map(([id, q]) => [id, { choice: pick(q.instructions), probabilities: {} }])), cost: 0, model: 'stub', usage: {} };
  };
  return { impl, calls };
};

describe('decideEmotions: one call per story, over the closed list', () => {
  it('asks every figure of every page in ONE call, with the measured wording and the vocabulary\'s own descriptions', async () => {
    const s = stub(q => (/Drako/.test(q) ? 'surprised' : /page 2/.test(q) ? 'afraid' : 'happy'));
    const d = await JD.decideEmotions({ arc: '1. Ana meets a dragon.', pages, perPage }, { callImpl: s.impl });
    expect(s.calls).toHaveLength(1);
    const qs = Object.values<any>(s.calls[0].questions);
    expect(qs).toHaveLength(4);
    for (const q of qs) {
      expect(q.type).toBe('choice');
      expect(q.criteria).toEqual(EMOTION_MOOD);
      expect(q.instructions).toMatch(/as the story tells it/);
    }
    expect(qs.map(q => q.instructions).join('|')).toMatch(/Drako has at the moment of page 1/);
    expect(d.byPage).toEqual({ 1: { Ana: 'happy', ANI001: 'surprised' }, 2: { Ana: 'afraid', Ben: 'afraid' } });
    expect(d.stats.calls).toBe(1);
  });

  it('reads the arc and the plan lines (the page text does not exist when the briefs are written), shot stripped', async () => {
    const s = stub(() => 'neutral');
    await JD.decideEmotions({ arc: '1. Ana meets a dragon.', pages, perPage }, { callImpl: s.impl });
    expect(s.calls[0].state).toContain('Ana meets a dragon.');
    expect(s.calls[0].state).toContain('Page 2: Ana and Ben — she does thing 2 — change 2');
    expect(s.calls[0].state).not.toMatch(/Page 1: wide/);
  });

  it('a caller that holds the prose (a trial) gets the story text as the state', async () => {
    const s = stub(() => 'happy');
    await JD.decideEmotions({ arc: '', pages: [{ pageNumber: 1, text: 'Noah cried softly.' }], perPage: [{ pageNumber: 1, figures: [{ key: 'Noah', label: 'Noah' }] }] }, { callImpl: s.impl });
    expect(s.calls[0].state).toMatch(/^THE STORY TEXT:/);
    expect(s.calls[0].state).toContain('Noah cried softly.');
  });

  it('an answer outside the closed list is an error, never a default', async () => {
    const s = stub(() => 'focused');
    await expect(JD.decideEmotions({ arc: 'A', pages, perPage }, { callImpl: s.impl })).rejects.toBeInstanceOf(JD.JevDecisionError);
  });

  it('a Jev failure is a JevDecisionError (the existing outage policy takes it from there); no figures, no call', async () => {
    const down = async () => { throw new Error('OPENROUTER_API_KEY is not set'); };
    await expect(JD.decideEmotions({ arc: 'A', pages, perPage }, { callImpl: down })).rejects.toBeInstanceOf(JD.JevDecisionError);
    const s = stub(() => 'happy');
    const none = await JD.decideEmotions({ arc: 'A', pages, perPage: [{ pageNumber: 1, figures: [] }] }, { callImpl: s.impl });
    expect(s.calls).toHaveLength(0);
    expect(none.byPage).toEqual({});
  });
});

describe('the decided emotion reaches the brief', () => {
  const fixed = { emotions: { Ana: 'afraid', ANI001: 'surprised' } };

  it('pinBrief writes a character\'s emotion by name and a creature\'s by id, and leaves a figure the decision does not list', () => {
    const r = JD.pinBrief(storedBrief, fixed);
    const m = metaOf(r.brief);
    expect(m.characters.find((c: any) => c.name === 'Ana').emotion).toBe('afraid');
    expect(m.characters.find((c: any) => c.name === 'Ben').emotion).toBe('neutral');   // not listed: the author's stands
    expect(m.creatures[0].emotion).toBe('surprised');
    expect(r.changes.filter((c: any) => c.field === 'emotion').map((c: any) => [c.name, c.from, c.to]))
      .toEqual([['Ana', 'happy', 'afraid'], ['ANI001', 'neutral', 'surprised']]);
    // idempotent: a pinned brief pins to no change
    expect(JD.pinBrief(r.brief, fixed).changes).toEqual([]);
  });

  it('a brief the author wrote WITHOUT emotion rows (the new template) is assembled with them, and the enum check stays quiet', () => {
    const noEmotion = JSON.parse(JSON.stringify(metaOf(storedBrief)));
    for (const c of noEmotion.characters) delete c.emotion;
    for (const c of noEmotion.creatures) delete c.emotion;
    const brief = `Prose.\n\n---METADATA---\n${JSON.stringify(noEmotion)}`;
    expect(checkEmotionEnum({ pageNumber: 1 }, metaOf(brief)).length).toBe(3);          // before the pin: three rows lack it
    const expansions = [{ pageNumber: 1, brief }];
    assembleBriefs(expansions, [{ pageNumber: 1, jevFixed: { emotions: { Ana: 'afraid', Ben: 'neutral', ANI001: 'surprised' } } }], { error: () => {}, warn: () => {}, info: () => {} });
    expect(checkEmotionEnum({ pageNumber: 1 }, metaOf(expansions[0].brief))).toEqual([]);   // after: the guard does not fire
  });

  it('the FIXED block lists each figure\'s emotion; a page that decided none lists none; the rule names the field', () => {
    const block = JD.fixedBlock({ pageNumber: 1, jevFixed: { shot: 'wide', cites: [], emotions: { Ana: 'afraid', ANI001: 'surprised' } } });
    expect(block).toContain('- emotion: Ana → afraid; ANI001 → surprised');
    expect(JD.fixedBlock({ pageNumber: 1, jevFixed: { shot: 'wide', cites: [], emotions: {} } })).not.toContain('emotion');
    expect(JD.JEV_FIXED_FIELDS_RULE).toMatch(/figure's `emotion`/);
  });

  it('an iterate rewrite that changed the decided emotion is restored by the same pin (images.js iteratePageCore reads savedScene.jevFixed)', () => {
    const rewrite = storedBrief.replace('"emotion": "happy"', '"emotion": "angry"');
    const r = JD.pinBrief(rewrite, { emotions: { Ana: 'happy' } });
    expect(metaOf(r.brief).characters.find((c: any) => c.name === 'Ana').emotion).toBe('happy');
  });
});

describe('decideBriefFields decides the emotions beside the gaze, in one extra call', () => {
  it('stores jevFixed.emotions for the head count\'s characters and the cited animals, from one story-level call', async () => {
    const J = req('../../server/lib/jevAudit');
    const saved = J.callJev;
    const s = stub(q => (/Drako/.test(q) ? 'surprised' : 'afraid'));
    const base = { calls: [] as any[] };
    // gaze/vb/population/etc. keep using the shared Jev stub; only the emotion questions are told apart
    const { makeJevStub } = await import('../helpers/jev-stub');
    const generic = makeJevStub({ noul: (q) => (/Drako/.test(q) ? 0.9 : /public can walk/.test(q) ? 0.7 : 0.1) });
    J.callJev = async (reqq: any) => {
      const isEmotion = Object.values<any>(reqq.questions).some(q => /as the story tells it/.test(q.instructions || ''));
      if (isEmotion) { base.calls.push(reqq); return s.impl(reqq); }
      return generic.impl(reqq);
    };
    try {
      const { decideBriefFields } = req('../../server/lib/jevBriefFields');
      const gl = { info: () => {}, warn: () => {}, error: () => {} };
      const vb = {
        animals: [{ id: 'ANI001', name: 'Drako', species: 'dragon', description: 'a grey dragon', appearsInPages: [2] }],
        locations: [{ id: 'LOC001', name: 'harbour', description: 'a harbour', appearsInPages: [1, 2], setting: 'outdoor' }],
        artifacts: [], secondaryCharacters: [], vehicles: [],
      };
      const beats: any[] = [
        { pageNumber: 1, planLine: 'wide — Ana — Ana walks — she smiles', fixed: { timeOfDay: 'dusk', indoor: false } },
        { pageNumber: 2, planLine: 'medium — Ana and Ben — Drako lands — they gasp', fixed: { timeOfDay: 'dusk', indoor: false } },
      ];
      const present = new Map([[1, ['Ana']], [2, ['Ana', 'Ben', 'Drako']]]);
      const out = await decideBriefFields({ beats, visualBible: vb, bibleSections: null, approvedArc: '1. A thing.', inputData: { characters: [{ name: 'Ana' }, { name: 'Ben' }] }, present, gl });
      expect(base.calls).toHaveLength(1);                                          // ONE call for the whole story
      expect(Object.keys(beats[0].jevFixed.emotions)).toContain('Ana');
      expect(beats[1].jevFixed.emotions.Ana).toBe('afraid');
      expect(beats[1].jevFixed.emotions.Ben).toBe('afraid');
      expect(beats[1].jevFixed.emotions.ANI001).toBe('surprised');                 // the cited animal, keyed by its id
      expect(Object.keys(out.report.emotions.byPage).sort()).toEqual(['1', '2']);
    } finally { J.callJev = saved; }
  });
});

describe('the Art Director is no longer asked to choose a decided emotion', () => {
  const CHARACTERS = [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn' }];
  const inputData: any = { title: 'T', characters: CHARACTERS, mainCharacters: ['c1'], language: 'en', pages: 2, season: 'autumn', storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', layout: { textInImage: true } };
  const BEATS = [{ pageNumber: 1, planLine: 'wide — Mira — she lifts the lantern — it lights', fixed: { timeOfDay: 'dusk', indoor: false },
    jevFixed: { shot: 'wide', timeOfDay: 'dusk', indoor: false, cites: [], aboard: null, emotions: { Mira: 'afraid' } } }];
  beforeAll(async () => { await loadPromptTemplates(); });

  it('on the Jev path the page\'s FIXED block carries the emotion and the output example rows do not', () => {
    const p = PB.buildSceneBriefsAllPrompt(inputData, BEATS, { jevBackup: false });
    expect(p).toContain('- emotion: Mira → afraid');
    expect(p).not.toMatch(/"emotion": "(surprised|happy|neutral)"/);       // the example rows no longer teach writing one
    expect(p).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
    expect(p).toMatch(/FIXED `emotion`/);
  });
  it('the per-page sibling template says the same', () => {
    const p = PB.buildSceneExpansionPrompt(1, `PLAN: ${BEATS[0].planLine}\n${JD.fixedBlock(BEATS[0])}`, CHARACTERS, 'en', {}, '', null, { story: inputData, jevBackup: false });
    expect(p).not.toMatch(/"emotion": "(surprised|happy|neutral)"/);
    expect(p).toMatch(/FIXED `emotion`/);
  });
  it('on the Jev-outage backup nothing is decided, so the Art Director still writes the emotion', () => {
    const p = PB.buildSceneBriefsAllPrompt(inputData, BEATS.map(b => ({ ...b, jevFixed: undefined })), { jevBackup: true });
    expect(p).toMatch(/"emotion": "surprised"/);
    expect(p).not.toMatch(/FIXED `emotion`/);
  });
  it('rule 8k on the Jev path says a listed emotion is code\'s and the face draws it; the backup\'s names no FIXED block; the closed list is unchanged', () => {
    const jev = PB.buildSceneBriefsAllPrompt(inputData, BEATS, { jevBackup: false });
    const bak = PB.buildSceneBriefsAllPrompt(inputData, BEATS.map(b => ({ ...b, jevFixed: undefined })), { jevBackup: true });
    expect(jev).toMatch(/FIXED block lists an `emotion`/);
    expect(bak).not.toMatch(/FIXED block lists/);
    for (const e of EMOTIONS) expect(PB.EXPRESSION_FIELD_RULE).toContain(`\`${e}\``);
  });
});
