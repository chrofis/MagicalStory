import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
import shotVocabulary from '../../server/lib/shotVocabulary.js';
// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
// @ts-ignore — CommonJS lib
import sceneBriefCheck from '../../server/lib/sceneBriefCheck.js';

const { closeUpBelowWaistVerbs, CLOSEUP_BELOW_WAIST_PHRASE } = shotVocabulary as any;
const { runPlanCounters, nameCandidates } = planCounters as any;
const { checkPage, REVIEWABLE } = sceneBriefCheck as any;

/**
 * A close-up frame ends at the waist. Two stages can lose that: the PLANNER,
 * by writing a below-waist pose into a page it also marked `close-up`
 * (SHOT_CLOSEUP_BELOW_WAIST), and the ART DIRECTOR, by widening a buildable
 * close-up on staging it invented (`shot_widened`).
 *
 * Every plan line below is VERBATIM from a stored staging book — the two faults
 * were measured before they were coded, and these are the pages that measured.
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
  it('names the verb a character is staged in', () => {
    expect(closeUpBelowWaistVerbs('Levin sits down alone in the dark leaves, head bowed')).toEqual(['sitting']);
    expect(closeUpBelowWaistVerbs('Julian steps back, hands behind him')).toEqual(['stepping']);
    expect(closeUpBelowWaistVerbs('Kiaan crouches with one hand cupped toward the glow')).toEqual(['crouching']);
    expect(closeUpBelowWaistVerbs('Levin kneeling at the plugged hole, one hand pressed flat')).toEqual(['kneeling']);
  });

  it('does not read an object resting somewhere as a pose', () => {
    // Both measured false positives of the bare verb list, verbatim from
    // stored plans. The subject guard is the only thing that separates them.
    expect(closeUpBelowWaistVerbs('the small dragon sits on Julian’s bare neck and sneezes')).toEqual([]);
    expect(closeUpBelowWaistVerbs('a wooden wedge in beside the hook where it sits in the ring')).toEqual([]);
  });

  it('catches the frame floor the rule names, whose subject is its own possessive', () => {
    // Three stored close-up plan lines put the ground in frame this way and no
    // verb could see them.
    expect(closeUpBelowWaistVerbs('red leaves scattered around her feet')).toEqual(['feet-on-ground contact']);
    expect(closeUpBelowWaistVerbs('the dark bilge visible below the grating at her feet')).toEqual(['feet-on-ground contact']);
  });

  it('stays silent on a waist-up beat', () => {
    expect(closeUpBelowWaistVerbs('the cracked shell in Julian’s arms, the small dragon pressing into his jacket')).toEqual([]);
  });
});

describe('SHOT_CLOSEUP_BELOW_WAIST', () => {
  const page = (n: number, planLine: string) => ({ pageNumber: n, planLine, beat: '' });

  it('flags a close-up page whose plan line stages a below-waist action', () => {
    const p = [page(13, 'close-up — Levin — Levin sits down alone in the dark leaves, head bowed, the silent egg resting on the ground before him — the low point')];
    expect(codes(p)).toContain('SHOT_CLOSEUP_BELOW_WAIST');
    expect(finding(p, 'SHOT_CLOSEUP_BELOW_WAIST').pages).toEqual([13]);
  });

  it('reads the pose wherever the planner put it, not only in the instant column', () => {
    // A three-segment line: the pose rides in the who column. Probing the
    // instant alone missed this page on the stored corpus.
    const p = [page(14, 'close-up — Levin sitting on the cold stone lane, hands on his knees — the shell grey and hard before him — the low point')];
    expect(codes(p)).toContain('SHOT_CLOSEUP_BELOW_WAIST');
  });

  it('leaves a waist-up close-up and a below-waist WIDE page alone', () => {
    expect(codes([page(17, 'close-up — Julian — the cracked shell in Julian’s arms, the small dragon pressing into his jacket — it has hatched')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
    expect(codes([page(6, 'wide — Levin, Julian — Levin kneels in a ring around the hollow between the roots — the egg is safe')]))
      .not.toContain('SHOT_CLOSEUP_BELOW_WAIST');
  });

  it('is advisory: the planner may answer it by restaging OR by widening', () => {
    const detail = finding(
      [page(2, 'close-up — Levin, Julian — Levin lifts the egg while Julian steps back, hands behind him — the egg exists')],
      'SHOT_CLOSEUP_BELOW_WAIST',
    ).detail;
    expect(detail).toMatch(/restage/i);
    expect(detail).toMatch(/wider shot/i);
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
    const planLine = 'close-up — Levin — Levin sits down alone in the dark leaves — the low point';
    expect(types({ pageNumber: 13, brief: brief('medium'), planLine })).not.toContain('shot_widened');
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
  ];

  it.each(templates)('%s states the verbs from the shared placeholder', (rel) => {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(text).toContain('{CLOSEUP_BELOW_WAIST}');
    // No hand-kept copy left behind to drift from it.
    expect(text).not.toMatch(/kneeling, crouching, sitting, stepping/);
  });

  it('the phrase names every verb the counter looks for', () => {
    for (const verb of ['kneeling', 'crouching', 'sitting', 'stepping', 'feet-on-ground contact']) {
      expect(CLOSEUP_BELOW_WAIST_PHRASE).toContain(verb);
    }
  });
});
