/**
 * Form of address in story dialogue, 2026-10-12 (docs/decisions.md "Story dialogue uses tu/du within the family"):
 * the fr-ch instruction said "prefer vous", which leaked the UI register into dialogue
 * ("C'est pour vous, Grand-Papa" from a 4-year-old; prod job_1791748539342_ikyl88w1h).
 * The rule now lives in ONE map (languages.js ADDRESS_REGISTER) and reaches every STYLE_RULEBOOK reader.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';

const req = createRequire(import.meta.url);
const L = req('../../server/lib/languages.js');
const PB = req('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = req('../../server/services/prompts.js');

beforeAll(async () => { await loadPromptTemplates(); });

describe('ADDRESS_REGISTER', () => {
  it('French, German and Italian each get a rule naming the family form and the formal one', () => {
    expect(L.getAddressRegisterRule('fr-ch')).toMatch(/"tu"[\s\S]*"vous"/);
    expect(L.getAddressRegisterRule('de-ch')).toMatch(/"du"[\s\S]*"Sie"/);
    expect(L.getAddressRegisterRule('it-ch')).toMatch(/"tu"[\s\S]*"Lei"/);
  });
  it('the plural stays legal: "vous" / "ihr" / "voi" address several people', () => {
    expect(L.getAddressRegisterRule('fr-fr')).toContain('several people');
    expect(L.getAddressRegisterRule('de-de')).toContain('"ihr"');
    expect(L.getAddressRegisterRule('it-it')).toContain('"voi"');
  });
  it('every French variant and the legacy "fr" alias share the one rule; English has none', () => {
    const fr = L.getAddressRegisterRule('fr-ch');
    for (const c of ['fr', 'fr-fr', 'fr-be', 'fr-ca', 'fr-af']) expect(L.getAddressRegisterRule(c)).toBe(fr);
    expect(L.getAddressRegisterRule('en-gb')).toBe('');
    expect(L.getAddressRegisterRule(undefined)).toBe('');
  });
});

describe('the rule reaches every reader of the style rulebook', () => {
  it('styleRulebook carries it for fr/de/it and not for en', () => {
    expect(PB.styleRulebook('fr-ch')).toContain(L.getAddressRegisterRule('fr-ch'));
    expect(PB.styleRulebook('de-ch')).toContain(L.getAddressRegisterRule('de-ch'));
    expect(PB.styleRulebook('it-ch')).toContain(L.getAddressRegisterRule('it-ch'));
    expect(PB.styleRulebook('en')).not.toContain('address each other');
    expect(PB.styleRulebook('fr-ch')).toContain(PB.STYLE_RULEBOOK);
  });
  it('every template that fills {STYLE_RULEBOOK} (writer, trial pages, refine, proofread, diff, blind audit) is covered', () => {
    for (const t of ['story-text-from-beats', 'story-trial-pages', 'text-refine', 'story-text-proofread', 'story-text-diff', 'story-text-audit-blind']) {
      expect(fs.readFileSync(`prompts/${t}.txt`, 'utf8'), t).toContain('{STYLE_RULEBOOK}');
    }
  });
  it('the French instruction no longer tells the writer to prefer "vous" (regression: it contradicted the rule)', () => {
    for (const c of ['fr-ch', 'fr']) expect(L.getLanguageInstruction(c)).not.toMatch(/prefer "vous"/);
    expect(L.getLanguageInstruction('fr-ch')).toContain('(4) DIALOGUE TYPOGRAPHY');
  });
});
