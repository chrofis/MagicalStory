import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pb = require('../../server/lib/promptBuilders');
const ROOT = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Reach, not wording: each rule added 2026-10-08 is ONE constant that every
// consumer fills (generator-vs-critic), and the idea axis stays one short line.
describe('rules from the mermaid/ninja review reach every consumer', () => {
  it('the dialogue rule is in the shared rulebook every prose pass is filled with', () => {
    expect(pb.STYLE_RULEBOOK).toMatch(/invents a rule/);
    for (const f of ['prompts/story-text-from-beats.txt', 'prompts/story-text-audit-blind.txt', 'prompts/story-text-proofread.txt', 'prompts/story-text-diff.txt']) {
      expect(read(f)).toContain('{STYLE_RULEBOOK}');
    }
  });

  it('the load-bearing rule keeps a fact from being applied against the plot turn, and reaches refine, audit and the writer', () => {
    expect(pb.LOAD_BEARING_RULE).toMatch(/against the story's own turn/);
    for (const f of ['prompts/text-refine.txt', 'prompts/story-text-audit.txt']) {
      expect(read(f)).toContain('{LOAD_BEARING}');
    }
  });

  it('the arc logic spec asks one fact per world-rule line, and the every-child rule covers adults and answered wants', () => {
    const spec = pb.arcLogicSpec({}, 10);
    expect(spec).toMatch(/one fact per line/);
    expect(pb.EVERY_CHILD_ACTS_RULE).toMatch(/commissioned adult/);
  });

  it('the idea axis offers a companion only as a conditional and stays one short line', () => {
    const { text } = pb.nextIdeaVarietyAxis();
    expect(text).toMatch(/otherwise none/);
    expect(text.split(/\s+/).length).toBeLessThan(70);
  });

  it('the idea commission rule gives the no-commission case a source: the theme\'s own world', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TRIAL_IDEA_COMMISSION_RULE } = require('../../server/lib/trialIdeaCheck');
    expect(TRIAL_IDEA_COMMISSION_RULE).toMatch(/theme's own world/);
    for (const f of ['prompts/generate-story-ideas.txt', 'prompts/generate-story-idea-single.txt']) {
      expect(read(f)).toMatch(/theme's own world/);
    }
  });

  it('the trial writer lets a one-page person stay nameless', () => {
    expect(read('prompts/story-trial-arc.txt')).toMatch(/one page only gets no entry and no name/);
  });
});
