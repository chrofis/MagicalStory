/**
 * TEXT CHAIN FIXES, staging job_1791489793707_2ir6nl5kw (owner mandate
 * 2026-10-08). Prompt-content tests on the BUILT prompts, one per defect:
 * p9 "die auch steif waren" / p11 "fing das Ei ... Es lag" (a sentence that
 * undoes itself), p13 a head turn the picture does not stage, p14 a half-closed
 * MISMATCH, p17 "Die Kaelte fiel auf den Lindenhof", p18 a character naming her
 * own shame, background children dressed like the cast.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { SLOP_RULES, PERSONIFIED_FORCE_RULE, OWN_FEELING_RULE } = require('../../server/lib/proseSlop');

const story = { language: 'de', pages: 4, characters: [{ name: 'Mara', age: 7, isMain: true }] };
const pages = [{ pageNumber: 1, text: 'Eine Seite.', planLine: 'wide — Mara — Mara pulls the rope — the sail is up' }];

describe('text chain 2026-10-08', () => {
  let writer: string, blind: string, audit: string, refine: string;
  beforeAll(async () => {
    await loadPromptTemplates();
    writer = PB.buildStoryTextFromBeatsPrompt(story, [{ pageNumber: 1, planLine: pages[0].planLine }], [], 'An arc.');
    blind = PB.buildTextAuditBlindPrompt(story, pages);
    audit = PB.buildTextAuditPrompt(story, pages, 'An arc.');
    refine = PB.buildTextRefinePrompt(story, pages, 'T1 FAULT[MISMATCH]: p1 — x', 'An arc.');
  });

  it('the two figure rules are in STYLE_RULEBOOK, so the writer and the blind audit read one copy', () => {
    expect(SLOP_RULES).toContain(PERSONIFIED_FORCE_RULE);
    expect(SLOP_RULES).toContain(OWN_FEELING_RULE);
    for (const r of [PERSONIFIED_FORCE_RULE, OWN_FEELING_RULE]) {
      expect(PB.STYLE_RULEBOOK).toContain(r);
      expect(writer).toContain(r);
      expect(blind).toContain(r);
    }
  });

  it('the own-feeling rule covers a thanks and the last page', () => {
    expect(OWN_FEELING_RULE).toMatch(/in a thanks or on the last page too/);
  });

  it('the writer never gives a thing two states or restates a property with also/too', () => {
    expect(writer).toContain('never gives one thing two states');
    expect(writer).toContain('"also" or "too"');
  });

  it('where a figure looks or turns is the picture\'s business', () => {
    expect(writer).toContain('where they look, face or turn their head');
  });

  it('the blind audit asks the LANGUAGE question and the arc audit names the same two cases', () => {
    expect(blind).toMatch(/8\. LANGUAGE:/);
    expect(blind).toContain('answer eight questions');
    expect(audit).toContain('a thing held or caught and then said to lie somewhere');
  });

  it('a MISMATCH naming two gaps is closed on both, and a spoken ending line is recast, never declined', () => {
    expect(refine).toContain('Each gap gets its own ledger line');
    expect(refine).toContain('closes half');
    expect(refine).toContain('never declined for the line being the story\'s');
    expect(refine).not.toContain("or the ending's own act or spoken line");
  });

  it('the brief prompts dress background people apart from the cast', () => {
    const fs = require('fs');
    for (const f of ['scene-briefs-all.txt', 'scene-expansion.txt']) {
      const t = fs.readFileSync(require('path').join(__dirname, '../../prompts', f), 'utf8');
      expect(t, f).toContain('Background people the prose places are dressed apart from the cast');
    }
  });
});
