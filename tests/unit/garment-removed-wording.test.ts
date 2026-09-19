import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

/**
 * 10d used to open "the prose and `sceneIntent` both state the character is
 * WITHOUT it" — exactly what 12b forbids ("Never name what must be absent...
 * 'no glow', 'bare rail' each paint the named thing into the picture").
 *
 * Measured on staging job_1789759147125_p08djwhbl, where the jacket comes off on
 * p6 and the cap on p15: not one of the 18 briefs says "without". The Art
 * Director obeyed 12b and the rule's INTENT — "hair exposed to the evening
 * chill", "light blonde hair uncovered", "He stands bareheaded" — and named
 * where the item had gone every time.
 */
describe('a removed garment is shown by what is there, not by what is gone', () => {
  it('no longer instructs the phrasing 12b bans', () => {
    expect(pb.GARMENT_REMOVED_RULE).not.toMatch(/state the character is WITHOUT it/);
    expect(pb.GARMENT_REMOVED_RULE).toContain('never by naming the missing item');
  });

  it('asks for the positive description the model already writes', () => {
    expect(pb.GARMENT_REMOVED_RULE).toMatch(/the bare head, the uncovered hair, the shirt now outermost/);
  });

  it('keeps every contract it had — the place, the interaction, the off row', () => {
    const r = pb.GARMENT_REMOVED_RULE;
    expect(r).toContain('name where it now lies or is held');
    expect(r).toContain('`interactions[]` entry for that place');
    expect(r).toContain('`wornItems` row with `state: "off"`');
    expect(r).toContain('that place as its `location`');
    expect(r).toContain('redressNote');
  });

  it('reaches BOTH Art Director templates through the one placeholder', async () => {
    await loadPromptTemplates();
    const { PROMPT_TEMPLATES } = require('../../server/services/prompts');
    for (const key of ['sceneExpansionAll', 'sceneExpansion']) {
      const t = String(PROMPT_TEMPLATES[key] || '');
      expect(t, `${key} lost its {GARMENT_REMOVED} placeholder`).toContain('{GARMENT_REMOVED}');
      expect(t, `${key} hand-copied the rule instead of citing it`).not.toContain('state the character is WITHOUT it');
    }
  });
});
