import { describe, it, expect } from 'vitest';
// Staging trial job_1791560888615_uaivmr21o (ninja): the clothing check logged
// "the scene prose does not dress Serafin" on every page and the cover, because
// the trial writer was never told to name the costume in `imageSummary`, the
// only text the image model reads. Replay over 27 staging trials of 14 days:
// 12 of 82 costumed character-pages flagged (ninja 10 of 12). The rule must
// reach the page rule AND the cover note, and only when a costume exists.
const PB = require('../../server/lib/promptBuilders');

async function build(theme: string) {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  return PB.buildTrialStoryPrompt({ characters: [{ id: 'c1', name: 'Mia', age: 7, gender: 'girl' }], mainCharacters: ['c1'], language: 'de-ch', storyCategory: 'adventure', storyTheme: theme, storyDetails: 'x', artStyle: 'watercolor' }, 6);
}

describe('trial writer names the costume in imageSummary', () => {
  it('page rule and cover note carry it when the theme has a costume', async () => {
    const t = await build('ninja');
    expect(t).toContain('the `imageSummary` of that page also names what the costume is made of');
    expect(t).toContain('the `imageSummary` names the garments of the costume');
    expect(t).not.toMatch(/\{(CLOTHING_RULE|COVER_CLOTHING_NOTE)\}/);
  });
  it('is absent when the theme has no costume', async () => {
    const t = await build('no-such-theme-xyz');
    expect(t).not.toContain('names what the costume is made of');
    expect(t).not.toContain('names the garments of the costume');
  });
});
