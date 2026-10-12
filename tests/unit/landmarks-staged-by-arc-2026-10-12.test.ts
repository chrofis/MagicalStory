/**
 * Landmarks are staged by the arc and counted on story pages (owner, 2026-10-12;
 * docs/decisions.md "Landmarks are staged by the arc", replacing "Landmark retry
 * re-asks only the Visual Bible call"). Plan: tasks/cast-landmarks-2026-10-12.md L1-L5.
 *
 *   L1  the arc writes a typed "Landmarks staged:" block; code resolves it against the
 *       OFFERED list and a shortfall is a code-counted finding for the re-telling
 *   L2  the divider, the plan check (question 19) and the Art Director read that typed list
 *   L3  the Visual Bible's `backdropLandmarks` row counts as a staged landmark
 *   L4  the final count is story pages only (pages > 0): a cover-only place no longer satisfies it
 *   L5  the Visual Bible retry is deleted
 *
 * Pins behaviour — what parses, what counts, which string reaches which built prompt.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const LG = require('../../server/lib/landmarkGuideline');
const { loadPromptTemplates } = require('../../server/services/prompts');

const OFFERED = [
  { name: 'Alpha Bridge', type: 'Bridge', query: 'Alpha Bridge' },
  { name: 'Beta Tower', type: 'Tower' },
  { name: 'Gamma Abbey (Old Town)', type: 'Abbey' },
];
const input = (extra: any = {}) => ({
  pages: 10, language: 'en', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Two children find an egg.', premiseNamedWorld: false,
  characters: [{ id: 'a', name: 'Anna', age: 7 }, { id: 'b', name: 'Ben', age: 6 }],
  mainCharacters: ['a', 'b'],
  availableLandmarks: OFFERED,
  ...extra,
});

const LOGIC = [
  'STORY LOGIC:',
  'Want and stakes: the children want the egg to hatch before dark.',
  'Opposition: the wind, because it cools the egg.',
  'Facts:',
  '- Anna (commissioned) — can climb; cannot lift the egg alone',
  '- Ben (commissioned) — can carry the egg; cannot climb',
  'Motives:',
  '- Anna: she wants the egg to hatch → she shelters it',
  'Central figure: the egg',
  'Events: 3',
  'Chain:',
  '- because the egg knocks, Anna decides to keep it warm',
  '- but the wind cools it, so Ben carries it into the tower',
  '- because the tower holds the warmth, the egg hatches now',
].join('\n');
const ARC = ['ARC:', '1. Anna finds the egg on Alpha Bridge.', '2. Ben carries it into Beta Tower.', '3. It hatches.'].join('\n');
const CRIT = 'CRITIQUE:\nFaults: none\nCommission honored: yes';

describe('L1: parseLandmarksStaged resolves the typed block against the offered list', () => {
  it('reads bullets, numbers, a trailing [type], the spelling of the list, and drops duplicates', () => {
    const r = LG.parseLandmarksStaged(['- Alpha Bridge', '2. beta tower [Tower]', '- **Gamma Abbey (Old Town)**', '- Alpha Bridge'], OFFERED);
    expect(r).toEqual({ present: true, names: ['Alpha Bridge', 'Beta Tower', 'Gamma Abbey (Old Town)'], unlisted: [] });
  });

  it('a name that is not on the offered list is reported unlisted and never counted', () => {
    const r = LG.parseLandmarksStaged(['- Alpha Bridge', '- Some Invented Castle'], OFFERED);
    expect(r.names).toEqual(['Alpha Bridge']);
    expect(r.unlisted).toEqual(['Some Invented Castle']);
  });

  it('a name written without the list\'s trailing qualifier counts when only one listed entry has that bare name', () => {
    // agent stand-in arcs wrote "Lindenhof" for the listed "Lindenhof (Zürcher Hügelzug)" in 2 of 2 cases (2026-10-12)
    expect(LG.parseLandmarksStaged(['- Gamma Abbey'], OFFERED).names).toEqual(['Gamma Abbey (Old Town)']);
    const twins = [{ name: 'Town Hall (North)', query: 'Town Hall (North)' }, { name: 'Town Hall (South)', query: 'Town Hall (South)' }];
    expect(LG.parseLandmarksStaged(['- Town Hall'], twins)).toEqual({ present: true, names: [], unlisted: ['Town Hall'] });
  });

  it('"none" is the empty answer; a missing block is NOT the same as an empty one', () => {
    expect(LG.parseLandmarksStaged(['none'], OFFERED)).toEqual({ present: true, names: [], unlisted: [] });
    expect(LG.parseLandmarksStaged(null, OFFERED)).toEqual({ present: false, names: [], unlisted: [] });
  });

  it('prose is never read: a sentence that mentions a landmark is unlisted, not a match', () => {
    const r = LG.parseLandmarksStaged(['They walk across Alpha Bridge at dusk.'], OFFERED);
    expect(r.names).toEqual([]);
  });
});

describe('L1: the block comes out of the create and re-tell replies', () => {
  it('parseArcCreate cuts the block out of the logic and the arc and puts it in the panel\'s committed block', () => {
    const raw = [LOGIC, '', 'Challenges taken:', '1. [own] the egg in the wind', '', 'Landmarks staged:', '- Alpha Bridge', '- Beta Tower', '', ARC, '', CRIT].join('\n');
    const c = PB.parseArcCreate(raw);
    expect(c.landmarkLines).toEqual(['- Alpha Bridge', '- Beta Tower']);
    expect(c.sentences).toBe(3);
    expect(c.logic.text).not.toMatch(/Landmarks staged/i);
    expect(c.arc).not.toMatch(/Alpha Bridge$/m);
    expect(c.takenTagged).toBe(1);                       // the challenges list kept its own line
    expect(c.committed).toContain('LANDMARKS STAGED:\n- Alpha Bridge\n- Beta Tower\n\nARC:');
  });

  it('the answer may sit on the heading line ("Landmarks staged: none")', () => {
    const c = PB.parseArcCreate([LOGIC, 'Landmarks staged: none', '', ARC, '', CRIT].join('\n'));
    expect(LG.parseLandmarksStaged(c.landmarkLines, OFFERED).names).toEqual([]);
    expect(c.landmarkLines).toEqual(['none']);
  });

  it('no block in the reply: landmarkLines is null (a loud miss upstream), the arc still parses', () => {
    const c = PB.parseArcCreate([LOGIC, '', ARC, '', CRIT].join('\n'));
    expect(c.landmarkLines).toBeNull();
    expect(c.sentences).toBe(3);
  });

  it('parseArcRetell reads the block between Keeping and Used without it entering the challenges list or the final arc', () => {
    const raw = [LOGIC, '', 'Fixing: the cold.', 'Keeping: the tower.', 'Challenges taken:', '1. [own] the wind', 'Landmarks staged:', '- Beta Tower', 'Used: Panelist A', 'FINAL ARC:', '1. Anna finds the egg.', '2. Ben carries it into Beta Tower.', '3. It hatches.', '', CRIT].join('\n');
    const r = PB.parseArcRetell(raw);
    expect(r.landmarkLines).toEqual(['- Beta Tower']);
    expect(r.finalArc).not.toMatch(/Landmarks staged/i);
    expect(r.finalArc).not.toMatch(/^- Beta Tower$/m);
    expect(r.sentences).toBe(3);
    expect(r.takenTagged).toBe(1);
  });
});

describe('L1: a shortfall is a finding that code counted, and it opens the re-tell gate', () => {
  it('the finding exists only while the guideline holds and the arc stages fewer than it asks', () => {
    expect(LG.landmarkShortfallFinding(['Alpha Bridge'], input())).toMatch(/at least 2/);
    expect(LG.landmarkShortfallFinding([], input())).toMatch(/none/);
    expect(LG.landmarkShortfallFinding(['Alpha Bridge', 'Beta Tower'], input())).toBe('');
    expect(LG.landmarkShortfallFinding([], input({ premiseNamedWorld: true }))).toBe('');
    expect(LG.landmarkShortfallFinding([], input({ availableLandmarks: [] }))).toBe('');
  });

  it('one offered landmark asks for one, not two', () => {
    const one = input({ availableLandmarks: [OFFERED[0]] });
    expect(LG.landmarkRequirement(one)).toBe(1);
    expect(LG.landmarkShortfallFinding(['Alpha Bridge'], one)).toBe('');
  });

  it('arcRepairFindings: a code finding alone opens the gate and reaches the re-telling under its own heading', () => {
    const none = PB.arcRepairFindings({ critique: 'Faults: none', reviewedArc: 'ARC: 1. a', panel: [] });
    expect(none.retell).toBe(false);
    const f = LG.landmarkShortfallFinding([], input());
    const g = PB.arcRepairFindings({ critique: 'Faults: none', reviewedArc: 'ARC: 1. a', panel: [], codeFindings: [f] });
    expect(g.retell).toBe(true);
    expect(g.count).toBe(1);
    expect(g.text).toContain('## AUTOMATIC LANDMARK CHECK');
    expect(g.text).toContain(f);
  });

  it('the production round loop hands the shortfall to the gate (source: beatsPipeline)', () => {
    const src = fs.readFileSync('server/lib/beatsPipeline.js', 'utf8');
    expect(src).toContain('landmarkShortfallFinding(currentLandmarks.names, inputData)');
    expect(src).toContain('codeFindings: landmarkFinding ? [landmarkFinding] : []');
    expect(src).toContain('inputData.landmarksStaged = arcLandmarksStaged');
  });
});

describe('L1: the arc is asked for the typed block, the panel checks the claim', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('arc-create and arc-retell carry the one rule string when landmarks were offered, none when not', () => {
    const rule = PB.landmarksStagedRule(input());
    expect(rule).toMatch(/Landmarks staged:/);
    expect(rule).toMatch(/at least 2/);
    expect(PB.buildArcCreatePrompt(input(), 10)).toContain(rule);
    expect(PB.buildArcRetellPrompt(input(), 10, 'STORY LOGIC: x', '1. fix')).toContain(rule);
    expect(PB.landmarksStagedRule(input({ availableLandmarks: [] }))).toBe('');
    expect(PB.buildArcCreatePrompt(input({ availableLandmarks: [] }), 10)).not.toContain('Landmarks staged');
    expect(PB.landmarksStagedRule(input({ premiseNamedWorld: true }))).not.toMatch(/at least/);
  });

  it('no arc prompt keeps an unfilled placeholder', () => {
    for (const p of [PB.buildArcCreatePrompt(input(), 10), PB.buildArcRetellPrompt(input(), 10, 'STORY LOGIC: x', '1. fix'), PB.buildArcPanelPrompt(input(), 'ARC: a')]) {
      expect(p).not.toMatch(/\{[A-Z][A-Z_]+\}/);
    }
  });

  it('the panel\'s LANDMARK lens checks the staged block against the sentences', () => {
    expect(PB.buildArcPanelPrompt(input(), 'ARC: a')).toMatch(/LANDMARKS STAGED block lists a landmark that no arc sentence/);
  });
});

describe('L2: the divider, the plan check and the Art Director read the typed list, not the arc prose', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the divider section lists only the staged landmarks, though the arc prose names another', () => {
    const arc = '1. Anna finds the egg on Alpha Bridge.\n2. Ben carries it into Beta Tower.';
    const withTyped = PB.buildBeatsPrompt(input({ landmarksStaged: ['Alpha Bridge'] }), 10, { finalArc: arc });
    expect(withTyped).toContain('REAL LANDMARKS the story above uses');
    expect(withTyped).toContain('- Alpha Bridge');
    expect(withTyped).not.toContain('- Beta Tower');
    expect(withTyped).toContain(PB.LANDMARK_STAGED_PAGES_RULE);
  });

  it('an arc that staged none (or an unread arc) gives the divider no landmark block', () => {
    const arc = '1. Anna finds the egg on Alpha Bridge.';
    expect(PB.buildBeatsPrompt(input({ landmarksStaged: [] }), 10, { finalArc: arc })).not.toContain('REAL LANDMARKS the story above uses');
    expect(PB.buildBeatsPrompt(input(), 10, { finalArc: arc })).not.toContain('REAL LANDMARKS the story above uses');
  });

  it('no arc: the planner is the author and keeps the full offered list', () => {
    expect(PB.buildBeatsPrompt(input({ landmarksStaged: null }), 10, { finalArc: '' })).toContain('- Beta Tower');
  });

  const BEATS = [1, 2, 3].map(n => ({ pageNumber: n, planLine: 'wide — Anna — she climbs — the egg is warm' }));
  const PLAN = BEATS.map(b => `Page ${b.pageNumber}: ${b.planLine}`).join('\n');
  const questionNumbers = (p: string) => [...p.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0].matchAll(/^(\d+)\.\s+\S/gm)].map(m => Number(m[1]));
  const NUMBER_WORDS: Record<string, number> = { fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18 };

  it('the plan check asks question 19 when the arc staged a landmark, and its own count stays true', () => {
    const asked = PB.buildPlanCheckPrompt(input({ landmarksStaged: ['Alpha Bridge'] }), BEATS, '1. a', PLAN);
    const plain = PB.buildPlanCheckPrompt(input({ landmarksStaged: [] }), BEATS, '1. a', PLAN);
    expect(questionNumbers(asked)).toContain(19);
    expect(questionNumbers(plain)).not.toContain(19);
    expect(questionNumbers(asked).length).toBe(questionNumbers(plain).length + 1);
    for (const p of [asked, plain]) {
      expect(NUMBER_WORDS[p.match(/Answer only these (\w+):/)![1]]).toBe(questionNumbers(p).length);
      expect(p).not.toMatch(/\{[A-Z][A-Z_]+\}/);
    }
    expect(asked).toContain('REAL LANDMARKS the story above uses');
    expect(asked).toContain(PB.LANDMARK_STAGED_PAGES_RULE);
    expect(plain).not.toContain('REAL LANDMARKS the story above uses');
  });

  it('a question 19 finding is must-fix for the re-plan', () => {
    expect(PB.replanRank({ check: 19, text: 'Page 4 ...' })).toBe('must');
  });

  it('the Art Director is told the chosen landmarks and the typed backdrop row; not when none were chosen', () => {
    const s = PB.buildAvailableLandmarksSection(OFFERED, { forArtDirector: true, staged: ['Alpha Bridge'] });
    expect(s).toContain('The story chose these listed landmarks: "Alpha Bridge"');
    expect(s).toContain('backdropLandmarks');
    expect(PB.buildAvailableLandmarksSection(OFFERED, { forArtDirector: true })).not.toContain('backdropLandmarks');
    expect(PB.buildAvailableLandmarksSection(OFFERED)).not.toContain('backdropLandmarks');
  });

  it('the Visual Bible template declares the backdropLandmarks field the Art Director writes', () => {
    expect(fs.readFileSync('prompts/visual-bible.txt', 'utf8')).toContain('"backdropLandmarks"');
  });
});

describe('L3 + L4: the final count is story pages only, and a recorded backdrop counts', () => {
  const loc = (name: string, pages: number[], real = true) => ({ id: `L${name}`, name, isRealLandmark: real, landmarkQuery: real ? name : null, appearsInPages: pages });

  it('a real landmark that only a cover uses (negative page numbers) does not count', () => {
    const vb = { locations: [loc('Alpha Bridge', [-1, -3]), loc('Beta Tower', [2])] };
    expect(LG.stagedLandmarks(vb, OFFERED).map((l: any) => l.name)).toEqual(['Beta Tower']);
  });

  it('REGRESSION: the old count took the cover-only place as the second landmark', () => {
    const vb = { locations: [loc('Alpha Bridge', [-1]), loc('Beta Tower', [2])] };
    const oldCount = vb.locations.filter((l: any) => l.isRealLandmark && l.appearsInPages.length > 0).length;
    expect(oldCount).toBe(2);
    expect(LG.stagedLandmarks(vb, OFFERED).length).toBe(1);
  });

  it('a backdropLandmarks row for an offered landmark counts; an unlisted one, a cover page and an empty page list do not', () => {
    const vb = {
      locations: [loc('Beta Tower', [2])],
      backdropLandmarks: [
        { landmarkQuery: 'alpha bridge', pages: [4, 5] },
        { landmarkQuery: 'Invented Castle', pages: [6] },
        { landmarkQuery: 'Gamma Abbey (Old Town)', pages: [-1] },
        { landmarkQuery: 'Gamma Abbey (Old Town)', pages: [] },
      ],
    };
    const staged = LG.stagedLandmarks(vb, OFFERED);
    expect(staged.map((l: any) => `${l.name}:${l.via}`)).toEqual(['Beta Tower:location', 'Alpha Bridge:backdrop']);
  });

  it('one landmark that is both a location and a backdrop counts once, with both pages', () => {
    const vb = { locations: [loc('Alpha Bridge', [1])], backdropLandmarks: [{ landmarkQuery: 'Alpha Bridge', pages: [3] }] };
    const staged = LG.stagedLandmarks(vb, OFFERED);
    expect(staged).toHaveLength(1);
    expect(staged[0].pages).toEqual([1, 3]);
  });

  it('an invented location, an empty bible and a missing bible stage nothing', () => {
    expect(LG.stagedLandmarks({ locations: [loc('Town', [1], false)] }, OFFERED)).toEqual([]);
    expect(LG.stagedLandmarks({}, OFFERED)).toEqual([]);
    expect(LG.stagedLandmarks(null, OFFERED)).toEqual([]);
  });

  it('the final count in storyJobPipeline uses it and still never fails the job', () => {
    const src = fs.readFileSync('storyJobPipeline.js', 'utf8');
    expect(src).toContain('stagedLandmarks(new UnifiedStoryParser(unifiedResponse).extractVisualBible(), inputData.availableLandmarks)');
    expect(src).toContain("genLog.warn('landmark_minimum_shortfall'");
    expect(src).not.toContain('stagedRealLandmarks');
  });
});

describe('L5: the Visual Bible landmark retry is deleted, not demoted', () => {
  it('beatsPipeline asks the bible once per attempt and carries no landmark retry', () => {
    const src = fs.readFileSync('server/lib/beatsPipeline.js', 'utf8');
    for (const gone of ['landmarkRetry', 'landmarkRetryNote', 'stagedRealLandmarks', 'LANDMARK_MINIMUM', "'landmark-retry'", 'meta.landmarkRetry']) {
      expect(src, gone).not.toContain(gone);
    }
  });

  it('landmarkGuideline exports no retry note, and the prompt builders take no retryNote', () => {
    expect(LG.landmarkRetryNote).toBeUndefined();
    expect(LG.stagedRealLandmarks).toBeUndefined();
    const pb = fs.readFileSync('server/lib/promptBuilders.js', 'utf8');
    expect(pb).not.toContain('landmarkRetryNote');
    expect(pb).not.toContain('retryNote');
    const job = fs.readFileSync('storyJobPipeline.js', 'utf8');
    expect(job).not.toContain('landmarkRetryNote');
    expect(job).not.toContain('LandmarkShortfallAbort');
  });
});
