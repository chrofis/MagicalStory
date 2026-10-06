import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const B = require('../../server/lib/promptBuilders');

// Owner, 2026-09-23 (dragon run 6, staging job_1790100385959_1nitlympp, Lab 1422).
// ONE style rulebook for every pass that writes page prose. The lector, which
// had no copy, split a sentence into a paired negation; the writer and the
// repair each held a hand-kept copy that had already drifted. Asserted on the
// BUILT prompts.

const inputData = {
  language: 'de-ch',
  languageLevel: 'standard',
  characters: [{ id: 1, name: 'Mara', age: 7, gender: 'female', isMain: true }],
  mainCharacters: [1],
  pages: 4,
};
const PLAN = 'wide — Mara — Mara pulls the rope — the sail is up';
const PAGES = [{ pageNumber: 1, text: 'Mara zog am Seil.', planLine: PLAN, sceneBrief: 'Mara pulls a rope on a small boat.' }];

describe('the style rulebook reaches every prose-writing pass', () => {
  let built: Record<string, string>;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    built = {
      writer: B.buildStoryTextFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: PLAN }], [], 'An arc.'),
      trialWriter: B.buildTrialStoryPrompt({ trialMode: true, language: 'de', storyTheme: 'realistic', storyDetails: 'a kite caught in a tree', characters: [{ name: 'Mia', age: 6, gender: 'female', isMain: true }] }, 5),
      repair: B.buildTextRefinePrompt(inputData, PAGES, 'FAULT[CAUSE]: p1 — something', 'An arc.'),
      diff: B.buildTextDiffPrompt(inputData, [{ pageNumber: 1, before: 'Niemand antwortete ihm oder widersprach ihm.', after: 'Keiner antwortete. Keiner widersprach ihm.' }]),
      lector: B.buildTextProofreadPrompt(inputData, PAGES),
    };
  });

  it('is one non-empty constant', () => {
    expect(typeof B.STYLE_RULEBOOK).toBe('string');
    expect(B.STYLE_RULEBOOK.split('\n').length).toBeGreaterThanOrEqual(6);
  });

  for (const pass of ['writer', 'trialWriter', 'repair', 'diff', 'lector']) {
    it(`${pass}: carries the rulebook exactly once and no unfilled placeholder`, () => {
      const p = built[pass];
      expect(p.split(B.STYLE_RULEBOOK).length - 1).toBe(1);
      expect(p).not.toContain('{STYLE_RULEBOOK}');
    });
  }

  it('no template keeps a hand copy of a rulebook rule', () => {
    const dir = path.join(__dirname, '../../prompts');
    for (const f of ['story-text-from-beats.txt', 'story-trial.txt', 'text-refine.txt', 'story-text-diff.txt', 'story-text-proofread.txt']) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(t, f).not.toMatch(/paired negation/i);
      expect(t, f).not.toMatch(/bare fragment/i);
      expect(t, f).not.toMatch(/solemn sentences/i);
    }
  });

  it('the motive-at-the-act rule reaches both writers and the repair', () => {
    for (const pass of ['writer', 'trialWriter', 'repair']) {
      expect(built[pass]).toContain(B.MOTIVE_AT_THE_ACT_RULE);
      expect(built[pass]).not.toContain('{MOTIVE_AT_THE_ACT}');
    }
  });

  it("the writer's analysis step checks each later-revealed motive and each stated size or look", () => {
    // Lab 1426 (rule alone): no glimpse at the p10 refusal. Lab 1428 (rule + this
    // analysis step): the writer named the refusal and placed a glimpse at it.
    const step1 = built.writer.split(/\r?\n/).find(l => l.startsWith('Step 1')) || '';
    expect(step1).toMatch(/refusal, demand, flight or lie whose reason the story gives only later/);
    expect(step1).toMatch(/any owed fact that has not yet found its page/);
  });

  it("the writer's and the repair's specific-form rule excludes sizes and looks", () => {
    for (const pass of ['writer', 'repair']) {
      const sentence = built[pass].split('\n').find(l => l.includes('Only the OWED list')) || '';
      expect(sentence).toMatch(/A size, an age or a look is owed only where something is lifted, hidden, held or fitted/);
    }
  });
});

describe('the arc-informed audit carries the ending check and the widened INFERRED', () => {
  let audit: string;
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    audit = B.buildTextAuditPrompt(inputData, PAGES, 'An arc.');
  });

  const question = (name: string) => (audit.match(new RegExp(`^\\d+\\. ${name}:[^\\n]*`, 'm')) || [''])[0];

  it('has an ENDING question that faults a summing-up close', () => {
    expect(question('ENDING')).toMatch(/sums up what the story meant/);
  });

  it('INFERRED reaches any act whose reason comes later, not only the ending', () => {
    const q = question('INFERRED');
    expect(q).toMatch(/refuses, demands, flees, hides or lies/);
    expect(q).toMatch(/fault on the page of the act/);
  });

  it('PAYOFF catches an unanswered demand', () => {
    expect(question('PAYOFF')).toMatch(/demand or order go unanswered/);
  });

  it('LOADBEARING never counts an unused size or look as a dropped fact', () => {
    expect(question("LOADBEARING")).toMatch(/A size, an age or a look is owed only where something is lifted/);
    expect(question("LOADBEARING")).toMatch(/File nothing for anything the OWED list does not hold/);
  });
});

// Owner, 2026-09-24: "We review all the text and send all findings to redo. And the
// redo has the story and should be able to decide such things." The audit readers
// see less than the repair (cold, or without pictures); a wrong finding must not
// force a rewrite (Lab 1434 filed the book's own closing line as a summary).
describe('the repair weighs findings instead of obeying them', () => {
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });

  it('may decline a finding that is wrong for the book, and says why', () => {
    const repair = B.buildTextRefinePrompt(inputData, PAGES, 'FAULT[STYLE]: p1 — «Mara zog am Seil.» summary', 'An arc.');
    expect(repair).toMatch(/Weigh each against the story/);
    expect(repair).toMatch(/names it as declined with one line why/);
    expect(repair).toMatch(/A declined finding does not make its page rewritable/);
  });
});

// Owner, 2026-09-24 (staging job_1790277448294_5herh01j7 p17): the repair cut
// the sentence that paid off the arc's central plant. ONE constant, in the
// repair (all its whole-page rounds share text-refine.txt) and in the grammar
// check that can restore what the repair lost. The lector edits inside one
// sentence and cannot drop one, so it does not carry the rule.
describe('the payoff-keep rule reaches every pass that can drop a sentence', () => {
  let built: Record<string, string>;
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    built = {
      repair: B.buildTextRefinePrompt(inputData, PAGES, 'FAULT[STYLE]: p1 — something', 'An arc.'),
      diff: B.buildTextDiffPrompt(inputData, [{ pageNumber: 1, before: 'Mara zog am Seil. Die Tüte lag warm in ihrer Hand.', after: 'Mara zog am Seil.' }]),
      lector: B.buildTextProofreadPrompt(inputData, PAGES),
    };
  });

  for (const pass of ['repair', 'diff']) {
    it(`${pass}: carries PAYOFF_KEEP_RULE exactly once and no unfilled placeholder`, () => {
      expect(built[pass].split(B.PAYOFF_KEEP_RULE).length - 1).toBe(1);
      expect(built[pass]).not.toContain('{PAYOFF_KEEP}');
    });
  }

  it('the repair states it right after the make-room rule it limits', () => {
    const at = built.repair.indexOf('shorten a sentence that names only objects and positions.');
    expect(at).toBeGreaterThan(-1);
    expect(built.repair.indexOf(B.PAYOFF_KEEP_RULE)).toBeGreaterThan(at);
    expect(built.repair.indexOf(B.PAYOFF_KEEP_RULE) - at).toBeLessThan(80);
  });

  it('the lector does not carry it', () => {
    expect(built.lector).not.toContain(B.PAYOFF_KEEP_RULE);
  });
});

// Owner, 2026-09-27 (staging job_1790508305061_dka3jpog9): the story's main
// relationship never closed on the page — no farewell, the book ended on a race
// home — and the blind audit filed the callback payoff as a recap, which the
// repair cut. ONE constant for the closing moment, generator and critic; ONE
// for "a shown callback is not a recap", in the rulebook and both ENDING checks.
describe('the closing moment and the shown callback reach generator and critic alike', () => {
  let built: Record<string, string>;
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    built = {
      arcCreate: B.buildArcCreatePrompt(inputData, 4),
      arcRetell: B.buildArcRetellPrompt(inputData, 4, 'STORY LOGIC: x\nARC:\n1. Mara pulls the rope.', '1. [MAJOR] a fault'),
      arcPanel: B.buildArcPanelPrompt(inputData, 'ARC:\n1. Mara pulls the rope.'),
      writer: B.buildStoryTextFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: PLAN }], [], 'An arc.'),
      trialWriter: B.buildTrialStoryPrompt({ trialMode: true, language: 'de', storyTheme: 'realistic', storyDetails: 'a kite caught in a tree', characters: [{ name: 'Mia', age: 6, gender: 'female', isMain: true }] }, 5),
      repair: B.buildTextRefinePrompt(inputData, PAGES, 'FAULT[ENDING]: p1 — something', 'An arc.'),
      audit: B.buildTextAuditPrompt(inputData, PAGES, 'An arc.'),
      blind: B.buildTextAuditBlindPrompt(inputData, PAGES),
    };
  });

  for (const pass of ['arcCreate', 'arcRetell', 'arcPanel', 'writer', 'trialWriter', 'repair', 'audit', 'blind']) {
    it(`${pass}: carries CLOSING_MOMENT_RULE exactly once, no unfilled placeholder`, () => {
      expect(built[pass].split(B.CLOSING_MOMENT_RULE).length - 1).toBe(1);
      expect(built[pass]).not.toMatch(/\{(ARC_)?CLOSING_MOMENT(_RULE)?\}|\{SHOWN_CALLBACK\}/);
    });
  }

  it('the panel reads it as its own ENDING lens', () => {
    expect(built.arcPanel).toContain(`- ENDING — the rule: ${B.CLOSING_MOMENT_RULE}`);
  });

  it('both ENDING questions carry it with the shown-callback clarification', () => {
    for (const pass of ['audit', 'blind']) {
      const q = (built[pass].match(/^\d+\. ENDING:[^\n]*/m) || [''])[0];
      expect(q).toContain(B.CLOSING_MOMENT_RULE);
      expect(q).toContain(B.SHOWN_CALLBACK_RULE);
      expect(q).toMatch(/sums up what the story meant/);
    }
  });

  it('the rulebook says a shown callback is an act, so every prose pass has it', () => {
    expect(B.STYLE_RULEBOOK).toContain(B.SHOWN_CALLBACK_RULE);
  });
});

// text-v4 (owner, 2026-10-06, Opus text review items 1-4): the OWED list holds
// the figure and rule facts only, the story the text stages read carries no
// "Challenges taken:" notes, one rulebook line says a rule is said once and
// never recited, and the beats writer carries no separate DO-NOT-WRITE list.
describe('text-v4 text-stage inputs', () => {
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });

  const LOGIC = [
    'STORY LOGIC:',
    'Central figure: Mara',
    'Want and stakes: she wants the kite back.',
    'Chain:',
    '- the kite is stuck',
    '- she climbs and frees it, because the rope holds now',
    'Facts:',
    '- Mara (commissioned): climbs well; limit: afraid of the dark',
    '- Rule: a knot holds only when pulled twice',
  ].join('\n');

  it('the OWED list is the figure and rule facts, never the last chain link', () => {
    const owed = B.parseStoryLogic(LOGIC).owed;
    expect(owed).toHaveLength(2);
    expect(owed.join('\n')).not.toMatch(/why the turn works now/);
  });

  it('stripChallengesTaken drops the bookkeeping list and nothing else', () => {
    const arc = '1. A story.\n2. The end.\n\nChallenges taken:\n1. The missing stone.\n2. A tide.\n\nOWED:\n- x';
    const out = B.stripChallengesTaken(arc);
    expect(out).not.toMatch(/Challenges taken|missing stone|A tide/);
    expect(out).toContain('2. The end.');
    expect(out).toContain('OWED:');
  });

  it('the beats writer shows no Challenges-taken list and no separate DO-NOT-WRITE section', () => {
    const p = B.buildStoryTextFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: 'x' }], [], '1. A story.\n\nChallenges taken:\n1. The missing stone.');
    expect(p).not.toMatch(/Challenges taken|missing stone/);
    expect(p).not.toContain('# DO-NOT-WRITE LIST');
  });

  it('a rule or a limit is said once, never recited, retold or explained', () => {
    expect(B.STYLE_RULEBOOK).toContain('is shown in an act wherever one can show it; otherwise it is said once in the book, in one short line, by the one who would say it at the moment it is needed');
    expect(B.STYLE_RULEBOOK).toContain('or retells what happened, to anyone');
  });

  it('the old DO-NOT-WRITE bans live in the rulebook: suddenly banned, jokes banned, gesture cap', () => {
    expect(B.STYLE_RULEBOOK).toMatch(/Never "suddenly"/);
    expect(B.STYLE_RULEBOOK).toMatch(/No jokes, puns or wordplay/);
    expect(B.STYLE_RULEBOOK).toMatch(/twice in the book/);
  });

  it('the load-bearing rule and the arc sentence rule share one OWED_FACT_DEF', () => {
    expect(B.LOAD_BEARING_RULE).toContain(B.OWED_FACT_DEF);
    expect(B.OWED_FACT_DEF).not.toMatch(/cause of the main turn/);
  });
});

// text-v5 (owner, 2026-10-06): a "none" Facts line is a figure but owes nothing,
// and the narration tense is each language's own norm.
describe('text-v5 owed facts and narration tense', () => {
  beforeAll(async () => { await require('../../server/services/prompts').loadPromptTemplates(); });

  const LOGIC = [
    'STORY LOGIC:',
    'Central figure: Mara',
    'Want and stakes: she wants the kite back.',
    'Opposition: the wind, which blows.',
    'Facts:',
    '- Mara (commissioned) — none',
    '- Tom (commissioned) — None.',
    '- Berta (new) — cannot leave the water',
    'Motives:',
    '- Mara: she wants the kite → she climbs',
    'Events: 1',
    'Chain:',
    '- because the kite is stuck, she climbs',
  ].join('\n');

  it('a "none" figure line is dropped from the owed list but the figure still parses', () => {
    const l = B.parseStoryLogic(LOGIC);
    expect(l.owed).toEqual(['Berta — cannot leave the water']);
    expect(l.commissioned).toEqual(['Mara', 'Tom']);
    expect(l.invented).toEqual(['Berta']);
  });

  it.each([
    ['de-ch', /Präteritum/, /never Präsens and never Perfekt/],
    ['de-de', /Präteritum/, /never Präsens and never Perfekt/],
    ['en', /simple past/, /never the present/],
    ['en-gb', /simple past/, /never the present/],
    ['fr-ch', /imparfait and the passé composé/, /never the passé simple/],
    ['gsw-zh', /Perfekt.*isch gloffe/, /never the Präteritum/],
    ['gsw-be', /Perfekt.*isch gloffe/, /never the Präteritum/],
    ['it-ch', /passato prossimo and the imperfetto/, /never the passato remoto/],
    ['it', /passato prossimo and the imperfetto/, /never the passato remoto/],
  ])('the rulebook for %s names its tense', (lang, a, b) => {
    const r = B.styleRulebook(lang);
    expect(r).toMatch(a);
    expect(r).toMatch(b);
    expect(r).toContain('dialogue speaks as it likes');
  });

  it('the logic check asks only a child\'s why-not and a Facts limit the arc breaks', () => {
    expect(B.ARC_LOGIC_CHECK).toContain('that a child would ask and the logic leaves open');
    expect(B.ARC_LOGIC_CHECK).toContain('a Facts limit the arc\'s own sentences break');
  });

  it('the narrator because-rule faults a character\'s reason, not a physical cause (critics read the same constant)', () => {
    expect(B.STYLE_RULEBOOK).toContain('a physical cause stated as what happened');
    expect(B.buildTextAuditBlindPrompt({ language: 'en' }, [{ pageNumber: 1, text: 'A page.' }])).toContain('a physical cause stated as what happened');
  });

  it('every prose pass carries the story language\'s tense line, trial writer included', () => {
    const de = { language: 'de-ch', pages: 3, characters: [{ id: 'a', name: 'Mara', age: 5 }] };
    const fr = { ...de, language: 'fr-ch' };
    const pages = [{ pageNumber: 1, text: 'Eine Seite.' }];
    expect(B.buildTextProofreadPrompt(de, pages)).toMatch(/Präteritum/);
    expect(B.buildTextProofreadPrompt(fr, pages)).toMatch(/imparfait/);
    expect(B.buildTextAuditBlindPrompt(de, pages)).toMatch(/Präteritum/);
    expect(B.buildTextDiffPrompt(fr, [{ pageNumber: 1, before: 'A.', after: 'B.' }])).toMatch(/imparfait/);
    // The trial writer is the sibling of the beats writer.
    const trial = { ...fr, storyCategory: 'adventure', storyTheme: 'pirate', trialMode: true, languageLevel: 'standard' };
    expect(String(B.buildTrialStoryPrompt(trial, 5))).toMatch(/imparfait and the passé composé/);
    expect(String(B.buildTrialStoryPrompt({ ...trial, language: 'en' }, 5))).toMatch(/simple past/);
  });
});
