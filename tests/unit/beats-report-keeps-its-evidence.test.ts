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

  it('stores the RE-PLAN prompt per round — the only one carrying the findings', () => {
    // `plannerPrompt` is the FIRST division's. The re-plan request is the only
    // prompt in the stage that carries `## MUST FIX` / `## ALSO NOTED`, and it
    // was stored nowhere, so reconstructing what a round was asked to fix meant
    // rebuilding buildReplanSection at the run's commit.
    expect(src).toContain('replanPrompts: shipped.replanPrompts');
    // The kept round's record carries it…
    const rec = src.slice(src.indexOf('const roundRecord = {'), src.indexOf('replanRounds.push(roundRecord)'));
    expect(rec).toContain('replanPrompt,');
    // …and so does every early-discard push, which returns before roundRecord.
    for (const m of src.matchAll(/replanRounds\.push\(\{ round,[^)]*\)/g)) {
      expect(m[0]).toContain('replanPrompt');
    }
  });

  it('a DISCARDED round keeps its re-plan prompt — it is why the loop stopped', () => {
    const { shippedReplanState } = require('../../server/lib/beatsPipeline.js');
    const out = shippedReplanState([
      { round: 1, changedPages: [7], kept: true, recheck: null, replanPrompt: 'ROUND ONE PROMPT / ## MUST FIX / PLAN[NO_PEOPLELESS_PAGE]: …' },
      { round: 2, changedPages: [1, 2], kept: false, discardReason: 'did not reduce must-fix', replanPrompt: 'ROUND TWO PROMPT' },
    ]);
    expect(out.replanPrompts).toEqual([{ round: 1, prompt: 'ROUND ONE PROMPT / ## MUST FIX / PLAN[NO_PEOPLELESS_PAGE]: …' }]);
    expect(out.discardedRounds[0].replanPrompt).toBe('ROUND TWO PROMPT');
  });

  it('a ledger from before the field stores empty, never undefined', () => {
    const { shippedReplanState } = require('../../server/lib/beatsPipeline.js');
    const out = shippedReplanState([
      { round: 1, changedPages: [3], kept: true, recheck: null },
      { round: 2, changedPages: [], kept: false, discardReason: 'omitted page(s) 4' },
    ]);
    expect(out.replanPrompts).toEqual([]);
    expect(out.discardedRounds[0].replanPrompt).toBe('');
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
