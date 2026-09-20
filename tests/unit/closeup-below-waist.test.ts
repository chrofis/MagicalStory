import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
import shotVocabulary from '../../server/lib/shotVocabulary.js';
// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
// @ts-ignore — CommonJS lib
import sceneBriefCheck from '../../server/lib/sceneBriefCheck.js';

const { closeUpBelowWaistVerbs, CLOSEUP_BELOW_WAIST_PHRASE, CLOSEUP_BELOW_WAIST_VERBS } = shotVocabulary as any;
const { runPlanCounters, nameCandidates } = planCounters as any;
const { checkPage, REVIEWABLE } = sceneBriefCheck as any;

/**
 * A close-up frame ends at the waist. Two stages can lose that: the PLANNER,
 * by making something below the frame line the SUBJECT of a page it also marked
 * `close-up` (SHOT_CLOSEUP_BELOW_WAIST), and the ART DIRECTOR, by widening a
 * buildable close-up on staging it invented (`shot_widened`).
 *
 * REVERSED 2026-09-20 (owner: "A child can sit in a close up that is fine").
 * The rule used to forbid kneeling, crouching, sitting and stepping as well,
 * and that conflated a POSE with what the FRAME shows: a close-up crops the
 * legs away, which is what a close-up IS, and a crouch or a kneel brings the
 * head DOWN to the thing it is looking at. The pose cases below therefore now
 * assert SILENCE, with the line that used to flag them kept verbatim so the
 * reversal is legible rather than deleted. What still flags is an action whose
 * visible subject lies below the frame line.
 *
 * Every plan line below is VERBATIM from a stored staging book — the faults
 * were measured before they were coded, and these are the pages that measured.
 * Re-measured over the same 24 books / 73 planned close-ups: 13 plan lines
 * flagged under the old list, 8 under this one.
 */

const rosterFor = (pages: any[]) => {
  const map = new Map<number, { people: string[]; things: string[] }>();
  for (const p of pages) map.set(Number(p.pageNumber), { people: nameCandidates(String(p.planLine || '')), things: [] });
  return map;
};

const codes = (pages: any[]) =>
  runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: ['Levin', 'Julian', 'Kiaan', 'Emma'] })
    .findings.map((f: any) => f.code);

const finding = (pages: any[], code: string) =>
  runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: ['Levin', 'Julian', 'Kiaan', 'Emma'] })
    .findings.find((f: any) => f.code === code);

describe('closeUpBelowWaistVerbs', () => {
  const GROUND = 'something lying on the ground or floor';
  const FEET = "the ground at the character's feet";
  const FOOT = 'a foot placed on a step or surface';

  it('names the below-frame subject the page asks the picture to show', () => {
    // All four verbatim from stored close-up plan lines.
    expect(closeUpBelowWaistVerbs('the silent egg resting on the ground before him')).toEqual([GROUND]);
    expect(closeUpBelowWaistVerbs('Levin kneeling at the plugged hole, one hand pressed flat on the cold ground')).toEqual([GROUND]);
    expect(closeUpBelowWaistVerbs('the dark bilge visible below the grating at her feet')).toEqual([FEET]);
    expect(closeUpBelowWaistVerbs('she holds her lit lantern up, one foot already on the wall stones')).toEqual([FOOT]);
  });

  it('A POSE THE FRAME CROPS IS NOT A FAULT (reversed 2026-09-20)', () => {
    // These four lines each raised a finding until the owner's reversal. They
    // are kept verbatim as the pins of the new rule: the legs fall below the
    // bottom edge, which is what a close-up is, and in a crouch the head comes
    // down to what it is looking at.
    expect(closeUpBelowWaistVerbs('Levin sits down alone in the dark leaves, head bowed')).toEqual([]);
    expect(closeUpBelowWaistVerbs('Julian steps back, hands behind him')).toEqual([]);
    expect(closeUpBelowWaistVerbs('Kiaan crouches with one hand cupped toward the glow')).toEqual([]);
    expect(closeUpBelowWaistVerbs('Levin kneeling at the plugged hole, face close to the crack')).toEqual([]);
  });

  it('does not read an object resting somewhere as a pose', () => {
    // Both measured false positives of the bare verb list, verbatim from
    // stored plans. They are silent twice over now: the pose verbs are gone.
    expect(closeUpBelowWaistVerbs('the small dragon sits on Julian’s bare neck and sneezes')).toEqual([]);
    expect(closeUpBelowWaistVerbs('a wooden wedge in beside the hook where it sits in the ring')).toEqual([]);
  });

  it('catches the frame floor the rule names, whose subject is its own possessive', () => {
    expect(closeUpBelowWaistVerbs('red leaves scattered around her feet')).toEqual([FEET]);
    expect(closeUpBelowWaistVerbs('the dragon-picture-book visible in his open bag at his feet')).toEqual([FEET]);
  });

  it('stays silent on a waist-up beat', () => {
    expect(closeUpBelowWaistVerbs('the cracked shell in Julian’s arms, the small dragon pressing into his jacket')).toEqual([]);
  });
});

describe('SHOT_CLOSEUP_BELOW_WAIST', () => {
  const page = (n: number, planLine: string) => ({ pageNumber: n, planLine, beat: '' });

  it('flags a close-up page whose plan line puts the ground in frame', () => {
    const p = [page(13, 'close-up — Levin — Levin sits down alone in the dark leaves, head bowed, the silent egg resting on the ground before him — the low point')];
    expect(codes(p)).toContain('SHOT_CLOSEUP_BELOW_WAIST');
    expect(finding(p, 'SHOT_CLOSEUP_BELOW_WAIST').pages).toEqual([13]);
    // The egg on the ground is the fault, never the sitting.
    expect(finding(p, 'SHOT_CLOSEUP_BELOW_WAIST').detail).toContain('on the ground or floor');
  });

  it('reads the staging wherever the planner put it, not only in the instant column', () => {
    // A three-segment line: the staging rides in the who column. Probing the
    // instant alone missed this page on the stored corpus.
    const p = [page(4, 'close-up — Kiaan — Kiaan holds both palms flat on the shell and speaks, the dragon-picture-book visible in his open bag at his feet — the stake is named')];
    expect(codes(p)).toContain('SHOT_CLOSEUP_BELOW_WAIST');
  });

  it('LEAVES A SITTING OR STEPPING CLOSE-UP ALONE (reversed 2026-09-20)', () => {
    // Both verbatim stored close-ups that the old rule flagged. The sitting one
    // is a head-and-shoulders low point; the stepping one is a cropped movement.
    expect(codes([page(15, 'close-up — Levin — Levin sitting on the cold summit rock, head dropped, hands on his knees — the promise looks broken')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
    expect(codes([page(2, 'close-up — Levin, Julian — Levin lifts the egg while Julian steps back, hands behind him — the egg exists')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
  });

  it('leaves a waist-up close-up and a below-waist WIDE page alone', () => {
    expect(codes([page(17, 'close-up — Julian — the cracked shell in Julian’s arms, the small dragon pressing into his jacket — it has hatched')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
    expect(codes([page(6, 'wide — Levin, Julian — Levin kneels, one hand pressed flat on the cold ground — the egg is safe')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
  });

  it('is advisory, and says the pose is not what has to change', () => {
    const detail = finding(
      [page(6, 'close-up — Fiona — Fiona holds a tin cup, the dark bilge visible below the grating at her feet — half rations')],
      'SHOT_CLOSEUP_BELOW_WAIST',
    ).detail;
    expect(detail).toMatch(/restage/i);
    expect(detail).toMatch(/wider shot/i);
    expect(detail).toMatch(/sitting or kneeling pose is fine/i);
  });
});

describe('shot_widened', () => {
  const brief = (shot: string | null, prose = 'Julian sits facing the camera, his arms wrapped around the shell.') =>
    `${prose}\n---METADATA---\n{"characters":[{"name":"Julian"}]${shot ? `,"shot":"${shot}"` : ''}}`;

  const types = (page: any) => checkPage(page, ['Julian'], null, {}).map((f: any) => f.type);

  const CLEAN_PLAN = 'close-up — Julian — the cracked shell in Julian’s arms, the small dragon pressing into his jacket — it has hatched';

  it('flags a buildable close-up the Art Director widened on staging it invented', () => {
    // job_1789853503332_riqncqg1i page 17, verbatim: a pure holding beat the
    // brief answered with a sitting pose carried over from the page before.
    expect(types({ pageNumber: 17, brief: brief('medium'), planLine: CLEAN_PLAN })).toContain('shot_widened');
  });

  it('stays silent when the PLAN LINE is what needs the wider frame', () => {
    const planLine = 'close-up — Levin — Levin sits down in the dark leaves, the silent egg resting on the ground before him — the low point';
    expect(types({ pageNumber: 13, brief: brief('medium'), planLine })).not.toContain('shot_widened');
  });

  it('GOT MORE LEGITIMATE WITH THE REVERSAL: a sitting plan line no longer excuses a widen', () => {
    // Verbatim stored plan line. Under the old rule `sitting` made this an
    // exempt page and the Art Director's widening went unreported; with poses
    // out of the list the widen is plainly the AD's own, and the finding says
    // so rather than asking.
    const planLine = 'close-up — Levin — Levin sits down alone in the dark leaves, head bowed — the low point';
    const fs_ = checkPage({ pageNumber: 13, brief: brief('medium'), planLine }, ['Julian'], null, {});
    expect(fs_.map((f: any) => f.type)).toContain('shot_widened');
    expect(fs_.find((f: any) => f.type === 'shot_widened').detail)
      .toMatch(/sitting, kneeling or crouching pose does NOT force it/);
  });

  it('stays silent when the close-up was delivered, however the word is hyphenated', () => {
    expect(types({ pageNumber: 17, brief: brief('close-up'), planLine: CLEAN_PLAN })).not.toContain('shot_widened');
    // U+2011 non-breaking hyphen — 3 stored pages write it this way, and a
    // string compare reads them as a widening that never happened.
    expect(types({ pageNumber: 17, brief: brief('close‑up'), planLine: CLEAN_PLAN })).not.toContain('shot_widened');
  });

  it('stays silent when the plan asked for something other than a close-up, or the brief declared no shot', () => {
    expect(types({ pageNumber: 5, brief: brief('wide'), planLine: 'medium — Julian — he holds the shell — it is warm' })).not.toContain('shot_widened');
    expect(types({ pageNumber: 5, brief: brief(null), planLine: CLEAN_PLAN })).not.toContain('shot_widened');
  });

  it('reaches the scene review, which already rewrites briefs', () => {
    expect(REVIEWABLE.has('shot_widened')).toBe(true);
  });
});

describe('the waist-up rule is one constant, not five sentences', () => {
  const root = path.join(__dirname, '..', '..');
  // Every template that AUTHORS or REWRITES a page brief, plus the planner that
  // writes the shot word. They each used to spell the verb list out by hand and
  // the two pairs had already drifted apart.
  const templates = [
    'prompts/story-beats.txt',
    'prompts/scene-expansion.txt',
    'prompts/scene-expansion-all.txt',
    'prompts/scene-iteration.txt',
    'prompts/scene-iteration-free.txt',
    // The CRITIC. Check 7b spelled the list out by hand until 2026-09-20, which
    // is how it went on naming poses after the rule stopped forbidding them.
    'prompts/scene-review.txt',
  ];

  it.each(templates)('%s states the verbs from the shared placeholder', (rel) => {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(text).toContain('{CLOSEUP_BELOW_WAIST}');
    // No hand-kept copy left behind to drift from it.
    expect(text).not.toMatch(/kneeling, crouching, sitting, stepping/);
  });

  it('the phrase names every subject the counter looks for', () => {
    for (const label of CLOSEUP_BELOW_WAIST_VERBS.map((v: any) => v.verb)) {
      expect(CLOSEUP_BELOW_WAIST_PHRASE).toContain(label);
    }
  });

  it('NO SITE STILL FORBIDS A POSE (reversed 2026-09-20)', () => {
    // The generator sites, the critic, and the Art-Director-less paths that get
    // the rule as a JS constant. A pose word surviving anywhere means one stage
    // is still deducting for what another stage now allows.
    const sources = [...templates, 'server/lib/promptBuilders.js', 'server/lib/planCounters.js'];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      // Only the rule sentence matters; comments recording the reversal may
      // name the old verbs, so this pins the exact banned formulation.
      expect(text, rel).not.toMatch(/no kneeling, crouching, sitting/);
      expect(text, rel).not.toMatch(/kneeling, crouching, sitting, stepping, or feet-on-ground/);
    }
  });
});
