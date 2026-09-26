import { describe, it, expect, beforeAll } from 'vitest';

// Owner build, 2026-09-26 (staging job_1790446348343_z3fw660ie):
//  1. an action at the turn or the climax that could not happen is at least
//     MAJOR, so it reaches the re-telling; the text repair fixes a mechanism
//     only with what the pages hold, and otherwise leaves an ARC FAULT line;
//  2. the stakes rules the creator is given (the opposition does not yield on
//     request, every question is answered) are checked by the critique and
//     the panel from the SAME strings;
//  3. one-sentence narration paragraphs are counted in code and handed to the
//     repair as STYLE findings, and counted again on the shipped text.
// Behaviour is pinned on the real builders, the real counter and the real merge.
const PB = require('../../server/lib/promptBuilders');
const TR = require('../../server/lib/textRefine');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (age = 7, extra: any = {}) => ({
  language: 'de-ch', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'pirate',
  storyDetails: 'Kinder suchen einen Schatz.',
  characters: [{ id: 'a', name: 'Anna', age, gender: 'female' }, { id: 'b', name: 'Ben', age, gender: 'male' }],
  mainCharacters: ['a', 'b'],
  ...extra,
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('an impossible action at the turn is at least MAJOR', () => {
  it('the MAJOR class names it, and the critique and the panel read that one scale', () => {
    const def: string = PB.ARC_SEVERITY_DEF;
    const major = def.slice(def.indexOf('[MAJOR]'), def.indexOf('[MINOR]'));
    expect(major).toMatch(/turn or the climax that could not happen/);
    const panel = PB.buildArcPanelPrompt(input(), 'ARC: a committed arc');
    expect(panel).toContain(def);
    for (const spec of [PB.arcCritiqueSpec({ inputData: input() }), PB.arcCritiqueSpec({ retell: true, inputData: input() })]) {
      expect(spec).toContain(def);
    }
  });

  it('every whole-page text pass is told to fix a mechanism only with what the pages hold', () => {
    const p = PB.buildTextRefinePrompt({ language: 'en', languageLevel: 'standard', characters: [] },
      [{ pageNumber: 1, text: 'She pulled the rope.' }], 'FAULT[INFERRED]: p1 — the rope cannot do both jobs', 'ARC: x');
    expect(p).toContain(PB.MECHANISM_FIX_RULE);
    expect(p).not.toMatch(/\{MECHANISM_FIX\}/);
  });

  it('the repair\'s ARC FAULT ledger lines are read back, other lines are not', () => {
    const analysis = [
      'p12: fixed on p12.',
      'ARC FAULT: p14: the one rope cannot lower both; the story holds no second line.',
      '- **ARC FAULT:** p3: the door opens from the wrong side.',
      'An ARC FAULT: mentioned mid-line is not a ledger line.',
    ].join('\n');
    expect(TR.parseArcFaultLines(analysis)).toEqual([
      'p14: the one rope cannot lower both; the story holds no second line.',
      'p3: the door opens from the wrong side.',
    ]);
    expect(TR.parseArcFaultLines('')).toEqual([]);
  });
});

describe('stakes and open questions: one list, generator and critics', () => {
  it('the creator, the re-teller, their critique and the panel carry the same rules', () => {
    const data = input(7);
    const rules: string[] = PB.arcStakesRules(data);
    expect(rules).toEqual([PB.ARC_OPPOSITION_HOLDS_RULE, PB.ARC_QUESTIONS_ANSWERED_RULE]);
    const create = PB.buildArcCreatePrompt(data, 16);
    const retell = PB.buildArcRetellPrompt(data, 16, 'ARC: a committed arc', '1. [MAJOR] (s2) x — "y"');
    const panel = PB.buildArcPanelPrompt(data, 'ARC: a committed arc');
    for (const r of rules) {
      expect(PB.buildTellingRulesSection(data)).toContain(r);
      expect(create).toContain(r);
      expect(retell).toContain(r);
      expect(PB.arcCritiqueSpec({ inputData: data })).toContain(r);
      expect(PB.arcCritiqueSpec({ retell: true, inputData: data })).toContain(r);
      expect(panel).toContain(r);
    }
    expect(panel).not.toMatch(/\{ARC_STAKES_RULES\}/);
  });

  it('a simple band, whose opposition is never a person, is neither told nor checked for one that yields', () => {
    const data = input(3);
    expect(PB.arcStakesRules(data)).toEqual([PB.ARC_QUESTIONS_ANSWERED_RULE]);
    for (const text of [
      PB.buildTellingRulesSection(data),
      PB.arcCritiqueSpec({ inputData: data }),
      PB.buildArcPanelPrompt(data, 'ARC: a committed arc'),
    ]) {
      expect(text).not.toContain(PB.ARC_OPPOSITION_HOLDS_RULE);
      expect(text).toContain(PB.ARC_QUESTIONS_ANSWERED_RULE);
    }
  });
});

describe('one-sentence narration paragraphs are counted in code', () => {
  const page = (pageNumber: number, text: string) => ({ pageNumber, text });

  it('flags a lone narration sentence, never a spoken line, and never a one-paragraph page', () => {
    const pages = [
      page(1, 'Sie liefen zum Hafen. Das Boot lag still.\n\nDie Sonne ging unter.'),
      page(2, 'Er hob die Kiste. Sie war schwer.\n\n«Halt!»\n\n«Komm her!», rief sie.'),
      page(3, 'Der Wind drehte.'),
      page(4, 'Er rief. Niemand kam.\n\nDer Drache stiess einen Ruf aus: «Huuum.»'),
    ];
    expect(TR.findOneSentenceParagraphs(pages)).toEqual([{ pageNumber: 1, sentence: 'Die Sonne ging unter.' }]);
  });

  it('the hits become STYLE findings for their page, quoting the sentence', () => {
    const raw = TR.buildOneSentenceParagraphFindings([page(9, 'Sie ruderten los. Es war weit.\n\nJetzt mussten sie rudern.')]);
    const [f] = TR.parseFaultLines(raw, 'style-counter');
    expect(f.category).toBe('STYLE');
    expect(f.pageNumber).toBe(9);
    expect(f.text).toContain('«Jetzt mussten sie rudern.»');
    expect(TR.buildOneSentenceParagraphFindings([page(1, 'Eins. Zwei.\n\nDrei. Vier.')])).toBe('');
  });

  it('a counter STYLE finding folds only into a blind STYLE finding on the same sentence', () => {
    const counter = TR.buildOneSentenceParagraphFindings([page(15, 'Sie liefen. Sie lachten.\n\nDie Sonne verschwand.')]);
    const otherSentence = 'FAULT[STYLE]: p15 — «Sie liefen.» a fragment for effect';
    const sameSentence = 'FAULT[STYLE]: p15 — «Die Sonne verschwand.» a one-sentence paragraph for drama';
    const kept = TR.mergeAuditFindings([{ source: 'blind', raw: otherSentence }, { source: 'style-counter', raw: counter }]);
    expect(kept.findings).toHaveLength(2);
    const folded = TR.mergeAuditFindings([{ source: 'blind', raw: sameSentence }, { source: 'style-counter', raw: counter }]);
    expect(folded.findings).toHaveLength(1);
    expect(folded.findings[0].sources).toEqual(['blind', 'style-counter']);
  });

  it('two findings of another category on one page still fold on the tag', () => {
    const m = TR.mergeAuditFindings([
      { source: 'arc-informed', raw: 'FAULT[TRANSITION]: p4 — the crossing is never shown' },
      { source: 'blind', raw: 'FAULT[TRANSITION]: p4 — suddenly on the far bank' },
    ]);
    expect(m.findings).toHaveLength(1);
  });
});
