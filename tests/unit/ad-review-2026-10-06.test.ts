/**
 * THE ART DIRECTOR REVIEW OF 2026-10-06 (docs/decisions.md): what the edit list changed, pinned as behaviour.
 * Nothing here asserts template prose beyond the phrases that carry a rule; the sibling sets
 * (art-director-vs-iterate, art-director-templates) are pinned by ad-iterate-parity and scene-expansion-template-parity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';

const req = createRequire(import.meta.url);
const PB = req('../../server/lib/promptBuilders.js');
const SV = req('../../server/lib/shotVocabulary.js');
const CB = req('../../server/lib/coverBeats.js');
const SM = req('../../server/lib/sceneMetadata.js');
const BC = req('../../server/lib/briefChecks.js');
const { checkScenes } = req('../../server/lib/sceneBriefCheck.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = req('../../server/services/prompts.js');

const chars = [
  { id: 'a', name: 'Levin', age: 5, isMainCharacter: true },
  { id: 'b', name: 'Mira', age: 8, isMainCharacter: true },
  { id: 'c', name: 'Opa', age: 70 },
];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a', 'b'] });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];
const OPTS = { maxCharactersPerScene: 6, finalArc: '1.' };
const briefs = (o: any = {}) => PB.buildSceneBriefsAllPrompt(input(), beats, { ...OPTS, ...o });

beforeAll(async () => { await loadPromptTemplates(); });

describe('§1 covers: a beat states the picture, never a mood, a title or a book; one copy-space source', () => {
  const planLines = () => CB.buildCoverBeats(input(), { coverTypes: ['frontCover', 'initialPage', 'backCover'] }).map((b: any) => b.planLine);

  it('no mood word, no title/book/dedication bait in any cover plan line', () => {
    for (const l of planLines()) {
      expect(l).not.toMatch(/happy|relaxed|welcoming|inviting|warm|calm|title|book|dedication|opened|closed/i);
    }
  });

  it('the copy space is the one constant, in the trial cover composition only, never worded as an absence; a full-story beat carries textPosition and no band sentence', () => {
    const lines = planLines();
    // Fiona rerun 2026-10-08 (regression, fails on the parent): the beat quoted COVER_COPY_SPACE and the Art Director copied it
    // into the brief prose ("the top third of the picture is the empty dark grey sky"). A sentence in the input is copied; the
    // band reaches the render through the OPEN AREA block that textPosition builds.
    const { COVER_TEXT_POSITION } = require('../../server/lib/coverKeys');
    (['frontCover', 'initialPage', 'backCover'] as const).forEach((key, i) => {
      expect(lines[i]).not.toContain(CB.COVER_COPY_SPACE[key]);
      expect(lines[i]).not.toMatch(/\b(third|fifth|tenth|half|one-third line)\b/i);
      expect(lines[i]).toContain(`textPosition "${COVER_TEXT_POSITION[key]}"`);
    });
    for (const k of Object.keys(CB.COVER_COPY_SPACE)) expect(CB.COVER_COPY_SPACE[k]).not.toMatch(/\bno\b|\bnothing\b|\bwithout\b|\bclear of\b|\bempty\b/i);
    const comp = fs.readFileSync('prompts/cover-composition.txt', 'utf8');
    expect(comp.match(/\{COVER_COPY_SPACE\}/g)).toHaveLength(2);
    expect(comp).not.toMatch(/happy and relaxed/);
    const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + '.';
    const front = PB.buildCoverPrompt('front', { sceneDescription: 'Levin stands at a gate.', inputData: input(), characters: chars });
    expect(front).toContain(capitalised(CB.COVER_COPY_SPACE.frontCover));
  });

  it('a cover\'s non-commissioned figure is cited in objects[], never given a characters[] row', () => {
    for (const t of ['sceneBriefsAll', 'sceneExpansion']) expect(String(PROMPT_TEMPLATES[t])).toMatch(/has no row here and is cited in `objects\[\]`/);
  });

  it('the Visual Bible call is told it authors no cover vantage and no cover page', () => {
    expect(String(PROMPT_TEMPLATES.visualBible)).toMatch(/Pages -1, -2 and -3 are the book's covers[^.]*no vantage of its own/);
  });
});

describe('§2 footing: one rule, no mojibake, no doubled heading, no field name; the costume body agrees', () => {
  it('FOOTING_RULE is clean and the Visual Bible and the brief authors fill it', () => {
    expect(SV.FOOTING_RULE).not.toMatch(/2019|^No partial immersion/);
    expect(SV.FOOTING_RULE).toContain('water’s edge');
    expect(SV.FOOTING_RULE).not.toContain('footing:');
    expect(String(PROMPT_TEMPLATES.visualBible)).toContain('{FOOTING_RULE}');
    expect(PB.buildVisualBibleCallPrompt(input(), beats, OPTS)).toContain(SV.FOOTING_RULE);
    expect(briefs()).toContain(SV.FOOTING_RULE);
  });

  it('5d does not restage a wade as an in-progress movement; 11g owns it', () => {
    const t = String(PROMPT_TEMPLATES.sceneBriefsAll);
    const d5 = t.split('\n').find(l => l.startsWith('5d.')) || '';
    expect(d5).not.toMatch(/wading, climbing/);
    expect(d5).toContain('A wade is restaged by the no-partial-immersion rule');
  });

  it('a tail swims in the water and rests on its tail on sand or rock', () => {
    expect(PB.COSTUME_BODY_RULE).toContain('in the water it swims on that tail, on sand or rock it rests on it');
    expect(PB.COSTUME_BODY_RULE).not.toMatch(/where it stands in water/);
  });
});

describe('§3 the decision layer\'s fields are not asked of the Art Director twice', () => {
  const jev = () => briefs();
  const backup = () => briefs({ jevBackup: true });

  it('gaze, sceneIntent and the cross-page rules have a FIXED variant on the Jev path and the full rule on the backup', () => {
    expect(jev()).toContain(PB.SCENE_INTENT_FIELD_FIXED_RULE);
    expect(jev()).not.toContain(PB.SCENE_INTENT_FIELD_RULE);
    expect(backup()).toContain(PB.SCENE_INTENT_FIELD_RULE);
    expect(PB.SCENE_INTENT_FIELD_FIXED_RULE).toMatch(/^1-2 sentences: the plan line's instant as the picture shows it, naming every figure in frame; the setting/);
    expect(jev()).not.toMatch(/^C6\./m);
    expect(backup()).toMatch(/^C6\./m);
    expect(jev()).not.toMatch(/^C2\. \*\*Monotonic/m);
    expect(backup()).toMatch(/^C2\. \*\*Monotonic/m);
  });

  it('the Jev path\'s field rules drop what code writes: the six population values, the cited-id bullets, a FIXED vessel and shaft', () => {
    expect(backup()).toContain('`"creature_crowd"`');
    expect(jev()).not.toContain('`"creature_crowd"`');
    expect(jev()).toContain('A vessel the FIXED `aboard` names is staged only as that ground');
    expect(jev()).toContain('The FIXED `shot` and location already put the camera there');
    expect(backup()).not.toContain('The FIXED `shot` and location already put the camera there');
    expect(jev()).not.toContain('Include every recurring visual element visible in the scene');
    expect(backup()).toContain('Include every recurring visual element visible in the scene');
  });

  it('a cover\'s weather: the FIXED paragraph no longer says a cover carries none while its FIXED block can leave it to the author', () => {
    const p = briefs();
    expect(p).toContain('nor its `weather` when its FIXED block states one');
    expect(p).not.toMatch(/a cover's none of `shot`, `timeOfDay`, `weather`/);
    expect(req('../../server/lib/sceneLight.js').SCENE_WEATHER_FIELD_RULE).toContain('a cover\'s `weather` is code\'s when its FIXED block states one');
  });

  it('vb_page_uncited is a decided field\'s on a Jev story page: withheld from the re-ask, never sent as a citation the FIXED rule forbids', () => {
    expect(BC.JEV_OWNED.has('vb_page_uncited')).toBe(true);
    const vb = { artifacts: [{ id: 'ART001', label: 'lamp', name: 'lamp', pages: [1], description: 'a brass lamp' }], locations: [{ id: 'LOC001', name: 'quay', pages: [1] }] };
    const brief = 'Levin stands on the quay.\n\n---METADATA---\n' + JSON.stringify({ sceneIntent: 'Levin stands.', characters: [{ name: 'Levin', clothing: 'standard', position: 'on the quay', depth: 'foreground' }], objects: ['LOC001'], interactions: [] });
    const ctx = (fixed: any) => ({
      inputData: input(), clothingRequirements: null, visualBible: vb,
      briefBeats: [{ pageNumber: 1, planLine: 'wide — Levin — waits — nothing', ...(fixed ? { jevFixed: fixed } : {}) }],
    });
    const run = (fixed: any) => BC.collectBriefFindings([{ pageNumber: 1, brief }], ctx(fixed));
    const withJev = run({ shot: 'wide', cites: [], location: 'LOC001', decidedIds: ['ART001', 'LOC001'] });
    expect(withJev.findings.map((f: any) => f.type)).not.toContain('vb_page_uncited');
    expect(withJev.withheld.map((f: any) => f.type)).toContain('vb_page_uncited');
    const backupRun = run(null);
    expect(backupRun.findings.map((f: any) => f.type)).toContain('vb_page_uncited');
  });
});

describe('§4 `closed` is no gaze option (the earlier verdict wins; EYES_OPEN_RULE stands)', () => {
  it('the table, the field rules and the Jev candidates carry no `closed`', () => {
    const G = req('../../server/lib/gazeTargets.js');
    expect(G.GAZE_TARGETS.map((t: any) => t.id)).not.toContain('closed');
    expect(G.GAZE_TARGETS.some((t: any) => 'faceFollows' in t)).toBe(false);
    expect(PB.LOOKS_AT_FIELD_RULE).not.toMatch(/\bclosed\b/);
    expect(PB.EYES_OPEN_RULE).toContain('No closed eyes');
  });
});

describe('§6 size: one constant, the creature tone speaks bands, no metres, no fixed camera height; heights are two levels', () => {
  it('the tone block names no metres and no camera height, and the entry variant carries no page rule', () => {
    for (const age of [3, 5, 9]) {
      const tone = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: String(age), isMain: true }] });
      expect(tone, `age ${age}`).not.toMatch(/metres|eye level|familiar room/);
      const entry = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: String(age), isMain: true }] }, { page: false });
      expect(entry).not.toContain('the page\'s own prose states its face');
      expect(tone.startsWith(entry)).toBe(true);
    }
    expect(PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '3', isMain: true }] })).toContain('`scaleClass`');
    const vb = PB.buildVisualBibleCallPrompt(input(), beats, OPTS);
    expect(vb).not.toContain('the page\'s own prose states its face');
  });

  it('the size rules are ONE constant: no ELEMENT_SIZE_WORD any more, its sentence lives in TRUE_RELATIVE_SIZE_RULE', () => {
    expect(PB.ELEMENT_SIZE_WORD_RULE).toBeUndefined();
    for (const f of ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free']) {
      expect(fs.readFileSync(`prompts/${f}.txt`, 'utf8'), f).not.toContain('{ELEMENT_SIZE_WORD}');
    }
    expect(PB.TRUE_RELATIVE_SIZE_RULE).toContain('never an intensifier that disagrees with it');
  });

  it('a background figure is described by hair and top colour only', () => {
    const t = String(PROMPT_TEMPLATES.sceneBriefsAll);
    expect(t).toContain('by hair colour and top colour only');
  });

  it('11f is the owner\'s heights rule: at most two levels, depth is distance, in both Art Directors and the trial writer', () => {
    expect(PB.HEIGHT_LEVELS_RULE).toMatch(/at most two height levels/);
    expect(PB.HEIGHT_LEVELS_RULE).toContain('`depth` is the distance from the camera and never a height');
    expect(PB.HEIGHT_LEVELS_RULE).not.toContain('Stage the page from one level');
    expect(briefs()).toContain(PB.HEIGHT_LEVELS_RULE);
    expect(PB.AD_COMPOSITION_RULE).toContain(PB.HEIGHT_LEVELS_RULE);
    const one = PB.buildSceneExpansionPrompt(1, 'PLAN: medium — Levin — waits — nothing', chars, 'en', null, '', null, { story: input() });
    expect(one).toContain(PB.HEIGHT_LEVELS_RULE);
  });
});

describe('§8 interactions: `holding` is passive, one cap line everywhere, the contact lines live under interactions[]', () => {
  const row = (character: string, action: string, extra: any = {}) => ({ character, object: 'the lantern', where: 'x', action, storyRelevant: false, ...extra });
  const brief = (interactions: any[]) => 'Levin and Mira on the quay.\n\n---METADATA---\n' + JSON.stringify({
    sceneIntent: 'x', shot: 'wide', timeOfDay: 'dusk', weather: 'clear',
    characters: [{ name: 'Levin', clothing: 'standard', position: 'on the quay', depth: 'foreground' }, { name: 'Mira', clothing: 'standard', position: 'beside Levin', depth: 'foreground' }],
    objects: [], interactions,
  });
  const found = (interactions: any[]) => checkScenes([{ pageNumber: 1, brief: brief(interactions), planLine: 'wide — Levin, Mira — act — x' }], ['Levin', 'Mira'], null, {}).findings.map((f: any) => f.type);

  it('a prop held and nothing else is `holding`: it does not make a second action', () => {
    expect(SM.PASSIVE_ACTIONS.has('holding')).toBe(true);
    expect(found([row('Levin', 'pushing the cart', { storyRelevant: true }), row('Mira', 'holding')])).not.toContain('interaction_multiple_actions');
    expect(found([row('Levin', 'pushing the cart'), row('Mira', 'climbing the ladder')])).toContain('interaction_multiple_actions');
  });

  it('one cap line, filled into all four templates, and the vehicle/cap lines sit before wornItems', () => {
    expect(PB.INTERACTIONS_CAP_RULE).toContain('"holding"');
    for (const f of ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free']) {
      expect(fs.readFileSync(`prompts/${f}.txt`, 'utf8'), f).toContain('{INTERACTIONS_CAP}');
    }
    const t = String(PROMPT_TEMPLATES.sceneBriefsAll);
    expect(t.indexOf('{INTERACTIONS_CAP}')).toBeLessThan(t.indexOf('**`wornItems[]`**'));
    expect(t.indexOf('{INTERACTIONS_CAP}')).toBeGreaterThan(t.indexOf('**Coverage:**'));
    expect(t).toMatch(/^6\. \*\*Every body takes part in the page's one action\./m);
  });
});

describe('§7, §9, §12 the templates', () => {
  const files = ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free'];
  const text = (f: string) => fs.readFileSync(`prompts/${f}.txt`, 'utf8');

  it('nobody points, and no numeric age appears in an example', () => {
    for (const f of files) {
      expect(text(f), f).not.toMatch(/pointing hands|pointing\/aiming|arm points|right arm extended|R:pointing|Pointing Geometry/);
      expect(text(f), f).not.toMatch(/\b(?:seven|eight|ten)-year-old\b/);
    }
  });

  it('the iterate rewrites take the clothing from EXPECTED CLOTHING, never "prefer costumed", and name no outline', () => {
    for (const f of ['scene-iteration', 'scene-iteration-free']) {
      expect(text(f), f).not.toMatch(/prefer it for every page/);
      expect(text(f), f).toContain('EXPECTED CLOTHING');
      expect(text(f), f).not.toMatch(/the outline (?:says|lists)|outline's intent/);
    }
  });

  it('a gap action is framed by the one shared rule, not a hardcoded ultra-wide', () => {
    for (const f of ['scene-iteration', 'scene-iteration-free']) {
      expect(text(f), f).toContain('{GAP_ACTION_FRAMING}');
      expect(text(f), f).not.toMatch(/the shot must be `ultra-wide`/);
    }
  });

  it('the iterate plate wording: no light words, no open space for figures, scene anchors allowed', () => {
    for (const f of ['scene-iteration', 'scene-iteration-free']) {
      const t = text(f);
      expect(t, f).not.toMatch(/direction the light comes from|light falling from the left|Open foreground space for composited characters/);
      expect(t, f).toContain('No light words');
    }
  });

  it('the dead audit keys no consumer reads are gone from the iterates (castChanges, issues, corrections)', () => {
    for (const f of ['scene-iteration', 'scene-iteration-free']) {
      expect(text(f), f).not.toMatch(/"castChanges"|"issues"|"corrections"|`issues\[\]`|`castChanges`/);
    }
  });

  it('the free template no longer contradicts itself: appearance from CHARACTER DETAILS, one cap line', () => {
    const t = text('scene-iteration-free');
    expect(t).not.toMatch(/NO PHYSICAL DESCRIPTIONS|^13\. /m);
    expect(t).not.toMatch(/Safe settings|SAFE SETTINGS/);
    expect(t).not.toMatch(/\bYOU MUST\b|CRITICAL:/);
  });

  it('the outfit exemption: a close-up, an over-the-shoulder near figure and a background figure name less', () => {
    const t = String(PROMPT_TEMPLATES.sceneBriefsAll);
    expect(t).toContain('except what the frame crops');
    expect(t).not.toContain('The outfit list still names all garments including footwear');
    // Lab 1674 (first wording): p8 and p13 came back with no description at all for three figures. The exemption names the
    // MINIMUM for each, and the output checklist (which asked for the full outfit of every figure) agrees with it.
    expect(t).toContain('No figure in frame is left without a description');
    expect(t).toContain('a cropped or background figure as rule 10 says');
    expect(t).toContain('is still described, in one short clause, by hair colour and top colour only');
    expect(t).toContain('"clothing": "costumed:<costume>"');
  });

  it('positions are relational in the output bullet and the examples; the text zone is calm, not saturated', () => {
    const t = String(PROMPT_TEMPLATES.sceneBriefsAll);
    expect(t).not.toMatch(/where each character is positioned \(left\/right\/center/);
    expect(t).not.toMatch(/"position": "(?:left foreground|center background)"/);
    expect(t).not.toMatch(/saturated, high-contrast|dark green pine/);
  });

  it('the mood is out of the checklists and examples', () => {
    for (const f of ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free']) {
      expect(text(f), f).not.toMatch(/weather, lighting, mood|calm weekday atmosphere|in curiosity|"emotion": "curious"/);
    }
  });
});

describe('§11 the Visual Bible: no light in plates, no cellar duplicate, anchors that agree with aboard', () => {
  const vb = () => PB.buildVisualBibleCallPrompt(input(), beats, OPTS);
  it('the plan lines carry no FIXED light line and the plate rule names no light', () => {
    expect(vb()).not.toMatch(/FIXED: timeOfDay/);
    expect(PB.planBlocks(beats)).toContain('FIXED: timeOfDay dusk');
    expect(PB.planBlocks(beats, { fixed: false })).not.toContain('FIXED');
    expect(vb()).toContain('The plate holds no light words');
    expect(vb()).not.toMatch(/direction the light/);
  });
  it('the cellar rule is merged into inside-is-not-outside, and a vehicle the camera stands on is never an anchor', () => {
    const t = String(PROMPT_TEMPLATES.visualBible);
    expect(t.match(/cellar, basement, cave/g) || []).toHaveLength(1);
    expect(t).not.toMatch(/dominating the foreground composition/);
    expect(t).toContain('is the aboard ground above, never an anchor');
    expect(t).toContain('"build": "[sex and body type, no height or size word]"');
  });
});

describe('§13 the blocked-scene rewrite keeps the place, the light and the costume', () => {
  it('removes only contact, peril and undress cues, and returns text, not metadata', () => {
    const t = String(PROMPT_TEMPLATES.rewriteBlockedScene);
    expect(t).toContain('the place, the time of day and the light');
    expect(t).toContain('{COSTUME_BODY}');
    expect(t).not.toMatch(/Bedtime\/bedroom|Open outdoor spaces|Bright daylight or warm indoor lighting|Water\/swimming scenes/);
    expect(t).not.toMatch(/METADATA|Setting, Characters, Action, Mood/);
  });
});
