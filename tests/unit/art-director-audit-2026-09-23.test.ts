/**
 * ART DIRECTOR / SCENE REVIEW — the 2026-09-23 prompt audit
 * (docs/audits/prompt-audit-2026-09-23/04-art-director.md).
 *
 * Fixtures are trimmed from staging job_1790100385959_1nitlympp: LOC002 is a
 * real landmark with five vantages, and the page shots / citations are the
 * stored ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { REVIEWABLE } = require_('../../server/lib/sceneBriefCheck');
import { checkPage, checkSceneConsistency } from '../helpers/cast-index';
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const { VANTAGE_SHOT_RULE, PLATE_DERIVED_SHOTS } = require_('../../server/lib/shotVocabulary');

const bible = () => ({
  secondaryCharacters: [], animals: [], artifacts: [], vehicles: [], clothing: [],
  locations: [{
    id: 'LOC002', name: 'Lindenhof', isRealLandmark: true, landmarkQuery: 'Lindenhof',
    pages: [2, 3, 12, 13, 14, 18],
    vantages: [
      { id: 'LOC002.1', shot: 'ultra-wide', pages: [2, 18] },
      { id: 'LOC002.2', shot: 'medium', pages: [3] },
      { id: 'LOC002.4', shot: 'aerial', pages: [12, 13] },
      { id: 'LOC002.5', shot: 'high-angle', pages: [14] },
    ],
  }],
});
const brief = (meta: any) => `Prose.\n\n---METADATA---\n${JSON.stringify({ characters: [], ...meta })}`;
const typesOn = (pageNumber: number, meta: any) =>
  checkPage({ pageNumber, brief: brief(meta) }, [], bible(), {}).map((f: any) => f.type);

// DELETED 2026-09-24 (Lab 1433): sent on 18 of 18 pages, answered `exterior`
// on every one — the value a missing field already resolves to — and the
// review rewrote every page to set it.
describe('landmark_view_missing is gone', () => {
  it('a real-landmark page with no landmarkView raises nothing', () => {
    expect(typesOn(3, { shot: 'medium', objects: ['LOC002.2'], timeOfDay: 'morning', weather: 'clear' })).toEqual([]);
  });
  it('is not a type the scene review can be sent', () => {
    expect(REVIEWABLE.has('landmark_view_missing')).toBe(false);
  });
});

describe('shot_off_plate', () => {
  it('fires on an eye-level page drawn on an angled vantage (p13: close-up on the aerial plate)', () => {
    const f = checkPage({ pageNumber: 13, brief: brief({ shot: 'close-up', objects: ['LOC002.4'], landmarkView: 'close' }) }, [], bible(), {});
    const hit = f.find((x: any) => x.type === 'shot_off_plate');
    expect(hit).toBeTruthy();
    // It names the vantages whose plate CAN hold the page.
    expect(hit.detail).toContain('LOC002.2');
  });
  it('fires on a medium on the ultra-wide plate (p18)', () => {
    expect(typesOn(18, { shot: 'medium', objects: ['LOC002.1'], landmarkView: 'distant' })).toContain('shot_off_plate');
  });
  it('is quiet when the page shot matches its angled vantage', () => {
    expect(typesOn(12, { shot: 'aerial', objects: ['LOC002.4'], landmarkView: 'distant' })).not.toContain('shot_off_plate');
  });
  it('is quiet for an angled page on an eye-level vantage — that plate is derived from it', () => {
    expect(typesOn(3, { shot: 'low-angle', objects: ['LOC002.2'], landmarkView: 'exterior' })).not.toContain('shot_off_plate');
  });
  it('the Art Director is told the same line, built from the same shot set', () => {
    for (const shot of PLATE_DERIVED_SHOTS) expect(VANTAGE_SHOT_RULE).toContain('`' + shot + '`');
  });
  it('is REVIEWABLE', () => {
    expect(REVIEWABLE.has('shot_off_plate')).toBe(true);
  });

  // The plan's shot wins (2026-09-24, Lab 1433): a page whose shot is the plan
  // line's is never told to take the plate's shot instead.
  const onPlan = (pageNumber: number, planLine: string, meta: any) =>
    checkPage({ pageNumber, planLine, brief: brief(meta) }, [], bible(), {}).find((x: any) => x.type === 'shot_off_plate');
  it('a planned close-up on the aerial plate is offered a vantage, never a new shot (p13)', () => {
    const hit = onPlan(13, 'close-up — Turi — Turi sits among the leaves — he is frightened', { shot: 'close-up', objects: ['LOC002.4'] });
    expect(hit).toBeTruthy();
    expect(hit.detail).toContain('LOC002.2');
    expect(hit.detail).toContain("Keep `shot`: it is the plan line's.");
    expect(hit.detail).not.toContain('set `shot` to');
  });
  it('with no vantage that can hold it, a planned shot stands', () => {
    const vb = bible();
    vb.locations[0].vantages = vb.locations[0].vantages.filter((v: any) => v.id !== 'LOC002.2');
    const hit = checkPage({ pageNumber: 13, planLine: 'close-up — Turi — x — y', brief: brief({ shot: 'close-up', objects: ['LOC002.4'] }) }, [], vb, {})
      .find((x: any) => x.type === 'shot_off_plate');
    expect(hit.detail).toContain('say it stands');
    expect(hit.detail).not.toContain('set `shot` to');
  });
  it('a shot the plan line did not ask for may still take the plate\'s shot', () => {
    const hit = onPlan(13, 'aerial — Turi — x — y', { shot: 'close-up', objects: ['LOC002.4'] });
    expect(hit.detail).toContain('set `shot` to `aerial`');
  });
});

// The plan's close-up wins (2026-09-24, Lab 1433 p8): the reviewer widened a
// planned close-up under 7b while `shot_widened` reported that very widening.
describe('one close-up rule for the Art Director and shot_widened', () => {
  const { CLOSEUP_KEPT_RULE } = require_('../../server/lib/shotVocabulary');
  it('shot_widened states the rule', () => {
    const hit = checkPage({ pageNumber: 8, planLine: 'close-up — Mira — Mira presses the bag against the shell — it is warm', brief: brief({ shot: 'medium' }) }, [], bible(), {})
      .find((x: any) => x.type === 'shot_widened');
    expect(hit.detail).toContain(CLOSEUP_KEPT_RULE);
  });
  it('the Art Director keeps a planned close-up', async () => {
    await loadPromptTemplates();
    const inputData = { language: 'en', pages: 1, characters: [{ id: 1, name: 'Mira' }], mainCharacters: [1] };
    const ad = String(PB.buildSceneBriefsAllPrompt(inputData, [{ pageNumber: 1, planLine: 'close-up — Mira — x — y' }], { jevBackup: true }));
    expect(ad).toContain(CLOSEUP_KEPT_RULE);
    expect(ad).not.toContain('{CLOSEUP_KEPT}');
    expect(ad).not.toContain('or make the page a `medium` shot');
  });
});

describe('built prompts', () => {
  const inputData = {
    language: 'en', pages: 2,
    characters: [{ id: 1, name: 'Mira', age: '6', gender: 'female' }, { id: 2, name: 'Tom', age: '7', gender: 'male' }],
    mainCharacters: [1, 2],
  };
  const BEATS = [{ pageNumber: 1, planLine: 'medium — Mira — Mira lifts the lantern — it glows' }, { pageNumber: 2, planLine: 'wide — Tom — Tom runs — he is gone' }];
  let ad = '';
  beforeAll(async () => {
    await loadPromptTemplates();
    ad = String(PB.buildSceneBriefsAllPrompt(inputData, BEATS, {}));
  });

  it('a cast with no primary characters never reads "and None" in the cover beats', () => {
    // The cover cast moved out of the Art Director template into the cover
    // pages' own beats (coverBeats.js, 2026-09-24).
    const { buildCoverBeats } = require_('../../server/lib/coverBeats.js');
    const beats = buildCoverBeats(inputData);
    expect(ad).not.toMatch(/and None/);
    expect(beats.map((b: any) => b.planLine).join('\n')).not.toMatch(/\bNone\b/);
    expect(beats.find((b: any) => b.coverKey === 'initialPage').planLine).toMatch(/^wide — Mira, Tom — /);
  });

  it('eyes-open and the creature face reach the generator from one constant', () => {
    expect(ad).toContain(PB.EYES_OPEN_RULE);
    expect(ad).toContain(PB.CREATURE_FACE_RULE);
  });

  it('the Art Director cites an object state dotted', () => {
    expect(ad).toMatch(/always cited dotted, the pages before its first change included/);
  });

  it('the Art Director gets no rule about the page text or the art style it is never shown', () => {
    expect(ad).not.toContain('The page text is not a checklist');
    expect(ad).not.toContain('A prop the page text puts against a character');
    expect(ad).not.toContain('must render in the named illustration style');
  });

  it('the spec, the creature tone and the generic rule are stated once', () => {
    // The Visual Bible rules live in the Art Director's first call (2026-09-28).
    const bible = String(PB.buildVisualBibleCallPrompt(inputData, BEATS, {}));
    const spec = require_('../../server/lib/visualBible').SCALE_CLASS_SPEC;
    expect(bible.split(spec).length - 1).toBe(1);
    expect(bible.split('swap it between two pages and no reader could tell').length - 1).toBe(1);
    expect(ad.split(spec).length - 1, 'the page-brief call restates the scale spec').toBe(0);
  });

  it('depth is required on every character, with no contradicting optional line', () => {
    expect(ad).not.toContain('Only add `depth` when');
  });
});


// A place is not a grip (2026-09-23): p9 / p12 of the same run were faulted
// "2 characters have hands on loc002.3" for banking leaves on the ground.
describe('the hand-off counters never count a location id as a one-grip object', () => {
  const { handsPerObject } = require_('../../server/lib/sceneMetadata');
  const rows = [
    { character: 'Levin + Kiaan', object: 'LOC002.3', hands: true, action: 'banking leaves' },
    { character: 'Max', object: 'LOC002', hands: true, action: 'banking leaves' },
  ];
  const shared = [{ character: 'Levin + Kiaan', object: 'ART002.1', hands: true, action: 'lifting' }];
  const typesD = (interactions: any[]) => checkPage({ pageNumber: 9, brief: brief({ shot: 'medium', objects: ['LOC002.2'], landmarkView: 'exterior', interactions }) }, [], bible(), {})
    .map((f: any) => f.type);
  const typesC3 = (interactions: any[]) => checkSceneConsistency([{ pageNumber: 9, sceneProse: 'Prose.', sceneHint: JSON.stringify({ characters: [], objects: [], interactions }) }])
    .flatMap((r: any) => r.issues.map((i: any) => i.type));

  it('handsPerObject skips LOC ids, bare and dotted', () => {
    expect([...handsPerObject(rows).keys()]).toEqual([]);
    expect(handsPerObject(shared).get('art002.1')).toEqual(['Levin', 'Kiaan']);
  });
  it('neither counter fires on a place', () => {
    expect(typesD(rows)).not.toContain('interaction_object_shared_hands');
    expect(typesC3(rows)).not.toContain('interaction_object_shared_hands');
  });
  // Owner, 2026-09-23: a joint hold is allowed when it is the page's ONLY action.
  it('a joint hold that is the page\'s only action is allowed by both counters', () => {
    expect(typesD(shared)).not.toContain('interaction_object_shared_hands');
    expect(typesC3(shared)).not.toContain('interaction_object_shared_hands');
    const withWatcher = [...shared, { character: 'Max', object: 'Levin', hands: false, action: 'watching' }];
    expect(typesD(withWatcher)).not.toContain('interaction_object_shared_hands');
  });
  it('both fire when the joint hold sits beside another action', () => {
    const busy = [...shared, { character: 'Max', object: 'ART003', hands: true, action: 'waving the scale' }];
    expect(typesD(busy)).toContain('interaction_object_shared_hands');
    expect(typesC3(busy)).toContain('interaction_object_shared_hands');
  });
  it('a hand-over (two rows, two actions) still fires', () => {
    const handover = [
      { character: 'Levin', object: 'ART002.1', hands: true, action: 'handing the egg' },
      { character: 'Kiaan', object: 'ART002.1', hands: true, action: 'taking the egg' },
    ];
    expect(typesD(handover)).toContain('interaction_object_shared_hands');
    expect(typesC3(handover)).toContain('interaction_object_shared_hands');
  });
  it('a row with no action label is never the sole action', () => {
    expect(typesD([{ character: 'Levin + Kiaan', object: 'ART002.1', hands: true }])).toContain('interaction_object_shared_hands');
  });
  it('the Art Director carries the rule', () => {
    const { SHARED_GRIP_RULE } = require_('../../server/lib/sceneMetadata');
    expect(String(PB.buildSceneBriefsAllPrompt({ language: 'en', characters: [{ id: 1, name: 'Mira' }], mainCharacters: [1] }, [{ pageNumber: 1, planLine: 'medium \u2014 Mira \u2014 x \u2014 y' }], {}))).toContain(SHARED_GRIP_RULE);
  });
});
