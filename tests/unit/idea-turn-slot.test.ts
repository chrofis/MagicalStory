/**
 * The TURN slot, and the seam rules that were removed with it.
 *
 * Both templates of the `story-idea-templates` sibling set carry the same
 * back-cover contract; a slot added to one and not the other reads as absent on
 * whichever template the request routes to. Every blind 5 of the r10/r11 sets has
 * a second beat inside the premise; the 3s are a situation held still.
 *
 * The removed rules are pinned as ABSENT because each left a visible seam on the
 * page: a grandmother who stands at the wheel and looks at the water, a father who
 * calls and a mother who counts, a sibling handed an errand so he has a stake.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATES = ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt'];
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('story-idea templates — the turn is a slot in both siblings', () => {
  it.each(TEMPLATES)('%s declares the turn as a rule', (t) => {
    expect(read(t)).toContain('One sentence is the turn');
  });

  it.each(TEMPLATES)('%s cannot cut the turn: it is a CUT label and it is kept', (t) => {
    const src = read(t);
    expect(src).toContain('"setup", "hook", "turn", "promise", "event", "rule" or "cost"');
    expect(src).toContain('Setup, hook, turn, promise and cost are kept');
    // Only event and rule are ever cut.
    expect(src).toContain('Only "event" and "rule" are cut');
  });

  it.each(TEMPLATES)('%s makes the review quote the turn or add one', (t) => {
    const src = read(t);
    expect(src).toMatch(/Turn\*{0,2}:\s*quote the sentence where something changes what the reader expected/);
    expect(src).toMatch(/If there is nothing to quote, add one to (\[FINAL\]|the final)\. If it says how the story goes on from there/);
  });

  it.each(TEMPLATES)('%s every example carries a turn as well as a hook, a promise and a cost', (t) => {
    const src = read(t);
    for (const turn of [
      'Then he says the grandmother’s name',
      'The gravel slides, and there is more of the animal under it than one child can carry.',
      'The singing stops, and the whole garden decides it was the child who let the goat in.',
    ]) {
      expect(src).toContain(turn.replace('’', "'"));
    }
  });
});

describe('story-idea templates — the seam rules are gone from both siblings', () => {
  it.each(TEMPLATES)('%s no longer names a responsible adult or demands one action each', (t) => {
    const src = read(t);
    expect(src).not.toMatch(/whoever is responsible for them is named/);
    expect(src).not.toMatch(/Every named adult does one thing/);
    expect(src).not.toMatch(/standing by, waiting, watching or being at the wheel/);
  });

  it.each(TEMPLATES)('%s no longer denies a stake to someone who comes along or waits', (t) => {
    // The co-location clause is what forced an errand on a sibling who was
    // otherwise only present.
    expect(read(t)).not.toMatch(/Living with, coming along with, or waiting for the others is not a stake/);
  });

  it.each(TEMPLATES)('%s states the positive adult rule instead', (t) => {
    expect(read(t)).toContain(
      'An adult is in the idea only when the story needs them, and then they want something of their own.'
    );
  });

  it.each(TEMPLATES)('%s keeps the cast rule, and reconciles it with presence through the want', (t) => {
    const src = read(t);
    expect(src).toMatch(/All the characters must be mentioned|All characters must appear/);
    expect(src).toContain('someone waiting for them, someone they fetch it for. That is presence.');
  });

  it.each(TEMPLATES)('%s states the cost positively', (t) => {
    const src = read(t);
    expect(src).toContain('the cost is something of theirs');
    expect(src).not.toMatch(/never the end of an afternoon, an outing or a visit/);
  });
});
