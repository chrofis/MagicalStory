import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pb = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts.js');

// Lab 1273: the trial idea generator returned ten ideas on one premise, because
// the age-band file was 57% of an 861-word prompt, both arms shared it whole,
// and its worked-example menus were read as the answer key. These tests pin the
// CONTRACT of the fix — which rules reach which reader — never the wording of
// any rule.

const chars = (age: number) => [{ name: 'Mia', age, gender: 'female', isMain: true }];

const args = (age: number) => ({
  characters: chars(age),
  charDesc: `Mia, ${age} years old, female`,
  categoryContext: 'This is a pirate adventure story.',
  landmarksText: 'At least one scene must take place at one of these real local landmarks: Alpha Tower.',
  townName: 'Somewhereville',
  storyTheme: 'pirate',
  trialTitle: '',
  langInstruction: 'Write in German.',
  seasonInstruction: 'The season is autumn.',
  ideaCostume: null,
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('age-band views — one file, three readers', () => {
  const bands: Array<[number, string]> = [[0, 'routine'], [2, 'quest'], [3, 'tries'], [4, 'fear-choice'], [5, 'journey']];

  for (const [age, name] of bands) {
    it(`${name}: writer ⊃ premise ⊃ tone, and no view leaks a marker`, () => {
      const views = (['writer', 'premise', 'tone'] as const).map(v =>
        pb.buildAgeModeSection({ characters: chars(age) }, { bandView: v }));
      const [writer, premise, tone] = views.map(s => s.length);
      expect(writer).toBeGreaterThan(premise);
      expect(premise).toBeGreaterThan(tone);
      for (const v of views) expect(v).not.toMatch(/\[\[/);
    });
  }

  it('rejects an unknown view rather than silently shipping the whole file', () => {
    expect(() => pb.applyBandView('x', 'nonsense')).toThrow(/Unknown age-band view/);
  });

  it('the writer keeps every rule of the band file — the views cost it nothing', () => {
    const file = PROMPT_TEMPLATES.ageBandTries as string;
    const writer = pb.applyBandView(file, 'writer');
    expect(writer).toBe(file.replace(/\[\[\/?(?:book|plot)\]\]/g, ''));
    // the book-craft rules a 40-word premise cannot honour
    for (const rule of ['One feeling per turn', '**Food.**', '**Ending.**', 'A life event is weather']) {
      expect(writer).toContain(rule);
    }
  });

  it('the writer prompt itself still carries the band whole', () => {
    const w = pb.buildTrialStoryPrompt({
      trialMode: true, language: 'de', storyTheme: 'realistic', storyDetails: 'x', characters: chars(3),
    }, 5);
    expect(w).not.toMatch(/\[\[/);
    for (const rule of ['One feeling per turn', '**Food.**', '**Ending.**', 'Three tries, no more']) {
      expect(w).toContain(rule);
    }
  });
});

describe('the two idea arms differ by construction', () => {
  it('the fantasy arm carries the band tone but not its plot mechanics', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    // plot mechanics: own-town arm only
    expect(local).toContain('Three tries, no more');
    expect(fantasy).not.toContain('Three tries, no more');
    expect(fantasy).not.toContain('The third try comes from that noticing');
    // tone rules: both arms
    for (const p of [local, fantasy]) {
      expect(p).toContain('A gentle obstacle, never a villain');
      expect(p).toContain('Kindness is the motive');
    }
  });

  it('neither arm carries the book-craft rules or the example menus', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    for (const p of [local, fantasy]) {
      expect(p).not.toContain('One feeling per turn');
      expect(p).not.toContain('**Food.**');
      expect(p).not.toContain('**Ending.**');
      // the menu 8 of 10 collapsed ideas copied verbatim
      expect(p).not.toContain('there is a way in from another side');
    }
  });

  it('the fantasy arm is materially shorter than the own-town arm', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(fantasy.length).toBeLessThan(local.length * 0.8);
  });

  it('never asks for a difference from an idea it cannot have seen', () => {
    const { fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(fantasy).not.toMatch(/different idea than the first/i);
  });

  it('the landmark mandate stays on the own-town arm', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts(args(3));
    expect(local).toContain('Alpha Tower');
    expect(fantasy).not.toContain('Alpha Tower');
  });
});

describe('title sentences are gated on there being a title', () => {
  it('an untopic\'d adventure gets neither the empty title line nor its rule', () => {
    const { local, fantasy } = pb.buildTrialIdeaPrompts({ ...args(6), trialTitle: '' });
    for (const p of [local, fantasy]) {
      expect(p).not.toContain('Story title:');
      expect(p).not.toMatch(/the title above/);
      expect(p).not.toMatch(/repeat.{0,10}the title/i);
    }
  });

  it('a real title brings both back', () => {
    const { local } = pb.buildTrialIdeaPrompts({ ...args(6), trialTitle: 'The Quiet Lantern' });
    expect(local).toContain('Story title: The Quiet Lantern');
    expect(local).toMatch(/the title above/);
  });
});

describe('the variety axis varies across draws', () => {
  it('rotates rather than repeating, and the two arms of a draw differ', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const a = pb.nextIdeaVarietyAxis();
      const b = pb.nextIdeaVarietyAxis();
      expect(a.text).not.toBe(b.text);
      seen.add(a.text); seen.add(b.text);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('reaches the built prompt, and two consecutive draws of an arm differ', () => {
    const d1 = pb.buildTrialIdeaPrompts(args(3));
    const d2 = pb.buildTrialIdeaPrompts(args(3));
    expect(d1.local).toContain(d1.axes.local.text);
    expect(d1.local).not.toBe(d2.local);
    expect(d1.fantasy).not.toBe(d2.fantasy);
  });

  it('costs nothing of consequence — one short line per arm', () => {
    const { text } = pb.nextIdeaVarietyAxis();
    expect(text.split(/\s+/).length).toBeLessThan(30);
  });
});
