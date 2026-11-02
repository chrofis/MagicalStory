/**
 * Owner 2026-11-03 on prod trial job_1793658691447_2ctgv62ialb ("the story is a bit flat ... the story writer should write
 * one setback"): the old line "the setback or loss gets a scene of its own" let the planner count the fear itself as the
 * low point (9 of 20 stored prod trial stories had no setback). TRIAL_SETBACK_RULE is one constant both trial prompts read.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';
import { TRIAL_TEMPLATES } from './helpers/trialWriterPrompt';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Mila', age: 4, isMainCharacter: true }];
const input = () => ({ pages: 6, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard', trialMode: true });

beforeAll(async () => { await loadPromptTemplates(); });

describe('the trial writer writes one setback', () => {
  it('the rule asks for an event, not a feeling, on its own scene before a different resolving act', () => {
    const r = PB.TRIAL_SETBACK_RULE;
    expect(r).toMatch(/never a feeling alone/);
    expect(r).toMatch(/does not work/);
    expect(r).toMatch(/scene of its own/);
    expect(r).toMatch(/different act/);
  });

  it('the planner and the pages writer both get it, and the old line is gone from both templates', () => {
    expect(PB.buildTrialArcPrompt(input(), 6)).toContain(PB.TRIAL_SETBACK_RULE);
    expect(PB.buildTrialPagesPrompt(input(), 6, '')).toContain(PB.TRIAL_SETBACK_RULE);
    for (const f of TRIAL_TEMPLATES) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t).toContain('{TRIAL_SETBACK}');
      expect(t).not.toMatch(/the setback or loss/);
    }
  });
});
