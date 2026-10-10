import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PROMPT_TEMPLATES, loadPromptTemplates } = require('../../server/services/prompts.js');
const { TRIAL_COSTUMES } = require('../../server/config/trialCostumes.js');
const { buildOneCallSheetPrompt } = require('../../server/lib/character2x4Sheet.js');
const { WARDROBE_RULES } = require('../../server/lib/promptBuilders.js');

// Staging showcase job_1791222889407_ypl33vk8u: a 5-year-old's mermaid costume was
// rewritten by the wardrobe review into "a one-piece swimsuit ... and bare feet";
// pages drew a bare chest and feet. Both defects were fixed once before (the
// 2026-08-13 child-coverage rule, 2ea328b04 tail-has-no-feet) and came back because
// nothing pinned them. Every path a costume flows through must carry both rules.
beforeAll(async () => { await loadPromptTemplates(); });

describe('a child mermaid costume is a covering top plus one tail, no feet — on every path', () => {
  it('wardrobe writer: covering top, no one-piece/bikini/bare chest; leg-replacing tail with no feet', () => {
    // Since 2026-10-06 the two rules are shared constants (WARDROBE_RULES), filled into the writer and
    // the reviewer alike; the template carries the placeholders, the built prompt the words.
    const t = PROMPT_TEMPLATES.storyBibleFromBeats;
    expect(t).toContain('{CHILD_TOP_DEF}');
    expect(t).toContain('{TAIL_DEF}');
    expect(WARDROBE_RULES.CHILD_TOP_DEF).toMatch(/always has a covering top/);
    expect(WARDROBE_RULES.CHILD_TOP_DEF).toMatch(/swim shirt/);
    expect(WARDROBE_RULES.CHILD_TOP_DEF).toMatch(/never a `bikini`, a bare chest, a bare midriff, or a one-piece/i);
    expect(WARDROBE_RULES.TAIL_DEF).toMatch(/replaces the legs[\s\S]{0,120}no feet, bare feet or footwear/i);
  });

  it('wardrobe reviewer: enforces the same two rules and may not trade them away for variety', () => {
    const t = PROMPT_TEMPLATES.clothingReview;
    // the reviewer's check 10 and 6 read the SAME constants as the writer; its variety check reads
    // VARIETY_DEF, which now also reaches the writer (the exception the writer never saw)
    expect(t).toContain('{CHILD_TOP_DEF}');
    expect(t).toContain('{TAIL_DEF}');
    expect(t).toContain('{VARIETY_DEF}');
    expect(PROMPT_TEMPLATES.storyBibleFromBeats).toContain('{VARIETY_DEF}');
    expect(WARDROBE_RULES.VARIETY_DEF).toMatch(/never the garment given up/);
  });

  it('sheet prompt: a leg-replacing costume has no legs, feet or footwear', () => {
    const p = buildOneCallSheetPrompt({ name: 'Emma', age: 5 }, { costumeDescription: 'a long-sleeve blue swim shirt and one mermaid tail replacing the legs', costumeName: 'mermaid', styleLine: 'watercolour', kind: 'costume' });
    expect(p).toMatch(/replaces the legs[^.]*no legs, no feet and no footwear/);
    expect(p).toMatch(/never balanced upright on the fin/);
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
