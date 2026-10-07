import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  PAGE_OPENING_VARIETY_RULE,
  AD_COMPOSITION_RULE,
  buildStoryTextFromBeatsPrompt,
  buildTrialStoryPrompt,
} = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

// Two writer rules that used to be prose copied between templates are now one
// constant each, filled through a placeholder (the RISK_FRAMING_RULE pattern).
// These tests pin the CONTRACT — the constant's VALUE reaches every writer
// prompt that declares it — not the wording, which is read from the export.
//
//   PAGE_OPENING_VARIETY_RULE → beats text writer, trial
//   AD_COMPOSITION_RULE       → trial only (the one writer that authors scene
//                               hints with no Art Director); NOT the beats text
//                               writer, which stages nothing.
//
// The two unified variants were covered here until 2026-09-15, when both
// templates and buildUnifiedStoryPrompt were deleted as unreachable.

const input = (extra: Record<string, unknown> = {}) => ({
  language: 'en',
  readingLevel: '2nd-grade',
  storyCategory: 'adventure',
  storyTheme: 'adventure',
  storyDetails: 'a kite caught in a tree',
  characters: [{ id: 'c1', name: 'Mia', age: 8, gender: 'female', isMain: true }],
  mainCharacters: ['c1'],
  ...extra,
});
const beats = [
  { pageNumber: 1, planLine: 'wide — Mia under the tree' },
  { pageNumber: 2, planLine: 'close — the kite string' },
];

const unfilled = (s: string) => [...new Set(String(s).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

let built: Record<string, string>;

beforeAll(async () => {
  await loadPromptTemplates();
  built = {
    beats: buildStoryTextFromBeatsPrompt(input(), beats, [], 'ARC', { arcHints: '' }),
    trial: buildTrialStoryPrompt(input({ trialMode: true }), 5),
  };
});

describe('page-opening variety rule reaches every stage that writes page prose', () => {
  it.each(['beats', 'trial'])('%s', (name) => {
    expect(built[name]).toBeTruthy();
    expect(built[name]).toContain(PAGE_OPENING_VARIETY_RULE);
  });

  it('is a bare sentence, so each template supplies its own list marker', () => {
    expect(PAGE_OPENING_VARIETY_RULE).not.toMatch(/^- /);
    // The beats template's rules are plain sentences; the other three are bullets.
    expect(built.beats).toContain(`\n${PAGE_OPENING_VARIETY_RULE}.\n`);
    for (const name of ['trial']) {
      expect(built[name], name).toContain(`\n- ${PAGE_OPENING_VARIETY_RULE}\n`);
    }
  });
});

describe('Art Director composition rules reach every writer that authors scene hints', () => {
  it.each(['trial'])('%s', (name) => {
    expect(built[name]).toContain(AD_COMPOSITION_RULE);
  });

  it('is one block of six bullets', () => {
    expect(AD_COMPOSITION_RULE.split('\n').filter((l: string) => l.startsWith('- '))).toHaveLength(6);
  });

  it('does not reach the beats text writer, which stages nothing', () => {
    expect(built.beats).not.toContain(AD_COMPOSITION_RULE);
  });

  it('replaced, not duplicated, the trial writer own focal-point bullets', () => {
    const hits = built.trial.match(/One moment, one focal point/g) || [];
    expect(hits).toHaveLength(1);
  });
});

describe('no writer prompt leaves an unfilled placeholder', () => {
  it.each(['beats', 'trial'])('%s', (name) => {
    expect(unfilled(built[name])).toEqual([]);
  });
});

// 2026-10-07: the beats writer's prose rules reach the trial writer as the SAME
// constants (zero extra calls — the trial runs no refine and no audit, so the
// writer prompt is the only place they can land). Pinned on the built prompts:
// the VALUE of each export is in both, the trial's scene arithmetic follows the
// page count, and the beats template's text is unchanged by the extraction.
describe('shared prose rules reach both writers as one constant each', () => {
  const {
    PERIL_CEILING_RULE,
    NO_DASH_RULE,
    PAGE_CONTINUITY_RULE,
    NEIGHBOUR_PHRASE_RULE,
    NO_ABBREVIATION_RULE,
    ARC_QUESTIONS_ANSWERED_RULE,
    buildTitleRule,
    titleCriteria,
  } = require('../../server/lib/promptBuilders.js');

  const shared: Array<[string, string]> = [
    ['PERIL_CEILING_RULE', PERIL_CEILING_RULE],
    ['NO_DASH_RULE', NO_DASH_RULE],
    ['PAGE_CONTINUITY_RULE', PAGE_CONTINUITY_RULE],
    ['NEIGHBOUR_PHRASE_RULE', NEIGHBOUR_PHRASE_RULE],
    ['NO_ABBREVIATION_RULE', NO_ABBREVIATION_RULE],
  ];
  for (const [name, value] of shared) {
    it.each(['beats', 'trial'])(`${name} reaches %s`, (writer) => {
      expect(value.length).toBeGreaterThan(20);
      expect(built[writer]).toContain(value);
    });
  }

  it('each shared rule is stated once per prompt, never duplicated', () => {
    for (const [, value] of shared) {
      for (const writer of ['beats', 'trial']) {
        const hits = built[writer].split(value).length - 1;
        expect(hits, `${value.slice(0, 30)} in ${writer}`).toBe(1);
      }
    }
  });

  it('the trial carries the beats title rule and the pick criteria on its single TITLE line', () => {
    expect(built.trial).toContain(buildTitleRule(input({ trialMode: true })));
    expect(built.trial).toContain('does not spoil the ending');
    expect(built.trial).toContain(titleCriteria(8));
    expect(built.beats).toContain(titleCriteria(8));
    // The parser reads the one `TITLE:` line (outlineParser/unified.js); the
    // rule rides on the next line, never on it.
    expect(built.trial).toMatch(/^TITLE: \[A creative, specific title in [^\]]+\]\n\(Every title is in the story language/m);
  });

  it('the trial writer, its own arc creator, gets the stakes rule the arc creator and critics read', () => {
    expect(built.trial).toContain(ARC_QUESTIONS_ANSWERED_RULE);
  });

  it('the trial scene arithmetic follows the page count (6 pages since 2026-10)', () => {
    const six = buildTrialStoryPrompt(input({ trialMode: true, storyTheme: 'pirate' }), 6);
    expect(unfilled(six)).toEqual([]);
    expect(six).toContain('build tension (2-4), resolve (5-6)');
    expect(six).toContain('Keep it MINIMAL for a 6-scene story');
    expect(six).toContain('3-6 backgrounds');
    expect(six).toContain('A 6-page story rarely benefits');
    expect(six).toContain('at least 4 out of 6');
    expect(six).not.toMatch(/5-scene|out of 5|5-page story|resolve \(4-5\)|3-5 backgrounds/);
    // The 5-page build keeps the split the template used to hard-code.
    expect(built.trial).toContain('build tension (2-3), resolve (4-5)');
  });

  it('the trial does not keep its old refuses/gives-up bullet beside the continuity rule', () => {
    expect(built.trial).not.toContain('stays done with it; where a later scene');
  });
});
