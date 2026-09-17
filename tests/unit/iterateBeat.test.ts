/**
 * An iterate must get the beat (owner, 2026-09-14).
 *
 * Every fixture here is the REAL stored shape, pulled from staging
 * `job_1789348171785_9oxos7dwv` page 7: its `sceneDescriptions[7].outlineExtract`
 * plan line verbatim, its brief's own prose + ---METADATA--- block verbatim, and
 * its visual bible's two animals and one secondary character. A hand-built
 * fixture is how a fix passes its test while broken.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const {
  resolvePlanLine, planStagedSegment, collectStagedFigures,
  renderStagedFiguresBlock, checkRewrittenBrief,
} = nodeRequire('../../server/lib/iterateBeat.js');
const { buildSceneDescriptionPrompt } = nodeRequire('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');

// The prompt templates are read from disk at boot; without this the builder
// falls back to its hardcoded prompt and every assertion below tests nothing.
beforeAll(async () => { await loadPromptTemplates(); });

// ── Real stored fixtures ────────────────────────────────────────────────────

const PLAN_LINE = "PLAN: wide — all four boys and Nia, seen from behind — the group moves down the steep stone steps away from the Lindenhof, Julian carrying Ofeli at the front setting the slow pace — all four are going together toward Levin's home";

const BRIEF = `Seen from behind, Julian — the toddler in his yellow vest, white shirt, blue dungarees, and white sneakers — walks at the front on a lower step, both arms wrapped around the heavy red stone-like egg, Ofeli. Seen from behind, Levin, in his red hoodie, dark grey trousers, and brown boots, takes the steps carefully behind him. Seen from behind, Max, in his green pullover, orange corduroy trousers, and grey velcro-strap sneakers, follows at the same slow rhythm. Seen from behind, Kiaan, in his purple anorak, brown trousers, and dark brown leather ankle boots, follows close to Max, while the scruffy terrier mix dog pads along on the step beside Max. The wide shot, angled slightly downward from the top of the stairs, watches the friends depart toward the lower town.
---METADATA---
{
  "sceneIntent": "The group walks away down the steep stone stairs, seen from behind. Julian leads slowly, carrying the egg, while Levin, Max, Kiaan, and the dog follow his pace.",
  "characters": [
    {"name": "Julian", "clothing": "standard", "position": "center midground", "depth": "midground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Levin", "clothing": "standard", "position": "left foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Max", "clothing": "standard", "position": "center foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"},
    {"name": "Kiaan", "clothing": "standard", "position": "right foreground", "depth": "foreground", "perspective": "back view", "looksAt": "away", "expression": "face not visible"}
  ],
  "shot": "wide",
  "landmarkView": "exterior",
  "era": "present day",
  "objects": ["LOC001", "ART001", "ANI001", "ANI002"],
  "interactions": [
    {"character": "Levin + Julian + Max + Kiaan", "object": "the stairs", "where": "walk down the stone stairs", "action": "walking", "storyRelevant": false, "priority": "normal"}
  ],
  "wornItems": [],
  "emptyScenePrompt": "Steep stone steps descend away from the camera, leading down from a high park area into the lower town."
}`;

const IMAGE_SUMMARY = 'The group walks away down the steep stone stairs, seen from behind.';

const VISUAL_BIBLE = {
  mainCharacters: [],
  secondaryCharacters: [
    { id: 'CHR001', name: 'Frau Brunner', extractedDescription: 'elderly neighbour. grey bun, round glasses, blue cardigan' },
  ],
  animals: [
    { id: 'ANI001', name: 'Nia', species: 'terrier mix dog', extractedDescription: 'terrier mix dog. comes up to a preschooler\'s knee. scruffy light brown and white coat. floppy ears, short tail, plain red collar, large round friendly eyes' },
    { id: 'ANI002', name: 'Ofeli', species: 'small dragon', extractedDescription: 'small dragon. about the size of a large cat. rusty red and gold scales. soft rounded snout, large friendly round orange eyes' },
  ],
  locations: [{ id: 'LOC001', name: 'Stone stairs', extractedDescription: 'steep stone steps down from the park' }],
  artifacts: [{ id: 'ART001', name: 'Stone egg', extractedDescription: 'heavy red stone-like egg' }],
};

const CHARACTERS = ['Levin', 'Julian', 'Max', 'Kiaan'].map((name, i) => ({
  id: i + 1, name, age: 6,
  avatars: { standard: { description: 'everyday clothes' } },
}));

const CAST_NAMES = ['Levin', 'Julian', 'Max', 'Kiaan', 'Frau Brunner'];

const SCENE_METADATA = {
  characters: ['Julian', 'Levin', 'Max', 'Kiaan'],
  objects: ['LOC001', 'ART001', 'ANI001', 'ANI002'],
  imageSummary: IMAGE_SUMMARY,
};

const PAGE_TEXT = 'Gemeinsam gingen sie die steile Treppe hinunter.';

function buildIteratePrompt(overrides: any = {}) {
  const { planLine = PLAN_LINE, stagedFigures = '', freeIterate = false } = overrides;
  return buildSceneDescriptionPrompt(
    7, PAGE_TEXT, CHARACTERS, IMAGE_SUMMARY, 'de', VISUAL_BIBLE,
    [{ pageNumber: 6, text: 'Sie standen auf dem Lindenhof.', sceneHint: '', clothing: 'standard' }],
    'standard', '', '',
    { planLine },
    { composition: 'Four boys seen from behind on stone steps.', fixIssues: ['extra figure upper right'] },
    { freeIterate, textInImage: false, stagedFigures }
  );
}

// ── The beat reaches the rewriter ───────────────────────────────────────────

describe('the plan line reaches the iteration prompt', () => {
  it('reads the stored plan line off the scene row, then the page row', () => {
    expect(resolvePlanLine({ pageNumber: 7, outlineExtract: PLAN_LINE }, null)).toBe(PLAN_LINE);
    expect(resolvePlanLine({ pageNumber: 7 }, { outlineExtract: PLAN_LINE })).toBe(PLAN_LINE);
    expect(resolvePlanLine({ pageNumber: 7, outlineExtract: '  ' }, {})).toBeNull();
  });

  // Against the old code this fails twice over: iterate passed `null` for
  // rawOutlineContext, so the plan line was nowhere in the prompt; and had it
  // passed `{planLine}`, the old truthy branch would have taken the raw-outline
  // path and emitted an EMPTY scene summary.
  it('puts the beat in the authoritative slot, not the previous brief summary', () => {
    const prompt = buildIteratePrompt();
    expect(prompt).toContain(PLAN_LINE);
    expect(prompt).toMatch(/Page plan line[\s\S]*authoritative/);
    // The previous brief stays, as the starting point — but it is no longer the
    // only narrative input, and it no longer stands alone as "Scene Summary".
    expect(prompt).toContain(IMAGE_SUMMARY);
    expect(prompt).not.toContain(`Scene Summary: ${IMAGE_SUMMARY}`);
  });

  it('keeps the previous-scenes context a plan-line context does not carry', () => {
    const prompt = buildIteratePrompt();
    expect(prompt).toContain('Sie standen auf dem Lindenhof.');
  });

  it('still works for a page with no stored plan line', () => {
    const prompt = buildIteratePrompt({ planLine: null });
    expect(prompt).toContain(`Scene Summary: ${IMAGE_SUMMARY}`);
    expect(prompt).not.toContain('{SCENE_SUMMARY}');
  });

  it('leaves no unfilled placeholder in either iteration template', () => {
    for (const freeIterate of [false, true]) {
      const prompt = buildIteratePrompt({ freeIterate, stagedFigures: '' });
      expect(prompt).not.toMatch(/\{[A-Z_]{3,}\}/);
    }
  });
});

// ── Named non-roster figures reach the locked cast BY NAME ──────────────────

describe('staged non-roster figures', () => {
  it('names the animals the brief cites — the locked-cast filter dropped them', () => {
    const figures = collectStagedFigures({
      visualBible: VISUAL_BIBLE, sceneMetadata: SCENE_METADATA, savedScene: null, planLine: PLAN_LINE,
    });
    expect(figures.map(f => f.name).sort()).toEqual(['Nia', 'Ofeli']);
    expect(figures.find(f => f.name === 'Nia')).toMatchObject({ id: 'ANI001', kind: 'animal' });
  });

  it('recovers a figure the previous brief dropped but the plan line stages', () => {
    const trimmed = { characters: ['Julian', 'Levin', 'Max', 'Kiaan'], objects: ['LOC001', 'ART001'] };
    const figures = collectStagedFigures({
      visualBible: VISUAL_BIBLE, sceneMetadata: trimmed, savedScene: null, planLine: PLAN_LINE,
    });
    expect(figures.map(f => f.name)).toContain('Nia');
  });

  it('does not read the plan line\'s trailing purpose clause', () => {
    const plan = 'PLAN: close-up — the main character alone at the window — she presses a palm to the glass — she is waiting for Frau Brunner to come home';
    const figures = collectStagedFigures({ visualBible: VISUAL_BIBLE, sceneMetadata: { characters: [], objects: [] }, planLine: plan });
    expect(figures).toEqual([]);
    expect(planStagedSegment(plan)).not.toContain('Frau Brunner');
  });

  it('renders them as a named, id-carrying block the prompt shows', () => {
    const figures = collectStagedFigures({ visualBible: VISUAL_BIBLE, sceneMetadata: SCENE_METADATA, planLine: PLAN_LINE });
    const block = renderStagedFiguresBlock(figures);
    expect(block).toContain('**Nia** [ANI001] (animal)');
    const prompt = buildIteratePrompt({ stagedFigures: block });
    expect(prompt).toContain('**Nia** [ANI001] (animal)');
    expect(prompt).toContain('staged on this page');
  });

  it('adds nothing to a page that stages none', () => {
    expect(renderStagedFiguresBlock([])).toBe('');
    expect(collectStagedFigures({ visualBible: null as any, sceneMetadata: SCENE_METADATA, planLine: PLAN_LINE })).toEqual([]);
  });
});

// ── The reinstatement backstop ──────────────────────────────────────────────

describe('a reinstated figure must be declared in the rewrite\'s own metadata', () => {
  it('passes the real stored brief, which declares what it draws', () => {
    const findings = checkRewrittenBrief({
      pageNumber: 7, brief: BRIEF, planLine: PLAN_LINE, castNames: CAST_NAMES, visualBible: VISUAL_BIBLE,
    });
    expect(findings).toEqual([]);
  });

  // The exact shape the beat introduces: the rewriter brings the animal back in
  // the prose and leaves objects[] alone, so the judge — which reads the brief,
  // never the plan line (3b3070dce) — scores it as an extra character.
  it('catches an animal reinstated in the prose but never cited', () => {
    const undeclared = BRIEF
      .replace('the scruffy terrier mix dog pads along', 'Nia pads along')
      .replace('"objects": ["LOC001", "ART001", "ANI001", "ANI002"]', '"objects": ["LOC001", "ART001"]');
    const findings = checkRewrittenBrief({
      pageNumber: 7, brief: undeclared, planLine: PLAN_LINE, castNames: CAST_NAMES, visualBible: VISUAL_BIBLE,
    });
    expect(findings.map(f => f.type)).toContain('element_uncited');
    expect(findings.find(f => f.type === 'element_uncited').ids).toContain('ANI001');
  });

  it('catches a person in the prose who is absent from characters[]', () => {
    const undeclared = BRIEF.replace(
      'The wide shot,',
      'Frau Brunner watches from the top step. The wide shot,'
    );
    const findings = checkRewrittenBrief({
      pageNumber: 7, brief: undeclared, planLine: PLAN_LINE, castNames: CAST_NAMES, visualBible: VISUAL_BIBLE,
    });
    expect(findings.map(f => f.type)).toContain('cast_unlisted');
    expect(findings.find(f => f.type === 'cast_unlisted').names).toContain('Frau Brunner');
  });

  it('reports nothing for an empty or unparseable brief rather than throwing', () => {
    expect(checkRewrittenBrief({ pageNumber: 7, brief: '', castNames: CAST_NAMES, visualBible: VISUAL_BIBLE })).toEqual([]);
    expect(() => checkRewrittenBrief({
      pageNumber: 7, brief: 'prose only, no metadata', planLine: PLAN_LINE, castNames: CAST_NAMES, visualBible: VISUAL_BIBLE,
    })).not.toThrow();
  });
});

// ── Wiring guard ────────────────────────────────────────────────────────────

describe('iteratePageCore wiring', () => {
  const source = fs.readFileSync(path.join(here, '../../server/lib/images.js'), 'utf8');

  it('never passes a null rawOutlineContext to the iteration prompt again', () => {
    expect(source).not.toMatch(/null,\s*\/\/\s*rawOutlineContext/);
  });

  it('passes the page plan line and the staged-figures block', () => {
    expect(source).toContain('{ planLine },');
    expect(source).toContain('stagedFigures: renderStagedFiguresBlock(stagedFigures)');
  });

  it('runs the post-rewrite brief checks on the rewritten brief, against its parent', () => {
    expect(source).toContain('checkRewrittenBrief({');
    expect(source).toContain('checkCarriedFields({');
    // One closure runs every check, so the first verdict and the corrective
    // re-ask's verdict can never be taken on two different scopes. Since
    // 2026-09-17 that closure also carries the declared-set family, and the
    // one re-ask is judged on the union.
    expect(source).toMatch(/const runBriefChecks = \(text\) =>/);
    expect(source).toMatch(/const runAllBriefChecks = \(text\) =>/);
    expect(source).toMatch(/runAllBriefChecks\(newSceneDescription\)/);
    expect(source).toMatch(/parentBrief:\s*sceneDescText/);
  });
});

describe('both rewrite entry points feed the plan line', () => {
  const ROOT = require('path').resolve(__dirname, '../..');
  const read = (rel: string) => require('fs').readFileSync(require('path').join(ROOT, rel), 'utf8');

  it('neither iteratePageCore nor the regen-scene endpoint passes null for rawOutlineContext', () => {
    for (const rel of ['server/lib/images.js', 'server/routes/regeneration.js']) {
      const src = read(rel);
      const calls = src.match(/buildSceneDescriptionPrompt\([^;]*?\);/gs) || [];
      expect(calls.length, `${rel} calls buildSceneDescriptionPrompt`).toBeGreaterThan(0);
      for (const call of calls) {
        // `…, null, null, { clothingRequirements…` is the shape that passes no
        // rawOutlineContext, which fills both beat slots from the previous brief.
        expect(call, rel).not.toMatch(/,\s*null,\s*null,\s*\{\s*clothingRequirements/);
      }
    }
  });

  it('the regen-scene endpoint resolves it through resolvePlanLine', () => {
    const src = read('server/routes/regeneration.js');
    expect(src).toContain('resolvePlanLine(storedScene, storedImage)');
  });
});
