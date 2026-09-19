import { describe, it, expect } from 'vitest';

const { parsePlanCheck, parsePlanCheckRoster, parsePlanCheckObstacles } = require('../../server/lib/promptBuilders');

/**
 * prompts/plan-check.txt asks only: "Each line begins with the number of the
 * check it answers, then names the page and what is wrong." It never asks for a
 * separator. The parser required `.` or `)` after the number, so a reply that
 * obeyed the prompt literally had every finding silently discarded.
 *
 * Measured 2026-09-19 over 32 stored staging runs: every run from 2026-09-14
 * 01:09 onward recorded `modelFindings: []` — six consecutive books — while the
 * counters kept finding 2-6 faults each. Replaying the stored prompt of
 * job_1789759147125_p08djwhbl against the same model at temperature 0 returned
 * 18 ROSTER lines, 6 OBSTACLES lines and 22 findings, every one shaped
 * `9 Page 17 shows…` — no punctuation, all 22 dropped.
 */
describe('a plan-check finding needs a number, not a punctuation mark', () => {
  it('parses the bare-number shape the model actually emits', () => {
    const reply = [
      '9 Page 17 shows the shell cracking, the dragon climbing out and the dragon being alive in the same instant.',
      '10 Page 8 puts the raven above the four boys on the ground.',
      '11 Page 12: the baker’s refusal works against Levin’s attempt to ask for a warm corner.',
    ].join('\n');
    const f = parsePlanCheck(reply);
    expect(f).toHaveLength(3);
    expect(f.map((x: any) => x.check)).toEqual([9, 10, 11]);
    expect(f[0].text.startsWith('Page 17 shows')).toBe(true);
    expect(f[2].text.startsWith('Page 12:')).toBe(true);
  });

  it('still parses the punctuated shapes it always did', () => {
    const f = parsePlanCheck('1. Page 3 is wrong.\n2) Page 4 is wrong.\n3: Page 5 is wrong.');
    expect(f.map((x: any) => x.check)).toEqual([1, 2, 3]);
    expect(f.every((x: any) => x.text.startsWith('Page '))).toBe(true);
  });

  it('keeps the check number — the re-plan ranks on it and never on the prose', () => {
    const f = parsePlanCheck('4 Page 9 does not stage the act\'s wanted picture.');
    expect(f[0].check).toBe(4);
  });

  it('does not swallow the ROSTER or OBSTACLES blocks', () => {
    const reply = [
      'ROSTER 1: people = Levin; things = none; covers = none',
      'OBSTACLES 12: Levin',
      '3 Page 5 carries five named characters.',
    ].join('\n');
    const f = parsePlanCheck(reply);
    expect(f).toHaveLength(1);
    expect(f[0].check).toBe(3);
    // The two blocks keep parsing into their own shapes.
    expect(parsePlanCheckRoster(reply).size).toBe(1);
    expect(parsePlanCheckObstacles(reply).size).toBe(1);
  });

  it('a clean plan still reports nothing', () => {
    expect(parsePlanCheck('NONE')).toEqual([]);
    expect(parsePlanCheck('none.')).toEqual([]);
    expect(parsePlanCheck('')).toEqual([]);
  });

  it('a numbered line with no text is not a finding', () => {
    expect(parsePlanCheck('7\n8  \n9 Page 2 is wrong.')).toHaveLength(1);
  });

  it('tolerates the trailing double-space a markdown reply carries', () => {
    expect(parsePlanCheck('10 Page 8 puts the raven above the boys.  ')).toHaveLength(1);
  });
});
