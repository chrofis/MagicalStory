import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

/**
 * THE RENDERING FAILURE THIS ANSWERS (owner, 2026-09-19).
 *
 * When one figure sends something toward another — a ball, a snowball, a play
 * arrow — the image model draws both figures and not the line between them:
 * nothing says who is acting on whom. And staged flat it also collapses the
 * distance, drawing two figures almost touching however many paces the sentence
 * claims.
 *
 * Two framings answer the two halves, and the page takes one:
 *   over-the-shoulder — the camera axis IS the line of the action, so the
 *     DIRECTION holds whether or not the picture understood the verb;
 *   ultra-wide — the DISTANCE is readable, at the cost of the actor's face.
 *
 * The rule this replaced forced ultra-wide alone and left the direction to the
 * model's reading of the sentence. The four framing patterns it carried
 * (solo-before / solo-after / over-the-shoulder / side) were written in April
 * 2026 for "violence-adjacent scenes" and were keyed to a `framingPattern` no
 * stage ever set: 0 non-null across 139 stored staging stories.
 */
describe('a gap action is framed over the shoulder or ultra-wide, never flat', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('offers both framings and prefers the one that cannot fail', () => {
    const r = pb.GAP_ACTION_FRAMING_RULE;
    expect(r).toContain('OVER THE SHOULDER');
    expect(r).toContain('ULTRA-WIDE');
    expect(r).toContain('Take this one by default');
    expect(r).toMatch(/camera axis IS the line of the action/);
  });

  it('keeps the reason ultra-wide exists — a flat gap renders as almost touching', () => {
    expect(pb.GAP_ACTION_FRAMING_RULE).toContain('almost touching');
    expect(pb.GAP_ACTION_FRAMING_RULE).toContain('measured against something in the frame');
  });

  it('forbids the flat middle that states neither direction nor distance', () => {
    expect(pb.GAP_ACTION_FRAMING_RULE).toContain('flat middle');
  });

  it('the trigger is a sent thing, not a weapon', () => {
    const r = pb.GAP_ACTION_FRAMING_RULE;
    expect(r).toMatch(/sending, throwing, aiming, rolling or kicking/);
    expect(r).not.toMatch(/weapon/i);
  });

  it('reaches both Art Director templates as ONE constant', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion']) {
      const t = String(PROMPT_TEMPLATES[k] || '');
      expect(t, `${k} lost the placeholder`).toContain('{GAP_ACTION_FRAMING}');
      expect(t, `${k} kept the old weapon framing`).not.toMatch(/solo-before|weapon aim line/);
      expect(t, `${k} kept the old ultra-wide force`).not.toMatch(/`shot` MUST be `ultra-wide`/);
    }
  });
});

/**
 * ONE CAMERA FIELD (owner, 2026-09-19). over-the-shoulder is a `shot` value like
 * any other, not a second field beside it — "one field that has all options in
 * it, and do not use ots, but spell it out". `framingPattern` is retired
 * everywhere except the unreachable legacy outline-analysis path.
 *
 * The consumer it gates is real: storyJobPipeline drops background reference
 * photos on an over-the-shoulder page, because attaching a background
 * character's portrait forces the renderer to upsize them past "tiny in the
 * distance".
 */
describe('over-the-shoulder is a shot value, not a second field', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the vocabulary carries it, spelled out', () => {
    const { SHOT_TYPES } = require('../../server/lib/shotVocabulary');
    expect(SHOT_TYPES).toContain('over-the-shoulder');
    expect(SHOT_TYPES.join(' ')).not.toMatch(/ots/);
  });

  it('the rule sets `shot`, and names no second field', () => {
    const r = pb.GAP_ACTION_FRAMING_RULE;
    expect(r).toContain('set `shot` to `over-the-shoulder`');
    expect(r).not.toContain('framingPattern');
  });

  it('no live template mentions framingPattern any more', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion', 'sceneIteration', 'sceneIterationFree']) {
      expect(String(PROMPT_TEMPLATES[k] || ''), k).not.toContain('framingPattern');
    }
  });

  it('the ref-drop consumer reads the shot field', () => {
    const lf = (x: string) => x.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
    const pipeline = lf(require('fs').readFileSync(require('path').join(__dirname, '../..', 'storyJobPipeline.js'), 'utf-8'));
    expect(pipeline).toContain("pageShot === 'over-the-shoulder'");
    expect(pipeline).not.toContain("framingPattern === 'over-the-shoulder'");
  });
});
