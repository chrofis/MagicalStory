/**
 * The back-cover slot contract of the `story-idea-templates` sibling set, pinned
 * at the ROUND-10 state — the best measured version on the buy axis (blind 3.90).
 *
 * Rounds 11-13 each moved the defect axes and none of them moved the buy axis, so
 * the screen of 2026-09-21 restarts from round 10: the committed templates are
 * byte-identical to `902399b9b`, and the four single-change variants being
 * screened live in the harness (`tests/manual/story-idea-rounds.js --variant=`),
 * never in these files. This test is what stops a variant leaking into the
 * committed baseline.
 *
 * Both templates carry the same contract; a slot present in one and not the other
 * reads as absent on whichever template a request routes to.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TEMPLATES = ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt'];
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('story-idea templates — the round-10 slot list, in both siblings', () => {
  // The single template numbers its slots; the two-idea template states the same
  // contract as prose. The RULES bullets are shared verbatim and are the pin.
  it('the single template numbers THE PROMISE as a slot', () => {
    expect(read(TEMPLATES[0])).toMatch(/THE PROMISE: one thing that happens in this book/);
  });

  it.each(TEMPLATES)('%s states the promise and hook rules', (t) => {
    const src = read(t);
    expect(src).toContain('One sentence is an event this book contains');
    expect(src).toContain('One thing in the idea is out of the ordinary');
  });

  // Owner, 2026-09-21: "act" joins the label list, a "cost" may stand anywhere,
  // and the last sentence is the picture — not the cost line.
  it.each(TEMPLATES)('%s labels and keeps setup, hook, promise, cost and act; cuts event and rule', (t) => {
    const src = read(t);
    expect(src).toContain('"setup", "hook", "promise", "event", "rule", "cost" or "act"');
    expect(src).toContain('Only "event" and "rule" are cut');
    expect(src).toContain('Setup, hook, promise, cost and act are kept');
    expect(src).toContain('A "cost" may stand anywhere and is kept');
    expect(src).toContain('the last sentence is labelled "act" and kept');
    expect(src).not.toContain('Setup, hook, promise and cost are kept');
  });

  // Reversal of the 2026-09-14 fixed-length line: the count comes from
  // {STORY_SCOPE}, so no template may carry a range of its own.
  it.each(TEMPLATES)('%s defers the sentence count to the scope, with the 30-word bound kept', (t) => {
    const src = read(t);
    expect(src).not.toMatch(/[Ff]our to six sentences/);
    expect(src).not.toMatch(/[Tt]hree to five sentences/);
    expect(src).not.toContain('at most one sentence per slot');
    expect(src).not.toMatch(/Past six sentences, or past 30 words/);
    expect(src).toContain('the sentence count the scope names');
    expect(src).toMatch(/No sentence runs past about 30 words/);
    expect(src).toContain('{STORY_SCOPE}');
  });

  it.each(TEMPLATES)('%s ends on the picture and states the cost wherever it fits', (t) => {
    const src = read(t);
    expect(src).not.toContain('The last sentence states what failing costs. Nothing comes after it.');
    expect(src).toContain('The idea names what failing costs, wherever it fits');
    expect(src).toContain('The last sentence is the main character in the act, the picture a parent can see.');
    expect(src).toContain('Every sentence carries one concrete thing a reader can see');
  });

  it.each(TEMPLATES)('%s keeps the hook and promise quoting checks', (t) => {
    const src = read(t);
    expect(src).toMatch(/\bHook\*{0,2}:/);
    expect(src).toMatch(/\bPromise\*{0,2}:/);
  });
});

describe('story-idea templates — the round-10 cast and adult rules', () => {
  it.each(TEMPLATES)('%s names the responsible adult and denies a stake to co-location', (t) => {
    const src = read(t);
    expect(src).toContain('The youngest main character does something in the idea, and whoever is responsible for them is named.');
    expect(src).toContain('Living with, coming along with, or waiting for the others is not a stake');
  });

  it.each(TEMPLATES)('%s carries none of the rounds 11-13 wording', (t) => {
    const src = read(t);
    expect(src).not.toMatch(/An adult is in the idea only when the story needs them/);
    expect(src).not.toMatch(/Every named adult does one thing/);
    expect(src).not.toMatch(/One sentence is the turn/);
  });

  it.each(TEMPLATES)('%s keeps the cast rule', (t) => {
    expect(read(t)).toMatch(/All the characters must be mentioned|All characters must appear/);
  });
});

describe('story-idea templates — the round-10 examples', () => {
  it.each(TEMPLATES)('%s carries the three round-10 examples, each ending on a cost', (t) => {
    const src = read(t);
    for (const opener of [
      'A stone in the wall of a ruin sits loose',
      'A bone as long as an arm lies half out of the gravel',
      'A goat is standing on the kitchen table',
    ]) {
      const start = src.indexOf(opener);
      expect(start).toBeGreaterThan(-1);
      const nl = src.indexOf('\n', start);
      const text = src.slice(start, nl === -1 ? undefined : nl).replace(/"$/, '');
      const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(4);
      expect(sentences.length).toBeLessThanOrEqual(6);
      expect(text).toMatch(/^If .*|.*\bIf \b.*$/);
      expect(text).not.toMatch(/\b(reader|this book|the page|the picture)\b/i);
    }
  });
});
