import { describe, it, beforeAll, expect } from 'vitest';

const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

const AD_TEMPLATES = ['sceneExpansionAll', 'sceneExpansion'] as const;
const ruleIds = (t: string) =>
  (t.match(/^[0-9]+[a-z]?\. \*\*/gm) || []).map(s => s.replace(/\. \*\*$/, ''));

/**
 * The Art Director templates carry 56 numbered per-page rules, and TWO of them
 * shared the id `8k`: "A face is a field" and "A creature in frame has a written
 * face". A rule cannot be cited, and a finding cannot name a rule, when the id
 * resolves to two different rules.
 *
 * The ids are load-bearing beyond these two files — prompts/scene-review.txt
 * cites "rule 7g", server/lib/promptBuilders.js cites "rule 12b", and fourteen
 * intra-template references name 1b / 3 / 7b / 8d / 8i / 8j / 10d / 11 / 11d /
 * 11e / 12e. That is why the ORDER was deliberately left alone (see the
 * decisions entry): renumbering would break every one of them, and reordering a
 * prompt changes what the model reads, for no measured benefit.
 */
describe('an Art Director rule id names exactly one rule', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  for (const key of AD_TEMPLATES) {
    it(`${key} has no duplicate rule id`, () => {
      const ids = ruleIds(String(PROMPT_TEMPLATES[key] || ''));
      expect(ids.length, `${key}: no numbered rules found — did the format change?`).toBeGreaterThan(40);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect([...new Set(dupes)]).toEqual([]);
    });
  }

  it('both templates carry the SAME rule ids — they are a registered sibling pair', () => {
    const [all, per] = AD_TEMPLATES.map(k => ruleIds(String(PROMPT_TEMPLATES[k] || '')));
    expect([...all].sort()).toEqual([...per].sort());
  });

  it('the creature-face rule kept its own id, and the expression rule kept 8k', () => {
    for (const key of AD_TEMPLATES) {
      const t = String(PROMPT_TEMPLATES[key] || '');
      expect(t).toMatch(/^8k\. \*\*A face is a field\.\*\*/m);
      expect(t).toMatch(/^8l\. \*\*A creature in frame has a written face\.\*\*/m);
    }
  });

  it('every rule id an outside file cites still exists in both templates', () => {
    // The cross-references that make renumbering expensive.
    for (const key of AD_TEMPLATES) {
      const ids = new Set(ruleIds(String(PROMPT_TEMPLATES[key] || '')));
      for (const cited of ['7g', '12b', '1b', '3', '7b', '8d', '8i', '8j', '10d', '11', '12e']) {
        expect(ids.has(cited), `${key}: rule ${cited} is cited elsewhere but no longer defined`).toBe(true);
      }
    }
  });
});
