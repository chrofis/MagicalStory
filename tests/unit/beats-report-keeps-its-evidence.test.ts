import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../..', 'server', 'lib', 'beatsPipeline.js'), 'utf-8')
  .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));

const { parsePlanCheckRoster, parsePlanCheck } = require('../../server/lib/promptBuilders');

/**
 * `modelFindings: []` has two readings — the checker found nothing, or it
 * answered badly — and the stored row could not tell them apart. On staging
 * job_1789759147125_p08djwhbl the eleven-check call returned zero findings
 * against a plan that breaks four of the planner's own rules on page 5 alone,
 * and the only reason we know the call arrived is that `cast` happens to be
 * derived from its roster.
 *
 * The planner prompt was stored nowhere at all: answering "what was this
 * division asked for" meant rebuilding buildBeatsPrompt in a worktree at the
 * run's commit.
 */
describe('the beats report keeps the evidence it is judged on', () => {
  it('stores the PLANNER prompt, not only the checker prompt', () => {
    // `prompt` was always the checker's; the planner's is the new one.
    expect(src).toContain("prompt: check1.prompt || ''");
    expect(src).toContain("plannerPrompt: planPrompt || ''");
  });

  it('stores the checker reply and the roster the counters reasoned on', () => {
    expect(src).toContain("checkReply: check1.reply || ''");
    expect(src).toContain('rosterLines: check1.rosterLines || []');
  });

  it('a recheck — including a discarded round — keeps the same evidence', () => {
    const rec = src.slice(src.indexOf('const recheckRecord'), src.indexOf('t = Date.now();', src.indexOf('const recheckRecord')));
    expect(rec).toContain("reply: c.reply || ''");
    expect(rec).toContain('rosterLines: c.rosterLines || []');
  });

  it('runCheck returns them, so the report is not reading undefined', () => {
    const fn = src.slice(src.indexOf('const runCheck = async'), src.indexOf('// ONE shape for a recheck'));
    expect(fn).toContain("reply = String(res.text || '')");
    expect(fn).toMatch(/return \{[^}]*\breply\b[^}]*\brosterLines\b[^}]*\}/);
  });

  it('the reply survives a check that reports nothing — the case this exists for', () => {
    // A well-formed reply whose findings section is exactly "NONE".
    const reply = [
      'ROSTER 1: people = Levin; things = red cap; covers = none',
      'ROSTER 2: people = Max, Nia; things = none; covers = Levin, Julian, Max, Kiaan',
      'OBSTACLES 2: Levin',
      'NONE',
    ].join('\n');
    expect(parsePlanCheck(reply)).toEqual([]);          // no findings…
    const roster = parsePlanCheckRoster(reply);
    expect(roster.size).toBe(2);                         // …but the reply is real
    expect(roster.get(2).covers).toEqual(['Levin', 'Julian', 'Max', 'Kiaan']);
  });

  it('rosterLines is serialisable — a Map would persist as {}', () => {
    const roster = parsePlanCheckRoster('ROSTER 3: people = Kiaan; things = none; covers = none');
    const lines = [...roster.entries()].sort((a, b) => a[0] - b[0])
      .map(([pageNumber, r]) => ({ pageNumber, people: r.people, things: r.things, covers: r.covers }));
    expect(JSON.parse(JSON.stringify(lines))).toEqual([
      { pageNumber: 3, people: ['Kiaan'], things: [], covers: [] },
    ]);
  });
});
