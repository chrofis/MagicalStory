/**
 * Prod trial job_1792387012672_sl4o0ae0q (2026-10-19): the planner was told "max 2 artifacts" and had no `vehicles`
 * category, so a toy captain and its cardboard ship got no Visual Bible entry (the bear is missing on p1-p5, the ship
 * changes shape). 20 of 32 stored trials sat at the 2-artifact cap, 0 of 14 full stories lost a central item.
 * VB_CATEGORY_RULE is the one sentence both Visual Bible writers read (registry set vb-authoring-sites).
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { UnifiedStoryParser } = require('../../server/lib/outlineParser');
const { getElementsNeedingReferenceImages } = require('../../server/lib/visualBible');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }];
const input = () => ({ pages: 6, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];

beforeAll(async () => { await loadPromptTemplates(); });

describe('trial Visual Bible categories', () => {
  it('the trial planner states no per-category count and no cost sentence', () => {
    const p = PB.buildTrialArcPrompt(input(), 6);
    expect(p).not.toMatch(/max \*\*2 artifacts/);
    expect(p).not.toMatch(/max \*\*2 secondary/);
    expect(p).not.toMatch(/rarely benefits from more than 2/);
    expect(p).not.toMatch(/Every entry costs a reference image/);
    expect(p).not.toMatch(/one-scene rule/);
  });

  it('the trial schema has a vehicles category, and the shared rule reaches both writers', () => {
    const rule = PB.VB_CATEGORY_RULE;
    expect(rule).toMatch(/`vehicles`/);
    expect(rule).toMatch(/toy figure/);
    expect(rule).toMatch(/`artifacts` entry/);
    expect(rule).not.toMatch(/captain|bear|ship|Lego/i);
    const trial = PB.buildTrialArcPrompt(input(), 6);
    expect(trial).toContain(rule);
    expect(trial).toContain('"id": "VEH001"');
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(rule);
  });

  it('no built prompt leaves the placeholder unfilled and the templates carry the placeholder, not a copy', () => {
    expect(PB.buildTrialArcPrompt(input(), 6)).not.toContain('{VB_CATEGORY}');
    for (const f of ['prompts/visual-bible.txt', 'prompts/story-trial-arc.txt']) {
      const t = fs.readFileSync(f, 'utf8');
      expect(t).toContain('{VB_CATEGORY}');
      expect(t).not.toMatch(/never folded into `locations`/);
    }
  });

  it('the trial parser and the cell selector accept a VEH entry end to end', () => {
    const vb = { secondaryCharacters: [], animals: [], artifacts: [], locations: [], backgrounds: [{ pages: [1, 2, 3], description: 'a room' }],
      vehicles: [{ id: 'VEH001', label: 'cardboard ship', name: 'cardboard ship', pages: [1, 2, 3], scaleClass: 'person', colorAndDetails: 'brown cardboard hull' }] };
    const text = `---STORY ARC---\nPAGE 1: x | WITH: a; b | STATE: none\n\n---TITLE---\nTITLE: T Levin\n\n---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(vb)}\n\`\`\`\n`;
    const parsed = new UnifiedStoryParser(text, { isTrial: true }).extractVisualBible();
    expect(parsed.vehicles).toHaveLength(1);
    const cells = getElementsNeedingReferenceImages(parsed, 2, 1, 1);
    expect(cells.map((c: any) => c.id)).toContain('VEH001');
  });
});
