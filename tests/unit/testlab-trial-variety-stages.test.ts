import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The two trial-variety Lab stages (trial_idea_variety, trial_challenge_draw).
 *
 * The idea stage MIRRORS prompt assembly that lives inline in an SSE route and
 * is exported from nowhere. A production edit the stage does not follow makes it
 * measure a prompt production never sends, silently — so the shared sentences
 * are pinned here against trial.js.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const lab = read('server/lib/testlab.js');
const trialRoute = read('server/routes/trial.js');
const clientStages = read('client/src/services/testlabService.ts');
const labRoute = read('server/routes/admin/testlab.js');

const ideaStage = lab.slice(
  lab.indexOf('async function runTrialIdeaVarietyStage'),
  lab.indexOf('async function runTrialChallengeDrawStage'),
);
const challengeStage = lab.slice(
  lab.indexOf('async function runTrialChallengeDrawStage'),
  lab.indexOf('const STORY_STAGES = {'),
);

describe('both stages are registered on BOTH sides', () => {
  for (const id of ['trial_idea_variety', 'trial_challenge_draw']) {
    it(`${id} is in STAGE_RUNNERS/STORY_STAGES and in the client TESTLAB_STAGES mirror`, () => {
      expect(lab).toMatch(new RegExp(`\\n  ${id}: run`));
      expect(clientStages).toMatch(new RegExp(`id: '${id}'`));
    });
    it(`${id} has a template prefill key, since it is marked overridable`, () => {
      expect(clientStages).toMatch(new RegExp(`id: '${id}'[^\\n]*overridable: true`));
      expect(labRoute).toMatch(new RegExp(`${id}: '`));
    });
  }
});

describe('the idea stage runs the production idea prompt, not a copy of it', () => {
  // The hand-copied mirror was the drift hazard. Assembly now lives in ONE
  // builder (buildTrialIdeaPrompts) that both sites call, so the pin is that
  // neither site rebuilds the branch sentences for itself.
  it('both the route and the stage call the shared builder', () => {
    for (const src of [trialRoute, ideaStage]) expect(src).toMatch(/buildTrialIdeaPrompts\(/);
  });

  for (const [where, src] of [['trial.js', () => trialRoute], ['the Lab stage', () => ideaStage]] as const) {
    it(`${where} hand-builds no part of the idea prompt`, () => {
      expect(src()).not.toContain('Set this idea ');
      expect(src()).not.toContain('Name no place beyond the landmarks listed above');
      expect(src()).not.toMatch(/PROMPT_TEMPLATES\.trialIdea/);
    });
  }

  it('passes the stage prompt override through the builder rather than mutating the template table', () => {
    expect(ideaStage).toMatch(/template: promptOverride \|\| null/);
  });

  it('rebuilds the prompts per draw, so the rotated variety axis is exercised', () => {
    expect(ideaStage).toMatch(/for \(let i = 1; i <= draws; i\+\+\)[\s\S]*buildTrialIdeaPrompts\(ideaArgs\)/);
  });

  it('uses the production idea model by default', () => {
    expect(ideaStage).toMatch(/params\.model \|\| 'claude-sonnet'/);
    expect(trialRoute).toMatch(/modelToUse = 'claude-sonnet'/);
  });

  it('records its own spend, like every other paid stage', () => {
    expect(ideaStage).toMatch(/const usage = \[\]/);
    expect(ideaStage).toMatch(/modelCalls: usage\.length/);
    expect(ideaStage).toMatch(/usage\.reduce\(\(a, u\) => a \+ \(u\.cost \|\| 0\), 0\)/);
  });

  it('caps the draw count so one run cannot become an unbounded spend', () => {
    expect(ideaStage).toMatch(/Math\.min\(Math\.max\(parseInt\(params\.draws, 10\) \|\| 5, 1\), 20\)/);
  });
});

describe('the idea grouping stays crude, and per arm', () => {
  // The grouping helper itself is unit-tested for BEHAVIOUR in
  // tests/unit/idea-premise-grouping.test.ts against experiments 1273/1274.
  // What only source can show is how the STAGE calls it — the stage function is
  // not exported and every path through it makes a paid model call.
  it('groups within an arm, never across the two — the arms are REQUIRED to differ', () => {
    // Pooling the arms would report the design (two arms that must differ in
    // kind) as repetition.
    expect(ideaStage).toMatch(/for \(const arm of \['local', 'fantasy'\]\)/);
    const armLoop = ideaStage.slice(ideaStage.indexOf("for (const arm of ['local', 'fantasy'])"));
    expect(armLoop).toMatch(/groupIdeas\w*\(ideas\b/);
  });

  it("excludes the experiment's own constants from the grouping evidence", () => {
    // The name/town/landmark recur in every draw by construction; counting them
    // reported five genuinely different wants as one premise (experiment 1274).
    expect(ideaStage).toMatch(/const constantWords = /);
    expect(ideaStage).toMatch(/groupIdeas\w*\(ideas, \{[^}]*constantWords/);
  });

  it('reports the raw ideas next to the counts, so the owner judges the list', () => {
    expect(ideaStage).toMatch(/repeatCount:/);
    expect(ideaStage).toMatch(/ideas: g\.members\.map\(m => m\.text\)/);
    expect(ideaStage).toMatch(/pairs,/);
  });

  it('the grouping is lexical — no model call, no embedding, no I/O', () => {
    // Pinned as behaviour, not as an internal formula: a grouping that reached
    // for a model or an embedding could not be synchronous, and could not be
    // deterministic across repeated calls.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { groupIdeasByPremise } = require('../../server/lib/testlab.js');
    const ideas = [1, 2, 3].map(draw => ({ draw, text: `Ein Kind versucht dreimal, dem Tier Nummer ${draw} zu helfen, und bemerkt dann den Weg.` }));
    const first = groupIdeasByPremise(ideas);
    expect(typeof (first as any).then).toBe('undefined');
    expect(Array.isArray(first)).toBe(true);
    expect(JSON.stringify(groupIdeasByPremise(ideas))).toBe(JSON.stringify(first));
  });
});

describe('the challenge-draw stage answers the band question explicitly', () => {
  it('reports the resolved band and whether production draws for it', () => {
    expect(challengeStage).toMatch(/ageBand: band/);
    expect(challengeStage).toMatch(/bandDrawsChallenges/);
    expect(challengeStage).toMatch(/bandShapeText/);
  });

  it('persists the draw the way the beats pipeline does', () => {
    const beats = read('server/lib/beatsPipeline.js');
    const extract = ".split('\\n').filter(l => l.startsWith('- ')).map(l => l.slice(2))";
    expect(beats).toContain(extract);
    expect(challengeStage).toContain(extract);
    expect(challengeStage).toMatch(/challengeDraw,/);
  });

  it('injects the draw only into the prompt it built itself — never into buildTrialStoryPrompt', () => {
    expect(challengeStage).toMatch(/runArm\('with-draw', `\$\{basePrompt\}\\n\\n\$\{drawSection\}`\)/);
    const builders = read('server/lib/promptBuilders.js');
    const trialBuilder = builders.slice(
      builders.indexOf('function buildTrialStoryPrompt'),
      builders.indexOf('// LANDMARK PHOTO HELPERS'),
    );
    expect(trialBuilder).not.toContain('buildChallengeIdeasSection');
  });

  it('refuses a with-draw arm that would have no challenges, naming the escape', () => {
    expect(challengeStage).toMatch(/no challenges drawn: band/);
    expect(challengeStage).toMatch(/params\.forceBands/);
  });

  it('records its own spend', () => {
    expect(challengeStage).toMatch(/modelCalls: usage\.length/);
    expect(challengeStage).toMatch(/usage\.reduce\(\(a, u\) => a \+ \(u\.cost \|\| 0\), 0\)/);
  });
});
