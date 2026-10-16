/**
 * THE WORLD FRAME (owner, 2026-10-16; docs/decisions.md). A story that opens at
 * real places must not simply contain something impossible: it is a
 * make-believe world from page one, the real world throughout, or a staged
 * crossing. ONE constant reaches the creator, the re-teller, the creator's own
 * critique, the panel and the trial arc writer.
 *
 * Pins BEHAVIOUR: which built prompt carries the shared string. Never wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input: any = {
  language: 'en', languageLevel: '1st-grade', storyCategory: 'adventure', storyTheme: 'pirate',
  storyDetails: 'A pirate ship lies in a leaf pile.',
  characters: [{ id: 'a', name: 'Anna', age: 7, gender: 'female' }, { id: 'b', name: 'Ben', age: 5, gender: 'male' }],
  mainCharacters: ['a'], pages: 4, season: 'autumn', artStyle: 'watercolor',
};
const unfilled = (p: string) => String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [];

describe('world frame: one string, every arc reader', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the creator, the re-teller, the panel and the trial arc writer read the same string', () => {
    const rule = PB.WORLD_FRAME_RULE;
    expect(typeof rule).toBe('string');
    const built = {
      create: PB.buildArcCreatePrompt(input, 12),
      retell: PB.buildArcRetellPrompt(input, 12, 'ARC: a committed arc', 'SOLUTION: one'),
      panel: PB.buildArcPanelPrompt(input, 'ARC: a committed arc'),
      trial: PB.buildTrialArcPrompt(input, 5),
    };
    for (const [name, p] of Object.entries(built)) {
      expect(String(p), name).toContain(rule);
      expect(unfilled(String(p)), name).not.toContain('{WORLD_FRAME}');
      expect(unfilled(String(p)), name).not.toContain('{WORLD_FRAME_RULE}');
    }
  });

  it("the creator's critique spec checks it, and a frame fault is MAJOR so the re-tell gate runs", () => {
    expect(PB.arcCritiqueSpec({ inputData: input })).toContain(PB.WORLD_FRAME_RULE);
    expect(PB.arcCritiqueSpec({ retell: true, inputData: input })).toContain(PB.WORLD_FRAME_RULE);
    expect(PB.ARC_SEVERITY_DEF).toMatch(/impossible/);
  });
});
