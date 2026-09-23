/**
 * The page-plan fixes from the 2026-09-23 prompt audit of staging
 * job_1790100385959_1nitlympp (docs/audits/prompt-audit-2026-09-23/02-page-plan.md).
 *
 * Pins behaviour, never wording:
 *  W2  the plan check reads the hints and asks where each landed (page order);
 *  W3  a noted finding cannot take the last page's event; the one-level rule
 *      keeps the level the page's event happens on (planner and checker alike);
 *  W5  the re-plan is told which pages stay, and the review refuses a change
 *      that takes a character's last focal page or answers a noted finding on a
 *      kept page; the previous round's refusals reach the next round;
 *  W6  a character named only in the instant is counted (roster `unlisted`);
 *  W8  the acts are sentence thirds, stated identically to planner and checker;
 *  bloat: the divider gets only the landmarks the arc uses;
 *  storage: raw replies and the recheck prompt are kept.
 * Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');
const { shippedReplanState } = require('../../server/lib/beatsPipeline.js');
const { loadPromptTemplates } = require('../../server/services/prompts');

const ARC = Array.from({ length: 18 }, (_, i) => `${i + 1}. Something happens in sentence ${i + 1}.`).join('\n');
const inputData: any = {
  title: 'T', characters: ['Ana', 'Ben', 'Cara', 'Dev'].map((name, i) => ({ id: `c${i}`, name, age: 5, gender: 'female' })),
  mainCharacters: ['c0'], language: 'en', languageLevel: '1st-grade', pages: 18,
  storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
};
const BEATS = Array.from({ length: 18 }, (_, i) => ({ pageNumber: i + 1, planLine: `medium — Ana — she acts ${i + 1} — a change ${i + 1}` }));

describe('the plan check and the planner', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('W2: the checker reads the hints the planner applied, and asks about page order', () => {
    const hints = 'CHANGE: a hint for the division';
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '', { arcHints: hints });
    expect(check).toContain(hints);
    expect(PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '')).not.toContain(hints);
    expect(check).toMatch(/^13\. /m);
  });

  it('W8: both sides state the same act spans, by sentence number', () => {
    const spans = PB.arcActSpans(ARC);
    expect(spans).toContain('setup 1–6');
    expect(spans).toContain('ending 13–18');
    expect(PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '')).toContain(spans);
    expect(PB.buildBeatsPrompt(inputData, 18, { finalArc: ARC })).toContain(spans);
    expect(PB.arcActSpans('no numbered sentences')).toBe('');
  });

  it('the checker and the planner carry the same own-action sentence; the page counts stay with the planner and the counters', () => {
    const { castCoverage, castCoverageRule, castActionRule } = require('../../server/lib/castCoverage');
    const cov = castCoverage({ pageCount: 18, castCount: 4 });
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '');
    expect(check).toContain(castActionRule(cov));
    expect(PB.buildBeatsPrompt(inputData, 18, { finalArc: ARC })).toContain(castCoverageRule(cov));
    expect(check).not.toContain(`at least ${cov.appearances.min} pages`);
  });

  it('Q12 (each character\'s own action) is must-fix; an unlisted-figure finding is must-fix but buys no picture', () => {
    expect(PB.replanRank({ kind: 'check', check: 12 })).toBe('must');
    expect(PB.replanRank({ kind: 'counter', code: 'CAST_NOT_IN_WHO_COLUMN' })).toBe('must');
    expect(PB.countsTowardConvergence({ kind: 'counter', code: 'CAST_NOT_IN_WHO_COLUMN' })).toBe(false);
    expect(PB.replanRank({ kind: 'check', check: 13 })).toBe('also');
  });

  it('the WANTED and ACTION lines are read as data', () => {
    const reply = 'WANTED ending: sentence 18 — page 18\nACTION Ben: sentence 5 — page none\nACTION **Cara**: sentence 9 — page 10';
    expect(PB.parsePlanCheckWanted(reply)).toEqual([{ key: 'ending', sentence: 18, page: 18 }]);
    expect(PB.parsePlanCheckActions(reply)).toEqual([
      { key: 'Ben', sentence: 5, page: null },
      { key: 'Cara', sentence: 9, page: 10 },
    ]);
  });

  it('bloat: a divider gets only the landmarks the arc names, without the author block', () => {
    const lms = [
      { name: 'Old Square (Town)', type: 'Square', wikipediaExtract: 'A long description.', photoVariants: [{ kind: 'medium', description: 'the square' }] },
      { name: 'Far Tower', type: 'Tower', wikipediaExtract: 'Another.' },
    ];
    const prompt = PB.buildBeatsPrompt({ ...inputData, availableLandmarks: lms }, 18, { finalArc: '1. They cross the Old Square.\n2. b\n3. c' });
    expect(prompt).toContain('Old Square (Town)');
    expect(prompt).not.toContain('Far Tower');
    expect(prompt).not.toContain('A long description.');
    expect(prompt).not.toMatch(/build at least two of them in/);
  });
});

describe('W6: the who column is the complete cast', () => {
  it('a character named only in the instant is counted', () => {
    const reply = [
      'ROSTER 1: people = Ana; things = none; covers = none; unlisted = Ben',
      'ROSTER 2: people = Ana, Ben; things = none; covers = none; unlisted = none',
    ].join('\n');
    const roster = PB.parsePlanCheckRoster(reply);
    expect(roster.get(1).unlisted).toEqual(['Ben']);
    const pages = [
      { pageNumber: 1, planLine: "medium — Ana — a spark lands on Ben's sleeve — the egg hatched" },
      { pageNumber: 2, planLine: 'wide — Ana, Ben — they run — they are home' },
    ];
    const r = PC.runPlanCounters({ pages, roster, commissionedNames: ['Ana', 'Ben'] });
    const f = r.findings.find((x: any) => x.code === 'CAST_NOT_IN_WHO_COLUMN');
    expect(f && f.pages).toEqual([1]);
  });

  it('a claimed name the instant does not contain is dropped (re-counted, never trusted)', () => {
    const roster = PB.parsePlanCheckRoster('ROSTER 1: people = none; things = egg; covers = none; unlisted = Ana, Ben');
    const pages = [{ pageNumber: 1, planLine: 'low-angle — the egg — the egg sits in the roots, steam rising — the egg is warm' }];
    const r = PC.runPlanCounters({ pages, roster, commissionedNames: ['Ana', 'Ben'] });
    expect(r.findings.map((x: any) => x.code)).not.toContain('CAST_NOT_IN_WHO_COLUMN');
  });
});

describe('W3/W5: what a re-plan may not take', () => {
  const standing = [
    { pageNumber: 5, planLine: 'close-up — Ben — he holds the scale — the scale is his' },
    { pageNumber: 6, planLine: 'medium — Ben, Cara — they lift it — it is up' },
    { pageNumber: 18, planLine: 'wide — Dev, Ana — the creature flies off with the hatchling — the goodbye is done' },
  ];
  const names = ['Ana', 'Ben', 'Cara', 'Dev'];

  it('a noted finding cannot take the last page (the ending\'s event)', () => {
    const returned = standing.map(p => (p.pageNumber === 18 ? { ...p, planLine: 'wide — Ana — she speaks — the day ends' } : p));
    const changes = PB.parsePlanChanges('---CHANGES---\nPage 18: cast out Dev — CHECK[10] — two heights\nChanges: 1').changes;
    const keep = PB.replanKeepPages({ pageCount: 18 });
    const r = PC.reviewPlanChanges({ changes, standing, returned, castNames: names, protectedPages: new Map(keep.map((k: any) => [k.page, k.why])), rankOf: PB.replanRank });
    expect(r.refusals.map((x: any) => x.rule)).toEqual(['protected']);
  });

  it('a must-fix answer may not take another character\'s last focal page', () => {
    const returned = standing.map(p => (p.pageNumber === 5 ? { ...p, planLine: 'close-up — Cara — she holds the scale — the scale is hers' } : p));
    const changes = PB.parsePlanChanges('---CHANGES---\nPage 5: cast out Ben — PLAN[NO_FOCAL_PAGE] — Cara needs one\nChanges: 1').changes;
    const r = PC.reviewPlanChanges({ changes, standing, returned: returned.map(p => (p.pageNumber === 6 ? { ...p, planLine: 'medium — Ben, Cara, Ana — they lift it — it is up' } : p)), castNames: names, focalNames: names, rankOf: PB.replanRank });
    expect(r.refusals.map((x: any) => x.rule)).toContain('focal');
  });

  it('a cast out from a character\'s ACTION page is refused', () => {
    const returned = standing.map(p => (p.pageNumber === 6 ? { ...p, planLine: 'medium — Cara — she lifts it — it is up' } : p));
    const changes = PB.parsePlanChanges('---CHANGES---\nPage 6: cast out Ben — PLAN[CAST_OVER_CEILING] — too many\nChanges: 1').changes;
    const r = PC.reviewPlanChanges({ changes, standing, returned, castNames: names, actions: [{ key: 'Ben', page: 6 }], rankOf: PB.replanRank });
    expect(r.refusals.map((x: any) => x.rule)).toEqual(['action']);
  });

  it('the RE-DIVIDE block names the kept pages, the noted-finding limit and last round\'s refusals', () => {
    const keep = PB.replanKeepPages({ pageCount: 18, wanted: [{ key: 'middle', page: 9 }], actions: [{ key: 'Ben', page: 6 }], focalPages: { Ben: [5], Ana: [1, 2] } });
    const pages = keep.map((k: any) => k.page).sort((a: number, b: number) => a - b);
    expect(pages).toEqual([5, 6, 9, 18]);
    // "page none" keeps nothing (Number(null) is 0).
    expect(PB.replanKeepPages({ pageCount: 18, wanted: [{ key: 'ending', page: null }] }).map((k: any) => k.page)).toEqual([18]);
    const section = PB.buildReplanSection('Page 1: medium — Ana — x — y', [{ kind: 'check', check: 10, line: 'CHECK[10]: page 18' }], {
      pageCount: 18, keep,
      refused: [{ pageNumber: 13, rule: 'direction', detail: 'there was room to add', line: 'Page 13: cast out Dev — PLAN[NO_COMMISSIONED_ON_PAGE] — x' }],
    });
    for (const n of [5, 6, 9, 18]) expect(section).toContain(`page ${n} (`);
    expect(section).toContain('Page 13: cast out Dev');
    expect(section).toMatch(/noted finding/);
  });
});

describe('storage: the stage keeps what the models were sent and what they wrote', () => {
  const src = readFileSync(join(__dirname, '../..', 'server', 'lib', 'beatsPipeline.js'), 'utf-8')
    .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));

  it('the planner reply, every re-plan reply, and the recheck prompt are stored', () => {
    expect(src).toContain('plannerReply,');
    expect(src).toContain('replanReplies: shipped.replanReplies');
    for (const m of src.matchAll(/replanRounds\.push\(\{ round,[^)]*\)/g)) expect(m[0]).toContain('replanReply');
    const rec = src.slice(src.indexOf('const recheckRecord'), src.indexOf('} : null);', src.indexOf('const recheckRecord')));
    expect(rec).toContain("prompt: c.prompt || ''");
  });

  it('shippedReplanState carries each kept round\'s reply and each discarded round\'s', () => {
    const s = shippedReplanState([
      { round: 1, kept: true, changedPages: [1], replanPrompt: 'P1', replanReply: 'R1' },
      { round: 2, kept: false, discardReason: 'x', replanPrompt: 'P2', replanReply: 'R2' },
    ]);
    expect(s.replanReplies).toEqual([{ round: 1, reply: 'R1' }]);
    expect(s.discardedRounds[0].replanReply).toBe('R2');
  });
});
