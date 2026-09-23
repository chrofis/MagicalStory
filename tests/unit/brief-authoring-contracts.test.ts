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
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

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
      pages: [11], scaleClass: 'melon-sized',
      description: 'pale orange, smooth, glowing faintly from within',
      states: [],
    },
    {
      id: 'ART004', name: 'fleece jacket', label: 'red jacket', type: 'outer layer',
      pages: [11], scaleClass: 'forearm-sized', wornAs: 'Levin.top',
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
      'CONTACT_VERB_RULE', 'REACHABLE_CONTACT_RULE', 'ELEMENT_ENTRY_PAGE_RULE',
      'EXPRESSION_FIELD_RULE',
    ]) {
      expect(typeof PB[name], `${name} is not exported`).toBe('string');
      expect(PB[name].length, name).toBeGreaterThan(40);
    }
  });

  for (const rule of ['CONCEALED_OBJECT_RULE', 'STAGED_PROP_RULE', 'CONTACT_VERB_RULE',
    'REACHABLE_CONTACT_RULE', 'EXPRESSION_FIELD_RULE']) {
    it(`all four brief-authoring sites carry ${rule}, from that one constant`, () => {
      for (const [site, prompt] of Object.entries(built)) {
        // A page-TEXT rule, and the all-pages Art Director runs before any
        // page text exists (owner, 2026-09-23): it must NOT carry it.
        if (rule === 'STAGED_PROP_RULE' && site === 'AD all-pages') {
          expect(prompt.includes(PB[rule]), `${site} carries a page-text rule it cannot apply`).toBe(false);
          continue;
        }
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

// ── 8. The element's SIZE rides the pose line that meets it ─────────────────

/**
 * FIFTH DEFECT OF THE SAME SHAPE (2026-09-17). ART001's band is authored and
 * correct, and the REQUIRED OBJECTS block stated it on 12 of the 13 pages that
 * cite it — yet the element rendered at beach-ball size on exactly the three
 * pages whose EXACT POSES line put no hand, arm or ear on it (p5, p6, p14),
 * and correctly on the six that did. The checklist line is a presence claim;
 * the `where` clause is the field the render obeys, which is the same split
 * p9-vs-p11 proved for concealment. A/B on staging (Lab #1281 control vs #1284
 * candidate, #1288 control vs #1286 candidate) shrank the element on both
 * failing pages and left an already-correct page alone.
 *
 * Pinned here: ARRIVAL and STRUCTURE — that the scale reaches the pose line,
 * from the same helper the checklist uses, once per element, after the declared
 * `where` and never before it. The band wording belongs to visualBible.js.
 */
describe("an element's scale reaches the pose line that meets it", () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const EGG = VISUAL_BIBLE.artifacts[0];
  const scaleOf = (entry: any) => String(require('../../server/lib/visualBible').elementScaleNote(entry));

  it('the scale rides the EXACT POSES line, in the protected tail, as the checklist states it', () => {
    const prompt = String(PB.buildImagePrompt(
      P11_BRIEF_CONCEALED, inputData, [ROSTER[0]], VISUAL_BIBLE, 11, null, {}));
    const tail = protectedTail(prompt);
    const poseLine = tail.split('\n').find(l => /^- Levin:/.test(l)) || '';
    expect(poseLine, 'no EXACT POSES line for the carrying character').not.toBe('');
    expect(poseLine, 'the pose line carries no scale for the element it names').toContain(scaleOf(EGG));
    // ONE element, ONE scale, ONE name: the rider is built from the same helper
    // and the same label the REQUIRED OBJECTS lead uses.
    expect(tail, 'the checklist lost the scale the pose line now repeats').toContain(scaleOf(EGG));
  });

  it('the rider follows the declared `where` — a concealment clause still leads the line', () => {
    const prompt = String(PB.buildImagePrompt(
      P11_BRIEF_CONCEALED, inputData, [ROSTER[0]], VISUAL_BIBLE, 11, null, {}));
    const poseLine = protectedTail(prompt).split('\n').find(l => /^- Levin:/.test(l)) || '';
    const whereAt = poseLine.indexOf('carries the bulge under the front of his jacket');
    const riderAt = poseLine.indexOf(scaleOf(EGG));
    expect(whereAt, 'the declared where left the pose line').toBeGreaterThan(-1);
    expect(riderAt, 'the scale rider left the pose line').toBeGreaterThan(whereAt);
  });

  it('a multi-character row splits into one line per figure and states the scale once', () => {
    const block = String(PB.buildExactPosesBlock(
      [{ character: 'Levin + Julian + Max', object: 'ART001', where: 'stack their hands on the egg', priority: 'essential' }],
      [], VISUAL_BIBLE, { language: 'de-ch' }));
    const poseLines = block.split('\n').filter(l => l.startsWith('- '));
    expect(poseLines.length, 'the multi-character row did not split per figure').toBe(3);
    const withScale = poseLines.filter(l => l.includes(scaleOf(EGG)));
    expect(withScale.length, 'the scale was repeated on every split line').toBe(1);
  });

  it('a free-text object gets no rider — only a Visual Bible handle resolves', () => {
    const block = String(PB.buildExactPosesBlock(
      [{ character: 'Levin', object: 'the dirt', where: 'leans forward over the prints in the dirt', priority: 'essential' }],
      [], VISUAL_BIBLE, { language: 'de-ch' }));
    expect(block).toContain('leans forward over the prints in the dirt');
    expect(block, 'a free-text object was resolved against the bible').not.toContain(scaleOf(EGG));
  });

  it('an element with no authored band gets no rider at all', () => {
    const bandless = { ...VISUAL_BIBLE, artifacts: [{ ...EGG, scaleClass: null, size: '' }] };
    const block = String(PB.buildExactPosesBlock(
      [{ character: 'Levin', object: 'ART001', where: 'holds the egg', priority: 'essential' }],
      [], bandless, { language: 'de-ch' }));
    expect(block).toBe('EXACT POSES:\n- Levin: holds the egg');
  });
});

// ── 7. An object several characters touch (same run, p6) ────────────────────

/**
 * p6 of the same run shipped TWO of the object in one frame: a correctly sized
 * one still inside the recess the brief put it in, and a second, oversized one
 * out in the open where eight hands could reach it. The brief asked for both at
 * once — the object "in the hollow at the base of the tree" AND four characters
 * stacking hands on it — and the model answered by drawing one of each.
 *
 * Fixtures below are the stored p6 plan line and brief, verbatim. What is
 * pinned is ARRIVAL: the reach contract reaches every site that authors or
 * REWRITES a brief, from one constant, with nothing left unfilled. The rule's
 * wording is not asserted anywhere.
 */
const P6_PLAN_LINE =
  'PLAN: wide — Levin, Julian, Max, and Kiaan — all four press their hands onto the egg at once, none letting go — the four strangers are bound to the egg together';

/** sceneImages[5].sceneDescription, verbatim — the brief a repair round rewrites. */
const P6_BRIEF_PROSE =
  "Clustered tightly together around the hollow at the base of the tree on the Lindenhof, all four boys reach into the dirt toward the glowing shell of the melon-sized, pale orange dragon egg at the same moment. Levin kneels on the left and presses his palms flat against the left side of the shell. Julian crouches beside him, pressing his small hands over Levin's shoulders as he leans in. On the right side, Max and Kiaan kneel close together, stacking their hands on top of Levin's in the dirt. Wide shot of the entire group surrounding the hollow in the bright afternoon sun, all four joined in one hold.";

describe('the reach contract reaches every site that writes or rewrites this page', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('is exported as one non-empty constant', () => {
    expect(typeof PB.REACHABLE_CONTACT_RULE).toBe('string');
    expect(PB.REACHABLE_CONTACT_RULE.length).toBeGreaterThan(40);
  });

  it('the all-pages Art Director carries it when authoring p6 from its real plan line', () => {
    const prompt = String(PB.buildSceneExpansionAllPrompt(
      inputData, [{ pageNumber: 6, planLine: P6_PLAN_LINE.replace(/^PLAN:\s*/, '') }], {}));
    expect(prompt.includes(PB.REACHABLE_CONTACT_RULE), 'the Art Director never got the reach contract').toBe(true);
    expect(unfilled(prompt), 'the Art Director prompt shipped an unfilled placeholder').toEqual([]);
  });

  it.each([['strict', false], ['free', true]])(
    'a %s rewrite of p6 — the real stored brief as its starting point — carries it too',
    (_label, freeIterate) => {
      const prompt = String(PB.buildSceneDescriptionPrompt(
        6, 'page text', ROSTER, P6_BRIEF_PROSE, 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P6_PLAN_LINE },
        { fixIssues: ['two of the object in frame'], previousScore: -20 },
        { freeIterate }));
      expect(prompt.includes(P6_BRIEF_PROSE), 'the stored brief never reached the rewriter').toBe(true);
      expect(prompt.includes(PB.REACHABLE_CONTACT_RULE), 'one repair round would delete the reach contract').toBe(true);
      expect(unfilled(prompt), 'the rewrite prompt shipped an unfilled placeholder').toEqual([]);
    });
});

// ── 8. An object whose PLACEMENT is what the page is about ───────────────

/**
 * The other half of the same contract (staging job_1789681157795_wkt20ckod p12,
 * 2026-09-18). The reach rule shipped unconditional and this page is where that
 * cost the plot: the page text wedges a heavy object into a gap in a wall and
 * the whole beat is three characters failing to shift it. The render put it on
 * open ground in front of the wall — semantic setting/MAJOR, raised to CRITICAL
 * by the book audit, page scored 0.
 *
 * The stored brief is the evidence for WHERE the fact has to travel: its prose
 * says "wedged tightly between the stones" and its emptyScenePrompt says "a dark
 * rectangular gap where a stone is wedged", but all three `where` values read
 * "presses both hands flat against the ... stone" and the three EXACT POSES
 * lines in the protected tail named no gap and no wall. Prose is advisory; the
 * tail is the instruction.
 *
 * Fixtures are that page's stored plan line and brief prose, verbatim. What is
 * pinned is ARRIVAL and SINGLE SOURCE — the contract reaches all four
 * brief-authoring prompts, exactly once each, out of one exported constant, with
 * no placeholder left unfilled. No wording is asserted.
 */
const P12_PLAN_LINE =
  "PLAN: ultra-wide — Levin, Max, Kiaan, and Julian braced against the big wedged stone in the gap, feet dug into the earth — Julian's hands fall away from the stone as the others push — the stone does not move and Julian has frozen";

/** sceneImages[11].sceneDescription prose, verbatim (character sheets trimmed). */
const P12_BRIEF_PROSE =
  'Max stands in the foreground at the dark gap in the stone retaining wall, both hands pressed flat against the heavy blocky grey limestone stone wedged tightly between the stones, feet dug deep into the earth. Kiaan stands beside Max, also in the foreground, both hands pressed flat against the same stone, feet dug into the earth. Levin stands to the right of Kiaan, also in the foreground, both hands pressed flat against the stone, feet dug into the earth. Julian stands just behind the trio, centered slightly back in the midground, arms falling loosely at his sides, head lowered, hands empty and not touching the stone. The stone remains unmoved. Ultra-wide shot, eye-level perspective, shallow depth.';

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('the reach contract survives on the page whose placement is the point', () => {
  let p12: Record<string, string>;

  beforeAll(async () => {
    await loadPromptTemplates();
    p12 = {
      'AD all-pages': String(PB.buildSceneExpansionAllPrompt(
        inputData, [{ pageNumber: 12, planLine: P12_PLAN_LINE.replace(/^PLAN:\s*/, '') }], {})),
      'AD per-page': String(PB.buildSceneExpansionPrompt(
        12, 'page text', ROSTER, 'de-ch', VISUAL_BIBLE, '', null, {})),
      'iterate strict': String(PB.buildSceneDescriptionPrompt(
        12, 'page text', ROSTER, P12_BRIEF_PROSE, 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P12_PLAN_LINE },
        { fixIssues: ['object not in the position the text gives it'], previousScore: 0 },
        { freeIterate: false })),
      'iterate free': String(PB.buildSceneDescriptionPrompt(
        12, 'page text', ROSTER, P12_BRIEF_PROSE, 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P12_PLAN_LINE },
        { fixIssues: ['object not in the position the text gives it'], previousScore: 0 },
        { freeIterate: true })),
    };
  });

  it('reaches all four brief-authoring prompts, exactly once each', () => {
    for (const [site, prompt] of Object.entries(p12)) {
      expect(occurrences(prompt, PB.REACHABLE_CONTACT_RULE), `${site} does not carry the contract exactly once`).toBe(1);
    }
  });

  it('leaves no placeholder unfilled at any of the four sites', () => {
    for (const [site, prompt] of Object.entries(p12)) {
      expect(unfilled(prompt), `${site} shipped an unfilled placeholder`).toEqual([]);
    }
  });

  it("carries the page's stored brief into both rewriters, so a repair round starts from it", () => {
    for (const site of ['iterate strict', 'iterate free']) {
      expect(p12[site].includes(P12_BRIEF_PROSE), `${site} never got the stored brief`).toBe(true);
    }
  });

  it('every template sources the contract from the placeholder — no second, drifting copy', () => {
    for (const key of ['sceneExpansion', 'sceneExpansionAll', 'sceneIteration', 'sceneIterationFree']) {
      const tpl = String(PROMPT_TEMPLATES[key] || '');
      expect(tpl.length, `${key} did not load`).toBeGreaterThan(0);
      expect(occurrences(tpl, '{REACHABLE_CONTACT}'), `${key} does not hold the placeholder exactly once`).toBe(1);
      expect(occurrences(tpl, PB.REACHABLE_CONTACT_RULE), `${key} hardcodes a copy of the contract`).toBe(0);
    }
  });
});

// ── 9. A non-hand contact leaves the hands out of the rows ──────────────────

/**
 * p4, SECOND HALF (2026-09-17). The verb contract fixed the phrasing and the
 * hands stayed on the object. The repair round that rewrote this brief decided
 * in its own `draftValidation` that an ear press "requires hands free or
 * grounded" and answered that by declaring TWO supportive interactions for the
 * same character — a hand on the ground for balance, a hand bracing on a root —
 * while the prose said nothing at all about the hands. buildExactPosesBlock
 * re-anchors one pose line per row, so the protected tail told the painter about
 * that character's hands twice and about the ear once, and every render of a
 * brief shaped that way put a hand on the object (6 of 6 across the shipped
 * versions and the Lab arms; 7 of 12 clean once the rows went and the prose put
 * the hands off the object).
 *
 * Pinned here: ARRIVAL and STRUCTURE — that the contract reaches all four sites
 * that author or rewrite this page from the one constant, and that a supportive
 * hand row is exactly what the tail amplifies. The rule's wording is not
 * asserted anywhere.
 */
const P4_PLAN_LINE =
  'PLAN: medium — Levin — Levin presses his ear against the egg in the hollow, eyes wide — a knock from inside the egg has been heard';

/** The rewritten p4 brief's prose paragraph, verbatim — note it never says where the hands are. */
const P4_BRIEF_PROSE =
  'Levin, a preschooler, kneels on the dirt beside the thick linden root on the Lindenhof, his body angled slightly left, head turned side-on and lowered into the hollow, left cheek up toward the sky, right ear pressed flat against the smooth, glowing pale orange shell of the dragon egg. His green eyes are wide open, staring straight ahead at the dark dirt wall of the hollow. Medium shot at ground level.';

/** The three interactions that brief declared for one character, verbatim. */
const P4_INTERACTIONS = [
  {
    character: 'Levin', object: 'ART001',
    where: 'turns his head side-on, left cheek up toward the sky, and presses his right ear flat against the shell of the dragon egg',
    action: 'listening', hands: false, storyRelevant: true, priority: 'essential',
  },
  {
    character: 'Levin', object: 'ground',
    where: 'rests his left hand on the dirt for balance',
    action: 'balancing', hands: true, storyRelevant: false, priority: 'supportive',
  },
  {
    character: 'Levin', object: 'the linden root',
    where: 'braces his right hand on the linden root beside the hollow',
    action: 'bracing', hands: true, storyRelevant: false, priority: 'supportive',
  },
];

describe('the non-hand contact contract reaches every site that writes or rewrites this page', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the all-pages Art Director carries it when authoring p4 from its real plan line', () => {
    const prompt = String(PB.buildSceneExpansionAllPrompt(
      inputData, [{ pageNumber: 4, planLine: P4_PLAN_LINE.replace(/^PLAN:\s*/, '') }], {}));
    expect(prompt.includes(PB.CONTACT_VERB_RULE), 'the Art Director never got the contact contract').toBe(true);
    expect(unfilled(prompt), 'the Art Director prompt shipped an unfilled placeholder').toEqual([]);
  });

  it('the per-page Art Director carries it too', () => {
    const prompt = String(PB.buildSceneExpansionPrompt(
      4, 'page text', ROSTER, 'de-ch', VISUAL_BIBLE, '', null, {}));
    expect(prompt.includes(PB.CONTACT_VERB_RULE), 'the per-page Art Director never got the contact contract').toBe(true);
    expect(unfilled(prompt), 'the per-page prompt shipped an unfilled placeholder').toEqual([]);
  });

  it.each([['strict', false], ['free', true]])(
    'a %s rewrite of p4 — the real stored brief as its starting point — carries it too',
    (_label, freeIterate) => {
      const prompt = String(PB.buildSceneDescriptionPrompt(
        4, 'page text', ROSTER, P4_BRIEF_PROSE, 'de-ch', VISUAL_BIBLE, [], 'standard', '', '',
        { planLine: P4_PLAN_LINE },
        { fixIssues: ['a hand on the object, no ear contact'], previousScore: -100 },
        { freeIterate }));
      expect(prompt.includes(P4_BRIEF_PROSE), 'the stored brief never reached the rewriter').toBe(true);
      expect(prompt.includes(PB.CONTACT_VERB_RULE), 'one repair round would delete the contact contract').toBe(true);
      expect(unfilled(prompt), 'the rewrite prompt shipped an unfilled placeholder').toEqual([]);
    });

  it('a supportive hand row becomes another pose line about that hand, beside the contact', () => {
    const block = String(PB.buildExactPosesBlock(P4_INTERACTIONS, [], VISUAL_BIBLE, { language: 'de-ch' }));
    const poseLines = block.split('\n').filter(l => l.startsWith('- Levin:'));
    expect(poseLines.length, 'the supportive rows did not each become a pose line').toBe(3);
    expect(poseLines.filter(l => /\bhand\b/.test(l)).length,
      'the tail did not carry a hand instruction per supportive row').toBe(2);
  });

  it('the same contact with the supportive rows gone leaves one pose line, about the ear', () => {
    const block = String(PB.buildExactPosesBlock([P4_INTERACTIONS[0]], [], VISUAL_BIBLE, { language: 'de-ch' }));
    const poseLines = block.split('\n').filter(l => l.startsWith('- Levin:'));
    expect(poseLines.length).toBe(1);
    expect(poseLines[0], 'the one pose line lost the declared contact').toContain('presses his right ear flat');
    expect(/\bhand\b/.test(poseLines[0]), 'a hand reached the only pose line').toBe(false);
  });
});

// ── 10. A face reaches the painter only through `expression` ────────────────

/**
 * The EXPRESSIONS AND EYES block of the protected tail is built from
 * `characters[].expression` and `looksAt` and from nothing else — no field, no
 * block. On p4 (2026-09-17) every arm whose character object carried no
 * `expression` came back with a mild smile aimed at the camera on a page whose
 * beat is a child listening: 0 of 8. The 5 arms that carried one were obeyed.
 * The field was contracted at only two of the four sites that author a brief,
 * so a rewrite through either of the other two deletes the block for the rest of
 * that page's life.
 *
 * Pinned here: STRUCTURE — the block exists exactly when the field does, and it
 * sits in the protected tail. No eye state is asserted: "eyes closed" was
 * obeyed and rejected (it reads as asleep), so the contract is that the face is
 * stated, never what it states.
 */
describe('the face block exists exactly when the brief declares a face', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const briefWith = (charExtra: Record<string, unknown>) => `Levin has laid his head sideways onto the egg. Both hands in his lap, off it.

---METADATA---
${JSON.stringify({
    sceneIntent: 'Levin lays his head on the egg.',
    characters: [{ name: 'Levin', clothing: 'standard', position: 'beside the root', depth: 'foreground', ...charExtra }],
    shot: 'medium',
    objects: ['ART001'],
    interactions: [{
      character: 'Levin', object: 'ART001',
      where: 'presses his ear flat to the egg; both hands in his lap, off it',
      action: 'listening', hands: false, storyRelevant: true, priority: 'essential',
    }],
  })}`;

  it('a character with no expression and no gaze gets no face block at all', () => {
    const prompt = String(PB.buildImagePrompt(briefWith({}), inputData, [ROSTER[0]], VISUAL_BIBLE, 4, null, {}));
    expect(prompt).not.toContain('EXPRESSIONS AND EYES');
  });

  it('the declared face rides the protected tail, verbatim, beside the pose', () => {
    const prompt = String(PB.buildImagePrompt(
      briefWith({ expression: 'eyes wide open, neutral mouth, focused', looksAt: 'the earth beside him' }),
      inputData, [ROSTER[0]], VISUAL_BIBLE, 4, null, {}));
    const tail = protectedTail(prompt);
    expect(tail, 'the prompt has no protected tail').not.toBe('');
    expect(tail, 'the face block left the protected tail').toContain('EXPRESSIONS AND EYES');
    const faceLine = tail.split('\n').find(l => l.includes('eyes wide open')) || '';
    expect(faceLine, 'the declared expression never reached the tail').not.toBe('');
    expect(faceLine, 'the declared gaze never reached the tail').toContain('the earth beside him');
  });

  it('a gaze alone still builds the block — the two fields share one line', () => {
    const prompt = String(PB.buildImagePrompt(
      briefWith({ looksAt: 'the earth beside him' }), inputData, [ROSTER[0]], VISUAL_BIBLE, 4, null, {}));
    expect(prompt).toContain('EXPRESSIONS AND EYES');
  });
});
