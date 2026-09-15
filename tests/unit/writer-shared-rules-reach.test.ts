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
