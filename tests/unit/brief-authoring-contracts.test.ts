/**
 * FOUR DEFECTS OF ONE SHAPE (staging job_1789584708605_rts4wqupm, 2026-09-17).
 *
 * Everything the image model reliably obeys travels in the brief's STRUCTURED
 * metadata — `objects[]`, `interactions[]`, `characters[]` — which the page
 * builder re-anchors into the protected tail (`**REQUIRED OBJECTS` / EXACT
 * POSES). A page-critical fact that lives only in the Art Director's prose
 * paragraph, or nowhere at all, is advisory. That run shipped four of them:
 *
 *   p10  an iterate reinstated a roster character the parent brief had dropped,
 *        with no CHARACTER DETAILS entry to describe him from, and wrote the
 *        iteration template's own apparent-age example instead — a 4-year-old
 *        rendered as a bearded middle-aged man.
 *   p7/  the object's concealment ("inside the jacket") stayed in the prose and
 *   p11  fell out of the interaction's `where`, so the tail read "holds the egg
 *        tightly against his chest" and the render obeyed it. p9 is the control:
 *        identical REQUIRED OBJECTS line, `where` = "carries the heavy bulge in
 *        the front of his jacket", object correctly hidden.
 *   p1/  a prop the page text puts against a character was never declared at
 *   p5   all, so p1 built no REQUIRED OBJECTS block (finalChecksReport
 *        .notEvaluated, reason `no_required_objects`) and p5 lost the ball.
 *   p8   the shadow of an off-page creature reached prose + emptyScenePrompt and
 *        nothing else, with no silhouette shape stated; the sky came back clear.
 *        NOT FIXED and deliberately not contracted — two staging renders (Lab
 *        #1279/#1280) produced two different failure modes, so no rule shipped.
 *   p4   the one case where the structured channel WAS used and the model still
 *        disobeyed: a body-part contact phrased as a noun.
 *
 * Every fixture here is verbatim stored data from that run. What is pinned is
 * ARRIVAL and STRUCTURE — that each contract reaches every brief-authoring site
 * from one constant, that a reinstated character arrives with his sheet, and
 * that a concealed object's pose lands in the protected tail — never the
 * wording of any rule. Offline and free: nothing here calls a paid API.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { collectPlanLineCast, planStagedSegment } = require('../../server/lib/iterateBeat');
const { loadPromptTemplates } = require('../../server/services/prompts');

// ── Real stored fixtures ────────────────────────────────────────────────────

/** sceneDescriptions[9].outlineExtract, verbatim. */
const P10_PLAN_LINE =
  "PLAN: close-up — Julian — Julian pulls the Marroni bag out of Levin's jacket and holds it to his mouth, cheeks full — the bag is now flat and cooling, the egg's warmth is threatened";

/** sceneDescriptions[2].outlineExtract — a subject page, no roster cast. */
const P3_PLAN_LINE =
  'PLAN: close-up — the egg alone — the warm, football-sized egg glows in the dark hollow among the roots — the egg is the thing the story is driving toward';

/** The roster, from stories.data.characters (traits trimmed to what the builder reads). */
const ROSTER = [
  { id: 'c-levin', name: 'Levin', age: 4, gender: 'boy', hairColor: 'light blonde', eyeColor: 'green' },
  { id: 'c-julian', name: 'Julian', age: 2, gender: 'boy', hairColor: 'light blonde', eyeColor: 'blue' },
];

/** p10 imageVersions[0].description — the PARENT brief the iterate rewrote. */
const P10_PARENT_CHARACTERS = [{ name: 'Julian', clothing: 'standard', position: 'center foreground' }];

/**
 * p11's brief with its concealment written where the contract now puts it.
 * The prose and the object citation are the stored ones; only the `where`
 * carries the covering, which is exactly the p9-vs-p11 difference.
 */
const P11_BRIEF_CONCEALED = `Ramon, an eight-year-old boy, tall and lanky, stands with both hands wrapped around the handles of his push-scooter in the lane, staring down at Levin. Levin, a preschooler, wears his red zip-up fleece jacket and holds the bundle tight against his chest under the jacket, the shell itself out of sight. Medium shot.

---METADATA---
{"sceneIntent": "Ramon stands with his scooter, looking down at Levin. Levin clutches the bundle under his jacket and stares back.", "characters": [{"name": "Levin", "clothing": "standard", "position": "right foreground", "depth": "foreground", "looksAt": "CHR001", "expression": "defiant eyes, hard stare, pressed lips"}], "shot": "medium", "era": "present day", "objects": ["ART001"], "interactions": [{"character": "Levin", "object": "ART001", "where": "carries the bulge under the front of his jacket", "action": "carrying", "hands": true, "storyRelevant": true, "priority": "essential"}], "wornItems": [{"id": "ART004", "owner": "Levin", "state": "worn"}]}`;

/** stories.data.visualBible artifacts, verbatim shape (pages/states trimmed to p11). */
const VISUAL_BIBLE: any = {
  artifacts: [
    {
      id: 'ART001', name: 'smooth egg', label: 'dragon egg', type: 'artifact',
      pages: [11], scaleClass: 'head-sized',
      description: 'pale orange, smooth, glowing faintly from within',
      states: [],
    },
    {
      id: 'ART004', name: 'fleece jacket', label: 'red jacket', type: 'outer layer',
      pages: [11], scaleClass: 'hand-sized', wornAs: 'Levin.outer layer',
      description: 'red fleece fabric garment with a full front zipper',
      states: [],
    },
  ],
  locations: [], vehicles: [], animals: [], secondaryCharacters: [], clothing: [],
};

const inputData: any = {
  title: 'Das Ei unter der Wurzel',
  characters: ROSTER, mainCharacters: ['c-levin'],
  language: 'de-ch', languageLevel: 'medium', pages: 18,
  storyCategory: 'adventure', storyType: 'adventure',
  storyDetails: 'x', artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
};

const BEATS = [{ pageNumber: 10, planLine: P10_PLAN_LINE.replace(/^PLAN:\s*/, '') }];

const unfilled = (p: string) => [...new Set(String(p).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

/** The split the shrink pass protects — images.js sceneHeadOf uses the same one. */
function protectedTail(prompt: string): string {
  const o = prompt.indexOf('**REQUIRED OBJECTS');
  const start = o >= 0 ? o : prompt.indexOf('**ART STYLE');
  return start > 0 ? prompt.slice(start) : '';
}

// ── 1. A reinstated roster character arrives with his sheet ─────────────────

describe('a roster character the plan line stages is offered to the iterate rewriter', () => {
  it('reinstates the character the parent brief dropped, and only that one', () => {
    const locked = ROSTER.filter(c => P10_PARENT_CHARACTERS.some(p => p.name === c.name));
    expect(locked.map(c => c.name)).toEqual(['Julian']);
    const back = collectPlanLineCast({ characters: ROSTER, planLine: P10_PLAN_LINE, alreadyLocked: locked });
    expect(back.map((c: any) => c.name)).toEqual(['Levin']);
  });

  it('never duplicates a character the lock already holds', () => {
    const back = collectPlanLineCast({ characters: ROSTER, planLine: P10_PLAN_LINE, alreadyLocked: ROSTER });
    expect(back).toEqual([]);
  });

  it('reinstates nobody on a subject page whose plan line names no roster character', () => {
    expect(collectPlanLineCast({ characters: ROSTER, planLine: P3_PLAN_LINE, alreadyLocked: [] })).toEqual([]);
  });

  it('reads the staged segment only, never the shot field or the trailing purpose clause', () => {
    const staged = planStagedSegment(P10_PLAN_LINE);
    expect(staged).not.toMatch(/close-up/);
    expect(staged).not.toMatch(/warmth is threatened/);
    expect(staged).toMatch(/Levin/);
  });

  it('with no plan line the lock is untouched', () => {
    expect(collectPlanLineCast({ characters: ROSTER, planLine: null, alreadyLocked: [] })).toEqual([]);
  });
});

// ── 2-6. The built prompts ─────────────────────────────────────────────────

describe('the brief-authoring contracts reach every site that writes a brief', () => {
  let built: Record<string, string>;

  beforeAll(async () => {
    await loadPromptTemplates();
    built = {
      'AD all-pages': PB.buildSceneExpansionAllPrompt(inputData, BEATS, {}),
      'AD per-page': PB.buildSceneExpansionPrompt(
        10, 'page text', ROSTER, 'de-ch', VISUAL_BIBLE, '', null, {}),
      'iterate strict': PB.buildSceneDescriptionPrompt(
        10, 'page text', ROSTER, '', 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P10_PLAN_LINE }, { fixIssues: ['Levin missing'] }, { freeIterate: false }),
      'iterate free': PB.buildSceneDescriptionPrompt(
        10, 'page text', ROSTER, '', 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P10_PLAN_LINE }, { fixIssues: ['Levin missing'] }, { freeIterate: true }),
    };
  });

  it('exports each contract as a non-empty constant', () => {
    for (const name of [
      'CONCEALED_OBJECT_RULE', 'STAGED_PROP_RULE',
      'CONTACT_VERB_RULE', 'ELEMENT_ENTRY_PAGE_RULE',
    ]) {
      expect(typeof PB[name], `${name} is not exported`).toBe('string');
      expect(PB[name].length, name).toBeGreaterThan(40);
    }
  });

  for (const rule of ['CONCEALED_OBJECT_RULE', 'STAGED_PROP_RULE', 'CONTACT_VERB_RULE']) {
    it(`all four brief-authoring sites carry ${rule}, from that one constant`, () => {
      for (const [site, prompt] of Object.entries(built)) {
        expect(prompt.includes(PB[rule]), `${site} lost ${rule}`).toBe(true);
      }
    });
  }

  it('no placeholder token survives in any brief-authoring prompt', () => {
    for (const [site, prompt] of Object.entries(built)) {
      expect(unfilled(prompt), `${site} shipped an unfilled placeholder`).toEqual([]);
    }
  });

  it('the two Visual-Bible authoring sites carry the entry-page contract', () => {
    const trial = String(PB.buildTrialStoryPrompt(inputData));
    for (const [site, prompt] of [['AD all-pages', built['AD all-pages']], ['trial writer', trial]] as const) {
      expect(prompt.includes(PB.ELEMENT_ENTRY_PAGE_RULE), `${site} lost the entry-page contract`).toBe(true);
    }
    expect(unfilled(trial), 'trial writer shipped an unfilled placeholder').toEqual([]);
  });

  it('a reinstated character reaches CHARACTER DETAILS — without him there is nothing to weave', () => {
    const withoutLevin = PB.buildSceneDescriptionPrompt(
      10, 'page text', [ROSTER[1]], '', 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
      { planLine: P10_PLAN_LINE }, { fixIssues: ['Levin missing'] }, { freeIterate: false });
    const withLevin = built['iterate strict'];
    // The rewriter is asked to weave each named character's appearance "from
    // CHARACTER DETAILS"; the locked-cast build had no Levin block at all.
    expect(/^\s*\d+\.\s+Levin,\s+Looks:/m.test(withoutLevin), 'the dropped character was already described').toBe(false);
    expect(/^\s*\d+\.\s+Levin,\s+Looks:/m.test(withLevin), 'the reinstated character has no CHARACTER DETAILS block').toBe(true);
  });
});

// ── 7. A concealed object's pose lands in the protected tail ────────────────

describe('a concealed object is staged as the shape it makes, in the protected tail', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the covering rides the EXACT POSES line, after the REQUIRED OBJECTS / ART STYLE split', () => {
    const prompt = String(PB.buildImagePrompt(
      P11_BRIEF_CONCEALED, inputData, [ROSTER[0]], VISUAL_BIBLE, 11, null, {}));
    const tail = protectedTail(prompt);
    expect(tail, 'the prompt has no protected tail').not.toBe('');
    const poseLine = tail.split('\n').find(l => /^- Levin:/.test(l)) || '';
    expect(poseLine, 'no EXACT POSES line for the carrying character').not.toBe('');
    // The declared `where` is what the tail carries, verbatim — that is the one
    // channel a shrink cannot compress away.
    expect(poseLine).toContain('carries the bulge under the front of his jacket');
    expect(prompt.indexOf(poseLine)).toBeGreaterThan(prompt.length - tail.length - 1);
  });

  it('the HANDS rule in that tail no longer sends a free hand to a contact the brief gave elsewhere', () => {
    const prompt = String(PB.buildImagePrompt(
      P11_BRIEF_CONCEALED, inputData, [ROSTER[0]], VISUAL_BIBLE, 11, null, {}));
    expect(protectedTail(prompt)).toContain(PB.HANDS_HOLD_ONLY_NAMED_RULE);
    expect(PB.HANDS_HOLD_ONLY_NAMED_RULE).not.toContain('touches what the scene describes');
  });
});
