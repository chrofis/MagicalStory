/**
 * Prod job_1793561351885_kkg5gxkbj (2026-11-01): the Visual Bible writer gave an invented child "no garment; bare
 * shoulders and upper body" while the image judge (image-evaluation.txt D-05f child_torso_uncovered) scores a bare
 * child torso CRITICAL, and the repair then dressed her in the main child's outfit. The covering-top rule was held by
 * the wardrobe writer and reviewer only. One constant, WARDROBE_RULES.CHILD_TOP_DEF, now also reaches both Visual
 * Bible writers (sibling set vb-secondary-clothing-vs-image-eval).
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];
const RULE = () => PB.WARDROBE_RULES.CHILD_TOP_DEF;

beforeAll(async () => { await loadPromptTemplates(); });

describe('the covering-top rule reaches the Visual Bible writers', () => {
  it('the constant is exported and is the wardrobe rule', () => {
    expect(RULE()).toMatch(/covering top/);
  });

  it('the full-story Visual Bible writer prompt carries it verbatim', () => {
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(RULE());
  });

  it('the trial Visual Bible writer prompt carries it verbatim', () => {
    expect(PB.buildTrialArcPrompt(input(), 4)).toContain(RULE());
  });

  it('the same constant is what the wardrobe writer is given', () => {
    expect(fs.readFileSync('prompts/story-bible-from-beats.txt', 'utf8')).toContain('{CHILD_TOP_DEF}');
    expect(fs.readFileSync('prompts/visual-bible.txt', 'utf8')).toContain('{CHILD_TOP_DEF}');
    expect(fs.readFileSync('prompts/story-trial-arc.txt', 'utf8')).toContain('{CHILD_TOP_DEF}');
  });

  it('no test-story wording in the rule or the template lines', () => {
    const t = fs.readFileSync('prompts/visual-bible.txt', 'utf8');
    expect(t).not.toMatch(/mermaid|Nerina|Ludovica/i);
  });
});
