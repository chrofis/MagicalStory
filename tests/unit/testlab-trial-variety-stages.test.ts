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

describe('the subject grouping stays crude, and per arm', () => {
  // testlab.js cannot be required in a unit test (its require graph opens the
  // DB pool), so these pin the source the way the other Lab-stage tests do.
  it('groups within an arm, never across the two — the arms are REQUIRED to differ', () => {
    expect(ideaStage).toMatch(/for \(const arm of \['local', 'fantasy'\]\)/);
    expect(ideaStage).toMatch(/groupIdeasBySubject\(ideas, overlap\)/);
  });

  it('reports the raw ideas next to the counts, so the owner judges the list', () => {
    expect(ideaStage).toMatch(/repeatCount:/);
    expect(ideaStage).toMatch(/ideas: g\.members\.map\(m => m\.text\)/);
    expect(ideaStage).toMatch(/pairs,/);
  });

  it('the grouping is word overlap only — no model call, no embedding', () => {
    const helper = lab.slice(lab.indexOf('function groupIdeasBySubject'), lab.indexOf('/**\n * TRIAL IDEA VARIETY'));
    expect(helper).not.toMatch(/callTextModel|await /);
    expect(helper).toMatch(/inter \/ union >= threshold/);
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
