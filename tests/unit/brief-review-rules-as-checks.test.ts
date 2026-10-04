/**
 * THE SCENE REVIEW'S RULES AS CODE CHECKS (owner, 2026-09-28, Q9): five of the
 * review's checks come back as code checks feeding the one brief re-ask, plus a
 * check for required in-image text (the decision layer's READ noul, with the
 * re-ask's text lane). Pins behaviour, never prompt wording.
 * see docs/decisions.md 2026-09-28 "The scene review is deleted"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { makeJevStub } from '../helpers/jev-stub';

const req = createRequire(import.meta.url);
const SBC = req('../../server/lib/sceneBriefCheck');
const CC = req('../../server/lib/clothingCheck');
const BC = req('../../server/lib/briefChecks');
const JD = req('../../server/lib/jevDecisions');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata');

const brief = (prose: string, m: any) => `${prose}\n\n---METADATA---\n${JSON.stringify(m, null, 2)}`;
const full = (b: string) => { const m = extractSceneMetadata(b) || {}; return m.fullData || m; };
const row = (name: string, extra: any = {}) => ({ name, depth: 'foreground', expression: 'brows raised, mouth open', ...extra });

describe('negation_named: a named absence is painted', () => {
  it('fires on the prose and on a metadata field', () => {
    const b = brief('The square is empty of people and the stall has no roof.', { shot: 'wide', characters: [row('Ana')], setting: 'a room without windows' });
    const f = SBC.checkNegationNamed({ pageNumber: 2, brief: b }, extractSceneMetadata(b));
    expect(f).toHaveLength(1);
    expect(f[0].phrases).toEqual(expect.arrayContaining(['empty of people', 'no roof', 'without windows']));
  });
  it('leaves idioms that name nothing', () => {
    const b = brief('No one else is near; Ana no longer waits.', { shot: 'wide', characters: [row('Ana')] });
    expect(SBC.checkNegationNamed({ pageNumber: 2, brief: b }, extractSceneMetadata(b))).toEqual([]);
  });
});

describe('element_uncited: the prose stages a bible element by name and cites no id', () => {
  const VB = {
    artifacts: [
      { id: 'ART001', name: 'kite', label: 'paper kite', description: 'a kite' },
      { id: 'ART002', name: 'scarf', label: 'red scarf', description: 'a scarf', wornAs: 'Ana.accessories' },
    ],
    animals: [{ id: 'ANI001', name: 'Pip', species: 'mouse', description: 'a mouse' }],
  };
  it('fires on the authored label and on a creature\'s name', () => {
    const b = brief('Ana holds the paper kite while Pip sits on her shoulder.', { shot: 'medium', characters: [row('Ana')], objects: [] });
    expect(SBC.checkElementUncited({ pageNumber: 3, brief: b }, full(b), VB, ['Ana']).map((f: any) => f.id).sort()).toEqual(['ANI001', 'ART001']);
  });
  it('passes a cited element, a possessive, and a worn garment', () => {
    const b = brief('Ana holds the paper kite, looks at Pip\'s nest and tugs her red scarf.', { shot: 'medium', characters: [row('Ana')], objects: ['ART001'] });
    expect(SBC.checkElementUncited({ pageNumber: 3, brief: b }, full(b), VB, ['Ana'])).toEqual([]);
  });
});

describe('character_fields: depth and a drawable expression on every row', () => {
  it('fires on a mood word and on a missing depth', () => {
    const b = brief('x', { shot: 'medium', characters: [row('Ana', { expression: 'calm, observing' }), row('Ben', { depth: '' })] });
    expect(SBC.checkCharacterFields({ pageNumber: 1 }, full(b)).map((f: any) => f.character)).toEqual(['Ana', 'Ben']);
  });
  it('accepts a named face part, and asks no face where none can be read', () => {
    const ok = brief('x', { shot: 'medium', characters: [row('Ana', { expression: 'wide-eyed, a small grin' })] });
    const wide = brief('x', { shot: 'wide', characters: [row('Ana', { expression: 'determined' })] });
    expect(SBC.checkCharacterFields({ pageNumber: 1 }, full(ok))).toEqual([]);
    expect(SBC.checkCharacterFields({ pageNumber: 1 }, full(wide))).toEqual([]);
  });
});

describe('cast_not_in_plan: the head count decides who is in the picture', () => {
  const b = brief('x', { shot: 'medium', characters: [row('Ana'), row('Ben')] });
  it('fires on a commissioned character outside the page\'s head count', () => {
    const f = SBC.checkCastNotInPlan({ pageNumber: 4, planLine: 'medium — Ana — x — y', inFrame: ['Ana'] }, full(b), ['Ana', 'Ben']);
    expect(f[0].names).toEqual(['Ben']);
  });
  it('reads a collective who column through the head count', () => {
    expect(SBC.checkCastNotInPlan({ pageNumber: 4, planLine: 'medium — both children — x — y', inFrame: ['Ana', 'Ben'] }, full(b), ['Ana', 'Ben'])).toEqual([]);
  });
  it('checks no cover and no page without a head count', () => {
    expect(SBC.checkCastNotInPlan({ pageNumber: -1, planLine: 'medium — Ana — x — y', inFrame: ['Ana'] }, full(b), ['Ana', 'Ben'])).toEqual([]);
    expect(SBC.checkCastNotInPlan({ pageNumber: 4, planLine: 'medium — Ana — x — y' }, full(b), ['Ana', 'Ben'])).toEqual([]);
  });
});

describe('required_text_undeclared: a reading page cites an element that declares its lettering', () => {
  const VB = { artifacts: [{ id: 'ART001', name: 'sign', description: 'a sign' }, { id: 'ART002', name: 'book', description: 'a book', text: 'A B C' }] };
  it('fires on a reading page whose cited elements declare no text', () => {
    const b = brief('x', { shot: 'medium', characters: [row('Ana')], objects: ['ART001'] });
    const f = SBC.checkRequiredTextUndeclared({ pageNumber: 5, readsText: true }, full(b), VB);
    expect(f).toHaveLength(1);
    expect(f[0].cited).toEqual(['ART001']);
  });
  it('passes when a cited element declares text, and on every page nobody reads', () => {
    const b = brief('x', { shot: 'medium', characters: [row('Ana')], objects: ['ART002'] });
    const unread = brief('x', { shot: 'medium', characters: [row('Ana')], objects: ['ART001'] });
    expect(SBC.checkRequiredTextUndeclared({ pageNumber: 5, readsText: true }, full(b), VB)).toEqual([]);
    expect(SBC.checkRequiredTextUndeclared({ pageNumber: 5 }, full(unread), VB)).toEqual([]);
  });
  it('the READ noul rides the page\'s element call, and a page with no element is still asked', async () => {
    const stub = makeJevStub({ noul: (q: string) => (q === JD.READ_TEXT_Q ? 0.8 : 0.1) });
    const d = await JD.decideVbAndAboard({ arc: 'A', pages: [{ pageNumber: 1, planLine: 'medium — Ana — reads — y' }], visualBible: {} }, { callImpl: stub.impl });
    expect(stub.calls).toHaveLength(1);
    expect(d.pages[0].readsText).toBe(true);
  });
});

describe('the re-ask\'s text lane declares lettering on a cited element, nothing more', () => {
  it('applies an allowed id and rejects the rest', () => {
    const vb: any = { artifacts: [{ id: 'ART001', name: 'sign' }, { id: 'ART002', name: 'cup' }] };
    const reply = '## Page 5\nprose\n---METADATA---\n{}\n---VISUAL BIBLE---\n{"text": [{"id": "ART001", "text": "OPEN"}, {"id": "ART002", "text": "X"}, {"id": "ART009", "text": "Y"}]}';
    const lane = BC.applyBibleTextLane(reply, vb, ['ART001', 'ART009']);
    expect(lane.applied).toEqual([{ id: 'ART001', oldText: null, newText: 'OPEN' }]);
    expect(vb.artifacts[0].text).toBe('OPEN');
    expect(vb.artifacts[1].text).toBeUndefined();
    expect(lane.rejected.map((r: any) => r.id)).toEqual(['ART002', 'ART009']);
  });
});

describe('clothing_incomplete: the prose names each character\'s top, bottom and footwear', () => {
  const REQS = { Ana: { standard: { used: true, description: 'top: red knitted jumper; bottom: blue denim jeans; footwear: brown leather boots' } } };
  const page = (prose: string, shot = 'medium') => ({ pageNumber: 3, prose, shot, cast: ['Ana'], perCharClothing: { Ana: 'standard' } });
  it('fires on the slot the prose leaves out', () => {
    const f = CC.checkClothingIncomplete(page('Ana, in her red knitted jumper and blue denim jeans, runs.'), REQS);
    expect(f.map((x: any) => x.slots)).toEqual([['footwear']]);
  });
  it('any garment of the slot counts: a pullover is a top, plain boots are footwear', () => {
    expect(CC.checkClothingIncomplete(page('Ana, in a pullover, jeans and boots, runs.'), REQS)).toEqual([]);
  });
  it('a close-up asks for the top only', () => {
    expect(CC.checkClothingIncomplete(page('Ana in her red knitted jumper laughs.', 'close-up'), REQS)).toEqual([]);
  });
});

describe('the creature-tone rule names no absence the brief check would flag (owner, 2026-09-28)', () => {
  // The Art Director copied "no teeth showing" from the rule into 4 of the 23
  // stored negation_named fires; the rule now states what IS drawn.
  const { buildCreatureToneSection } = req('../../server/lib/promptBuilders');
  const story = (age: number) => ({ characters: [{ id: 1, name: 'Ana', age }], mainCharacters: [1], pages: 4, language: 'en', artStyle: 'watercolor' });
  // Scoped to the creature's face and body: the section's page-rule sentence
  // ("an entry does not travel to the page") is about the pipeline, not the
  // picture, and nobody copies it into a brief.
  it.each([3, 5])('the band for a %i-year-old lead names no absent feature of the creature', (age) => {
    const text = String(buildCreatureToneSection(story(age)) || '');
    expect(text.length).toBeGreaterThan(100);
    const phrases = SBC.checkNegationNamed({ pageNumber: 1, brief: text }, {}).flatMap((f: any) => f.phrases);
    expect(phrases.filter((p: string) => /teeth|claw|fang|bared|displayed|raised|mouth|paw/i.test(p))).toEqual([]);
  });
});

describe('collectBriefFindings sends the new checks to the re-ask', () => {
  it('reads the beat\'s head count and its READ answer', () => {
    const vb = { artifacts: [{ id: 'ART001', name: 'sign', description: 'a sign' }] };
    const b = brief('Ana and Ben read the sign.', { shot: 'medium', characters: [row('Ana'), row('Ben')], objects: ['ART001'] });
    const { findings } = BC.collectBriefFindings([{ pageNumber: 2, brief: b }], {
      inputData: { characters: [{ name: 'Ana' }, { name: 'Ben' }] }, clothingRequirements: null, visualBible: vb,
      briefBeats: [{ pageNumber: 2, planLine: 'medium — Ana — reads the sign — y', inFrame: ['Ana'], jevFixed: { readsText: true, cites: ['ART001'], decidedIds: ['ART001'] } }],
    });
    const types = findings.map((f: any) => f.type);
    expect(types).toContain('cast_not_in_plan');
    expect(types).toContain('required_text_undeclared');
  });
});
