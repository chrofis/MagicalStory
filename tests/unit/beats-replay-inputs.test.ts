import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveReplayArc,
  resolveReplayArcHints,
  resolveReplayExpansions,
  buildReplayTextArgs,
  buildReplaySceneOptions,
} = require('../../server/lib/beatsReplayInputs.js');

// BEHAVIOUR PINNED: a Test Lab stage that replays a beats writer call builds the
// SAME inputs production builds for that step.
//
// `pipelineMode` is 'beats' in every environment, so the only story-text call
// production makes is
//   buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions, approvedArc, { arcHints })
// and the only all-pages Art Director call is
//   buildSceneExpansionAllPrompt(inputData, beats, { availableAvatars,
//     maxCharactersPerScene, finalArc, clothingRequirements })
//
// Three Lab stages (story_text_replay, writer_compare, beats_scenes) passed
// THINNER arguments — empty expansions, no arcHints, no finalArc — so every A/B
// through them measured a configuration production never runs. Production names
// the empty-expansions state a defect out loud:
//   "Step 6 has NO scene briefs — text is being written blind to the
//    illustrations … this is the OLD sibling behaviour"
// Assert the RULES and the wiring, never prompt wording.

const storyData = {
  outline: '---ARC---\nfallback arc from the outline transcript\n---BEATS---\n## Page 1\nPLAN: a\n',
  arcReviewReport: {
    finalArc: 'INCITING: the hero loses the key.\nCLIMAX: the hero gets it back.',
    arcHints: 'ISSUE: the middle sags → CHANGE: give page 4 a cost',
  },
  clothingRequirements: { Hero: { standard: { used: true, description: 'a green coat' } } },
  sceneImages: [
    { pageNumber: 1, sceneDescription: 'Wide shot of the hero at the gate.\n---METADATA---\nzone: top' },
    { pageNumber: 2, sceneDescription: 'The hero kneels in the snow.' },
    { pageNumber: 3, sceneDescription: '   ' },
  ],
};

const beats = [
  { pageNumber: 1, planLine: 'the hero arrives' },
  { pageNumber: 2, planLine: 'the hero kneels' },
];

const parseBeats = (raw: string) => ({
  arc: ((String(raw).match(/---ARC---([\s\S]*?)---BEATS---/) || [])[1] || '').trim(),
});

describe('beatsReplayInputs — the arc the writer actually got', () => {
  it('prefers the arc machine\'s approved output over the parsed outline', () => {
    // Production's `approvedArc` IS arcReviewReport.finalArc. The Lab used to
    // read only parseBeats(outline).arc, a strictly different string.
    const arc = resolveReplayArc(storyData, { parseBeats });
    expect(arc).toBe(storyData.arcReviewReport.finalArc);
    expect(arc).not.toContain('fallback arc from the outline transcript');
  });

  it('falls back to beatsReviewReport.arc, then to the outline transcript', () => {
    expect(resolveReplayArc({ ...storyData, arcReviewReport: null, beatsReviewReport: { arc: 'older arc' } } as any, { parseBeats }))
      .toBe('older arc');
    expect(resolveReplayArc({ outline: storyData.outline } as any, { parseBeats }))
      .toBe('fallback arc from the outline transcript');
  });

  it('returns an empty string rather than throwing when nothing is stored', () => {
    expect(resolveReplayArc({} as any, { parseBeats })).toBe('');
    expect(resolveReplayArc(null as any, {})).toBe('');
  });

  it('carries the arc hints production passes alongside the arc', () => {
    expect(resolveReplayArcHints(storyData)).toBe(storyData.arcReviewReport.arcHints);
    expect(resolveReplayArcHints({} as any)).toBe('');
  });
});

describe('beatsReplayInputs — the locked scene briefs the writer actually got', () => {
  it('hands over every stored page brief, whole, keyed by page', () => {
    const exp = resolveReplayExpansions(storyData);
    expect(exp).toEqual([
      { pageNumber: 1, brief: storyData.sceneImages[0].sceneDescription },
      { pageNumber: 2, brief: storyData.sceneImages[1].sceneDescription },
    ]);
    // The METADATA block is stripped by the prompt builder, not here — the
    // builder is the one place that knows what the writer may see.
    expect(exp[0].brief).toContain('---METADATA---');
  });

  it('drops pages with no brief instead of emitting an empty one', () => {
    expect(resolveReplayExpansions(storyData).map(x => x.pageNumber)).not.toContain(3);
    expect(resolveReplayExpansions({} as any)).toEqual([]);
  });
});

describe('beatsReplayInputs — the production argument set', () => {
  it('buildReplayTextArgs produces every argument production passes', () => {
    const a = buildReplayTextArgs(storyData, beats, { parseBeats });
    expect(a.beats).toBe(beats);
    // THE defect: this used to be []. A non-empty expansions list is what puts
    // the ILLUSTRATION block on each page block.
    expect(a.expansions.length).toBe(2);
    expect(a.arc).toBe(storyData.arcReviewReport.finalArc);
    expect(a.arcHints).toBe(storyData.arcReviewReport.arcHints);
    expect(a.overridden).toEqual([]);
  });

  it('an override is explicit and is reported as one', () => {
    const a = buildReplayTextArgs(storyData, beats, { parseBeats, overrides: { expansions: [] } });
    expect(a.expansions).toEqual([]);
    expect(a.overridden).toEqual(['expansions']);
    // arc/hints are untouched by an expansions override.
    expect(a.arc).toBe(storyData.arcReviewReport.finalArc);
  });

  it('an undefined override is not an override — the baseline survives', () => {
    const a = buildReplayTextArgs(storyData, beats, { parseBeats, overrides: { expansions: undefined } });
    expect(a.expansions.length).toBe(2);
    expect(a.overridden).toEqual([]);
  });

  it('buildReplaySceneOptions produces the options beatsPipeline passes the Art Director', () => {
    const o = buildReplaySceneOptions(storyData, {
      availableAvatars: 'Hero: standard',
      maxCharactersPerScene: 5,
      parseBeats,
    });
    expect(o).toEqual({
      availableAvatars: 'Hero: standard',
      maxCharactersPerScene: 5,
      finalArc: storyData.arcReviewReport.finalArc,
      clothingRequirements: storyData.clothingRequirements,
    });
    // primaryClothing must NOT appear: production cannot have it at this point
    // (pageClothing is derived from this stage's own output).
    expect('primaryClothing' in o).toBe(false);
  });
});

// ── WIRING GUARDS ────────────────────────────────────────────────────────────
// The divergent expressions must not be rebuildable. These read the source, the
// way the other wiring guards in this suite do, because the alternative is
// loading testlab.js — which pulls the whole image pipeline into the test.

const testlabSrc: string = fs.readFileSync(
  path.join(__dirname, '..', '..', 'server', 'lib', 'testlab.js'), 'utf8');
const beatsSrc: string = fs.readFileSync(
  path.join(__dirname, '..', '..', 'server', 'lib', 'beatsPipeline.js'), 'utf8');

describe('wiring — the Lab replay stages call through the resolver', () => {
  it('no Lab site passes an empty expansions list to the beats text writer', () => {
    // `buildStoryTextFromBeatsPrompt(x, y, [], …)` is the exact shape that made
    // every writer A/B measure the blind-writer configuration.
    const blind = testlabSrc.match(/buildStoryTextFromBeatsPrompt\([^)]*,\s*\[\s*\]\s*,/g) || [];
    expect(blind).toEqual([]);
  });

  it('every Lab call to the beats text writer passes arcHints', () => {
    const calls = testlabSrc.match(/buildStoryTextFromBeatsPrompt\([\s\S]{0,300}?\);/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toContain('arcHints');
  });

  it('no Lab site calls the all-pages Art Director with an empty options object', () => {
    const bare = testlabSrc.match(/buildSceneExpansionAllPrompt\([\s\S]{0,120}?,\s*\{\s*\}\s*\)/g) || [];
    expect(bare).toEqual([]);
  });

  it('every Lab call to the all-pages Art Director builds its options through the resolver', () => {
    const calls = testlabSrc.match(/buildSceneExpansionAllPrompt\([\s\S]{0,1400}?\n\s*\);/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    // Inline, or through a local the resolver assigns — the Lab's beats stage
    // hoists one `buildReplaySceneOptions` call and hands it to BOTH the
    // all-pages builder and the per-page `expandOnePage` fallback, which is
    // this rule taken further, not around it. What must never appear is a
    // hand-written options literal.
    const resolverLocals = [...testlabSrc.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*buildReplaySceneOptions\(/g)]
      .map(m => m[1]);
    for (const c of calls) {
      const viaResolver = c.includes('buildReplaySceneOptions')
        || resolverLocals.some(name => new RegExp(`\\b${name}\\b`).test(c));
      expect(viaResolver).toBe(true);
    }
  });

  it('no Lab site derives the writer arc from the outline transcript alone', () => {
    // `parseBeats(String(storyData.outline || '')).arc` as the ONLY source was
    // the writer-stage bug: production's approvedArc is the arc machine's
    // committed output, and the parsed transcript is only the last resort. The
    // full ladder now lives in resolveReplayArc.
    const outlineOnly = testlabSrc.match(/finalArc:\s*(?:SH\.)?parseBeats\(/g) || [];
    expect(outlineOnly).toEqual([]);
    const inlinedLadder = testlabSrc.match(
      /arcReviewReport\?\.finalArc[\s\S]{0,120}?parseBeats\(String\(storyData\.outline/g) || [];
    expect(inlinedLadder).toEqual([]);
  });

  it('the two refine call sites keep production\'s narrower two-level ladder', () => {
    // textRefine is handed `arcReviewReport?.finalArc || beatsReviewReport?.arc
    // || ''` in production (storyJobPipeline.js:3970) — no outline fallback,
    // because production has no transcript to parse at that point. The Lab
    // matches it, and must keep matching it rather than adopting the wider
    // replay ladder.
    const refineLadders = testlabSrc.match(
      /arc:\s*storyData\.arcReviewReport\?\.finalArc \|\| storyData\.beatsReviewReport\?\.arc \|\| ''/g) || [];
    expect(refineLadders.length).toBe(2);
    const prod = fs.readFileSync(
      path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    expect(prod).toContain("arc: beatsResult?.arcReviewReport?.finalArc || beatsResult?.beatsReviewReport?.arc || ''");
  });
});

describe('wiring — production still passes what the resolver mirrors', () => {
  // If production's call shape changes, the resolver is no longer a mirror and
  // these must be revisited together.
  it('production hands the text writer finalExpansions, the approved arc and arcHints', () => {
    expect(beatsSrc).toContain(
      'buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions, approvedArc, { arcHints, visualBible, clothingRequirements })');
  });

  it('production hands the all-pages Art Director the approved arc', () => {
    // `briefBeats`: the story beats plus the cover pages' beats (coverBeats.js, 2026-09-24).
    const call = (beatsSrc.match(/buildSceneExpansionAllPrompt\(inputData, briefBeats, \{[\s\S]*?\n  \}\);/) || [])[0] || '';
    expect(call).toContain('finalArc: approvedArc');
    expect(call).toContain('clothingRequirements');
    expect(call).toContain('availableAvatars');
    expect(call).toContain('maxCharactersPerScene');
  });

  it('production hands the beats planner the approved arc, arcHints and the central figure', () => {
    expect(beatsSrc).toContain('buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, centralFigure: arcCentralFigure })');
  });

  it('the replay resolves the central figure the arc stored, and nothing for an older story', () => {
    const { resolveReplayCentralFigure } = require('../../server/lib/beatsReplayInputs');
    expect(resolveReplayCentralFigure({ arcReviewReport: { centralFigure: ['the egg', 'Fünkli'] } })).toEqual(['the egg', 'Fünkli']);
    expect(resolveReplayCentralFigure({ arcReviewReport: { centralFigure: null } })).toBeNull();
    expect(resolveReplayCentralFigure({ arcReviewReport: { finalArc: '1. x' } })).toBeNull();
  });

  it('beats is the pipeline in every environment — which is why this matters', () => {
    const runtime = fs.readFileSync(
      path.join(__dirname, '..', '..', 'server', 'config', 'runtime.js'), 'utf8');
    expect(runtime).toMatch(/pipelineMode:\s*'beats'/);
  });
});
