import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts.js');
const { TRIAL_COSTUMES } = require('../../server/config/trialCostumes.js');
const { buildBodyRowPrompt } = require('../../server/lib/character2x4Sheet.js');

// Staging showcase job_1791222889407_ypl33vk8u: a 5-year-old's mermaid costume was
// rewritten by the wardrobe review into "a one-piece swimsuit ... and bare feet";
// pages drew a bare chest and feet. Both defects were fixed once before (the
// 2026-08-13 child-coverage rule, 2ea328b04 tail-has-no-feet) and came back because
// nothing pinned them. Every path a costume flows through must carry both rules.
beforeAll(async () => { await loadPromptTemplates(); });

describe('a child mermaid costume is a covering top plus one tail, no feet — on every path', () => {
  it('wardrobe writer: covering top, no one-piece/bikini/bare chest; leg-replacing tail with no feet', () => {
    const t = PROMPT_TEMPLATES.storyBibleFromBeats;
    expect(t).toMatch(/always has a covering top/);
    expect(t).toMatch(/swim shirt/);
    expect(t).toMatch(/never `bikini`, a bare chest, a bare midriff, or a one-piece/i);
    expect(t).toMatch(/replaces the legs[\s\S]{0,120}no feet, bare feet or footwear/i);
  });

  it('wardrobe reviewer: enforces the same two rules and may not trade them away for variety', () => {
    const t = PROMPT_TEMPLATES.clothingReview;
    expect(t).toMatch(/no covering top[\s\S]{0,200}one-piece/i);
    expect(t).toMatch(/footwear, feet or bare feet/);
    expect(t).toMatch(/never the garment given up/);
  });

  it('sheet prompt: a leg-replacing costume has no legs, feet or footwear', () => {
    const p = buildBodyRowPrompt('a long-sleeve blue swim shirt and one mermaid tail replacing the legs', { name: 'Emma', age: 5 }, false, 'mermaid');
    expect(p).toMatch(/replaces the legs[^.]*NO legs, NO feet and NO footwear/);
  });

  it('page prompts: both scene-brief templates draw the tail/fin instead of bottom and feet', () => {
    for (const name of ['sceneExpansion', 'sceneBriefsAll']) {
      expect(PROMPT_TEMPLATES[name], name).toMatch(/tail\/fin in place of bottom and footwear/);
    }
  });

  it('trial costume: covering swim shirt, one tail replacing the legs, no feet', () => {
    for (const sex of ['male', 'female']) {
      const d: string = TRIAL_COSTUMES.adventure.mermaid[sex];
      expect(d).toMatch(/swim shirt/);
      expect(d).toMatch(/tail replacing the legs/);
      expect(d).toMatch(/no feet/);
      expect(d).not.toMatch(/skirt|bikini|one-piece/i);
    }
  });
});
