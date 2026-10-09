/**
 * UNREQUESTED LETTERING IS NEVER SENT TO THE IMAGE MODEL AS LETTERS.
 *
 * Staging job_1791531449494_o0kaatvmq p3. v0 had only a carved ornament band on
 * the two church towers; the quality judge's lettering inventory misread it as
 * "BANZ" and filed a CRITICAL rendered_text finding. The repair instruction
 * quoted the word ("Paint over 'BANZ' on stone bands of both church towers."),
 * and Grok PAINTED "BANZ" onto both towers: the repair created the defect it
 * was told to remove. Fixtures below are the stored shapes of that page.
 *
 * Only the network boundary (Grok's edit call) is stubbed; inpaintPage runs for
 * real. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const grok = require_('../../server/lib/grok');
let sent: string[] = [];
grok.isGrokConfigured = () => true;
grok.packReferences = async () => [];
grok.editWithGrok = async (p: string) => { sent.push(p); return { imageData: 'data:image/jpeg;base64,' + 'A'.repeat(2000), modelId: 'grok-imagine-image', usage: {} }; };
grok.generateWithGrok = async () => { throw new Error('not used'); };

const images = require_('../../server/lib/images');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { redactReadLettering } = require_('../../server/lib/letteringCheck');
const { redactPlanLettering } = require_('../../server/lib/feedbackConsolidator');
const { buildRegenFeedback } = require_('../../server/lib/repairPipeline');

// Stored v0 of the page: what the inventory read, and the consolidated plan.
const INVENTORY = {
  items: [
    { text: 'BANZ', surface: 'stone band near top of left tower', position: 'center-background', spelling: 'correct', placement: 'misplaced' },
    { text: 'BANZ', surface: 'stone band near top of right tower', position: 'center-background', spelling: 'correct', placement: 'misplaced' },
  ],
  declared: [],
};
const FINDING = {
  type: 'rendered_text', severity: 'CRITICAL',
  description: "Lettering 'BANZ' appears on stone bands of both church towers",
  fix: 'Inpaint the text region as continuous scene material — no readable writing.',
};
const PLAN = () => ({
  scene_fix: {
    ids: ['Q2', 'Q3'], types: ['rendered_text'], severity: 'CRITICAL', requires_regeneration: false,
    preserve: ['twin cream-colored romanesque church towers with pyramidal cupolas'],
    fix_draft: "Paint over the lettering 'BANZ' on the stone band near the top of the left tower and on the stone band near the top of the right tower.",
    instruction: "Paint over 'BANZ' on stone bands of both church towers.",
    fix_critique: "Name the 'BANZ' bands as one class of object.",
  },
  per_character_fixes: [],
});

describe('redactReadLettering', () => {
  it('names the surface and never the word', () => {
    expect(redactReadLettering("Paint over 'BANZ' on stone bands of both church towers.", INVENTORY))
      .toBe('Paint over the lettering on stone bands of both church towers.');
    expect(redactReadLettering("Paint over the lettering 'BANZ' on the stone facade", INVENTORY))
      .toBe('Paint over the lettering on the stone facade');
    expect(redactReadLettering("Lettering 'BANZ' appears on the towers", INVENTORY))
      .toBe('The lettering appears on the towers');
    expect(redactReadLettering('Remove the word BANZ from the towers', INVENTORY))
      .toBe('Remove the lettering from the towers');
  });

  it('handles typographic quotes and multi-word captions', () => {
    const rec = { items: [{ text: 'TENSE BUT QUIET STANDOFF' }], declared: [] };
    expect(redactReadLettering('Remove the caption “tense but quiet standoff” at the bottom', rec))
      .toBe('Remove the lettering at the bottom');
  });

  it('leaves a string the page declares, and text without a record, untouched', () => {
    const declared = { items: [{ text: 'Löwenatem' }], declared: ['Löwenatem'] };
    expect(redactReadLettering("Repaint 'Löwenatem' exactly as written", declared)).toBe("Repaint 'Löwenatem' exactly as written");
    expect(redactReadLettering("Paint over 'BANZ'", null)).toBe("Paint over 'BANZ'");
    expect(redactReadLettering("Paint over 'BANZ'", { items: [], declared: [] })).toBe("Paint over 'BANZ'");
  });

  it('does not eat ordinary words that merely contain a short reading', () => {
    expect(redactReadLettering('A banzai tree', INVENTORY)).toBe('A banzai tree');
  });

  it('keeps a reading that is also an ordinary word when the prose uses it as a word', () => {
    const sign = { items: [{ text: 'DRAGON' }, { text: 'THE' }], declared: [] };
    expect(redactReadLettering('Keep the dragon beside the egg; paint over the word DRAGON on the sign', sign))
      .toBe('Keep the dragon beside the egg; paint over the lettering on the sign');
  });
});

describe('redactPlanLettering: the consolidated plan', () => {
  it('strips every field that reaches or drafts for the image model, keeps the humans description', () => {
    const plan: any = PLAN();
    plan.deduped_issues = [{ type: 'rendered_text', description: FINDING.description }];
    redactPlanLettering(plan, INVENTORY);
    for (const f of ['instruction', 'fix_draft', 'fix_critique']) expect(plan.scene_fix[f]).not.toContain('BANZ');
    expect(plan.scene_fix.instruction).toBe('Paint over the lettering on stone bands of both church towers.');
    expect(plan.deduped_issues[0].description).toContain('BANZ');
  });
});

describe('buildRegenFeedback: the regenerate leg', () => {
  it('does not carry the read word into the re-render prompt', () => {
    const out = buildRegenFeedback({ evaluated: true, fixableIssues: [FINDING], letteringInventory: INVENTORY });
    expect(out).toContain('the lettering appears on stone bands of both church towers'.replace('the', 'The'));
    expect(out).not.toContain('BANZ');
  });
});

describe('inpaintPage: what the image model receives', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  beforeEach(() => { sent = []; });

  const run = (inventory: any, plan: any) => images.inpaintPage('data:image/jpeg;base64,AAAA',
    { fixableIssues: [FINDING, { type: 'action_interaction', severity: 'MAJOR', description: 'a second finding, so the plan (not the sole-fix shortcut) is sent' }], letteringInventory: inventory },
    { consolidatedPlan: plan, characters: [], pageNumber: 3, aspectRatio: '3:4' });

  it('a repair of unrequested lettering never sends the letters (plan stored with the quote)', async () => {
    await run(INVENTORY, PLAN());
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('BANZ');
    expect(sent[0]).toContain('1. Paint over the lettering on stone bands of both church towers.');
  }, 30000);

  it('required lettering is still quoted when the page declares it', async () => {
    const declaredInv = { items: [{ text: 'Löwenatem', placement: 'misplaced', spelling: 'misspelled' }], declared: ['Löwenatem'] };
    const plan: any = PLAN();
    plan.scene_fix.instruction = "Repaint the title 'Löwenatem' exactly as written.";
    await run(declaredInv, plan);
    expect(sent[0]).toContain("'Löwenatem'");
  }, 30000);
});
