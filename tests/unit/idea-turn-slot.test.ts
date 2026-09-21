/**
 * The TURN slot, the seam rules that were removed with it, and the HOOK and
 * PROMISE slots that were removed after round 12.
 *
 * Both templates of the `story-idea-templates` sibling set carry the same
 * back-cover contract; a slot added to one and not the other reads as absent on
 * whichever template the request routes to. Every blind 5 of the r10/r11 sets has
 * a second beat inside the premise; the 3s are a situation held still.
 *
 * The removed rules are pinned as ABSENT because each left a visible seam on the
 * page: a grandmother who stands at the wheel and looks at the water, a father who
 * calls and a mother who counts, a sibling handed an errand so he has a stake.
 *
 * HOOK and PROMISE went the same way in round 13. The world seed (a centre and a
 * turn, picked in code) already supplies the picturable thing and the change, so
 * both slots were duplicating it at a cost of two sentences; R12's blind read lost
 * six arms for being "too populated to follow on a back cover". Behaviour pinned,
 * not wording: the slots are gone from the slot list, the rules, the quoting
 * checks and the CUT labels, and the budget is three to five sentences.
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
    expect(src).toContain('"setup", "turn", "event", "rule" or "cost"');
    expect(src).toContain('Setup, turn and cost are kept');
    // Only event and rule are ever cut.
    expect(src).toContain('Only "event" and "rule" are cut');
  });

  it.each(TEMPLATES)('%s makes the review quote the turn or add one', (t) => {
    const src = read(t);
    expect(src).toMatch(/Turn\*{0,2}:\s*quote the sentence where something changes what the reader expected/);
    expect(src).toMatch(/If there is nothing to quote, add one to (\[FINAL\]|the final)\. If it says how the story goes on from there/);
  });

  it.each(TEMPLATES)('%s every example carries a turn and a cost', (t) => {
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

describe('story-idea templates — the hook and promise slots are gone from both siblings', () => {
  it.each(TEMPLATES)('%s declares neither slot in its slot list or output format', (t) => {
    const src = read(t);
    expect(src).not.toMatch(/THE PROMISE/);
    expect(src).not.toMatch(/an event the book contains/);
    expect(src).not.toMatch(/One sentence is an event this book contains/);
    expect(src).not.toMatch(/One thing in the idea is out of the ordinary/);
  });

  it.each(TEMPLATES)('%s has no hook or promise quoting check and no such CUT label', (t) => {
    const src = read(t);
    expect(src).not.toMatch(/\bHook\*{0,2}:/);
    expect(src).not.toMatch(/\bPromise\*{0,2}:/);
    expect(src).not.toMatch(/"promise"/);
    expect(src).not.toMatch(/"hook"/);
  });

  it.each(TEMPLATES)('%s asks for three to five sentences, at most one per slot', (t) => {
    const src = read(t);
    expect(src).toMatch(/[Tt]hree to five sentences/);
    expect(src).not.toMatch(/[Ff]our to six sentences/);
    expect(src).toContain('at most one sentence per slot');
    expect(src).toMatch(/Past five sentences, or past 30 words/);
  });

  it.each(TEMPLATES)('%s keeps the turn between the obstacle and the cost', (t) => {
    expect(read(t)).toContain('It stands between the obstacle and the cost');
  });

  it.each(TEMPLATES)('%s examples run three to five sentences and never address the reader', (t) => {
    const src = read(t);
    const openers = [
      'A stone in the wall of a ruin sits loose',
      'A bone as long as an arm lies half out of the gravel',
      'A goat is standing on the kitchen table',
    ];
    for (const opener of openers) {
      const start = src.indexOf(opener);
      expect(start).toBeGreaterThan(-1);
      const nl = src.indexOf('\n', start);
      const text = src.slice(start, nl === -1 ? undefined : nl).replace(/"$/, '');
      const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(3);
      expect(sentences.length).toBeLessThanOrEqual(5);
      expect(text).not.toMatch(/\b(reader|this book|the page|the picture)\b/i);
    }
  });
});
