import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { easterSunday, nthSunday, isInSeason, SEASON_WINDOWS } from '../../client/src/constants/seasons';
import { getStoryTypesByGroup, getStoryTypeById, storyTypes } from '../../client/src/constants/storyTypes';

/**
 * Owner 2026-10-09: "Geschichte zum Vater- or Muttertag must be removed. They must show only around that time of year. Now you can
 * show Halloween. Ensure this changes automatically." Swiss dates by owner decision, every language.
 */
const ymd = (n: number) => new Date(n).toISOString().slice(0, 10);
const at = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
const offered = (s: string) => new Set([...getStoryTypesByGroup('seasonal', at(s)), ...getStoryTypesByGroup('popular', at(s))].filter(t => t.group === 'seasonal').map(t => t.id));

describe('date helpers', () => {
  it('easterSunday matches the known dates 2026-2030', () => {
    expect([2026, 2027, 2028, 2029, 2030].map(y => ymd(easterSunday(y)))).toEqual(['2026-04-05', '2027-03-28', '2028-04-16', '2029-04-01', '2030-04-21']);
  });
  it('nthSunday: 2nd Sunday of May and 1st Sunday of June', () => {
    expect([2026, 2027, 2028].map(y => ymd(nthSunday(y, 5, 2)))).toEqual(['2026-05-10', '2027-05-09', '2028-05-14']);
    expect([2026, 2027, 2028].map(y => ymd(nthSunday(y, 6, 1)))).toEqual(['2026-06-07', '2027-06-06', '2028-06-04']);
  });
});

describe('who is offered when', () => {
  it('2026-10-09: Halloween shown, Mother\'s Day and Father\'s Day hidden', () => {
    const o = offered('2026-10-09');
    expect(o.has('halloween')).toBe(true);
    expect(o.has('mothers-day')).toBe(false);
    expect(o.has('fathers-day')).toBe(false);
    expect(o.has('easter')).toBe(false);
  });
  const cases: Array<[string, string, boolean]> = [
    ['halloween', '2026-09-30', false], ['halloween', '2026-10-01', true], ['halloween', '2026-10-31', true], ['halloween', '2026-11-01', false],
    ['christmas', '2026-10-31', false], ['christmas', '2026-11-01', true], ['christmas', '2026-12-26', true], ['christmas', '2026-12-27', false],
    ['samichlaus', '2026-11-05', false], ['samichlaus', '2026-11-06', true], ['samichlaus', '2026-12-06', true], ['samichlaus', '2026-12-07', false],
    ['newyear', '2026-12-14', false], ['newyear', '2026-12-15', true], ['newyear', '2027-01-06', true], ['newyear', '2027-01-07', false], ['newyear', '2026-01-03', true],
    // Easter 2026-04-05: from 2026-03-01 (35 days before) to Easter Monday 2026-04-06
    ['easter', '2026-02-28', false], ['easter', '2026-03-01', true], ['easter', '2026-04-06', true], ['easter', '2026-04-07', false],
    // 2027: Easter 03-28 -> 2027-02-21 .. 2027-03-29
    ['easter', '2027-02-20', false], ['easter', '2027-02-21', true], ['easter', '2027-03-29', true], ['easter', '2027-03-30', false],
    // Mother's Day 2026-05-10: 4 weeks before = 2026-04-12
    ['mothers-day', '2026-04-11', false], ['mothers-day', '2026-04-12', true], ['mothers-day', '2026-05-10', true], ['mothers-day', '2026-05-11', false],
    // Father's Day 2026-06-07: 4 weeks before = 2026-05-10
    ['fathers-day', '2026-05-09', false], ['fathers-day', '2026-05-10', true], ['fathers-day', '2026-06-07', true], ['fathers-day', '2026-06-08', false],
  ];
  it.each(cases)('%s on %s -> offered %s', (id, date, expected) => {
    expect(offered(date).has(id)).toBe(expected);
  });
  it('a topic with no window is always offered', () => {
    expect(isInSeason(undefined, at('2026-07-01'))).toBe(true);
    expect(getStoryTypesByGroup('historical', at('2026-07-01')).length).toBeGreaterThan(0);
  });
  it('landing pages (offeredAt = null) list every seasonal topic', () => {
    expect(getStoryTypesByGroup('seasonal', null).map(t => t.id).sort()).toEqual(Object.keys(SEASON_WINDOWS).sort());
  });
  it('gating never hides a stored topic: it still resolves by id', () => {
    for (const id of Object.keys(SEASON_WINDOWS)) expect(getStoryTypeById(id)?.id).toBe(id);
  });
  it('every seasonal topic has a window', () => {
    for (const t of storyTypes.filter(t => t.group === 'seasonal')) expect(t.season, t.id).toBeDefined();
  });
});

describe('samichlaus is registered everywhere a seasonal topic is', () => {
  const root = path.resolve(__dirname, '../..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
  const themes = require('../../server/config/storyThemes.js');
  it('client topic list, theme kind table, SEO names, guide, trial titles', () => {
    expect(getStoryTypeById('samichlaus')?.name.de).toBe('Samichlaus-Geschichte');
    expect(themes.themeKind('samichlaus')).toBe('occasion');
    expect(read('server/lib/seoMeta.js')).toMatch(/samichlaus:/);
    expect(read('prompts/adventure-guides.txt')).toMatch(/^\[samichlaus\]$/m);
    expect(read('server/config/trialTitles.js')).toMatch(/samichlaus:/);
  });
  it('window is 6 Nov - 6 Dec (one month ahead, owner 2026-10-09)', () => {
    const w = SEASON_WINDOWS.samichlaus.occurrence(2026);
    expect([ymd(w.from), ymd(w.to)]).toEqual(['2026-11-06', '2026-12-06']);
  });
});
