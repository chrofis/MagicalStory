/**
 * THE WORLD IS TOLD (owner, 2026-10-18). Every story not set in today's everyday world tells its reader the world
 * or time early and inside the action; characters who cross into another world are told how they got there and,
 * if they leave, how they got back. ONE constant for the prose passes (WORLD_TELLING_RULE, in the rulebook), the
 * arc side is the OWED fact definition (the world, the way in and the way back are owed Facts lines), and the
 * rules that used to hide it (the backstory ban, "background drops nothing") make the exception.
 * Evidence: prod space-station story job_1792312615714_wpz3fzwyy — the arc had the station, no page said "space".
 * Pins reach and structure, never one story. see docs/decisions.md 2026-10-18 "The world is told".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pb = require('../../server/lib/promptBuilders');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const slop = require('../../server/lib/proseSlop');
const ROOT = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('the writers, the repair and every language pass are given the world rule', () => {
  it('it is in the rulebook all of them are filled with, in every language', () => {
    expect(pb.WORLD_TELLING_RULE).toBeTruthy();
    for (const lang of ['en', 'de-ch', 'fr-ch']) expect(pb.styleRulebook(lang)).toContain(pb.WORLD_TELLING_RULE);
    // the beats writer, the trial writer, the repair, the diff pass, the lector and the blind audit all declare the placeholder
    for (const f of ['story-text-from-beats', 'story-trial-pages', 'text-refine', 'story-text-diff', 'story-text-proofread', 'story-text-audit-blind']) {
      expect(read(`prompts/${f}.txt`)).toContain('{STYLE_RULEBOOK}');
    }
  });
  it('the rule asks for the world, the way in and the way back, and exempts only today\'s everyday world', () => {
    const r = pb.WORLD_TELLING_RULE;
    expect(r).toMatch(/today's everyday world/);
    expect(r).toMatch(/how they got there/);
    expect(r).toMatch(/how they got back/);
    expect(r).toMatch(/never as an opening backstory paragraph/);
  });
  it('the backstory ban bans a backstory paragraph and says naming the world inside the action is none', () => {
    expect(slop.STOCK_BAN_RULE).toMatch(/backstory paragraph/);
    expect(slop.STOCK_BAN_RULE).toMatch(/naming the world/);
  });
});

describe('the world is an owed fact, on the arc side and the text side', () => {
  it('the owed-fact definition names the world, the way in and the way back; the load-bearing rule uses it and tells the world by narration', () => {
    expect(pb.OWED_FACT_DEF).toMatch(/world or time it is set in/);
    expect(pb.OWED_FACT_DEF).toMatch(/get into another world/);
    expect(pb.OWED_FACT_DEF).toMatch(/get back/);
    expect(pb.LOAD_BEARING_RULE).toContain(pb.OWED_FACT_DEF);
    expect(pb.LOAD_BEARING_RULE).toMatch(/The exception is the world/);
  });
  it('the arc logic spec asks for the world lines outside the two-rule cap, and none for today\'s everyday world', () => {
    const spec = pb.arcLogicSpec({}, 10);
    expect(spec).toMatch(/not set in today's everyday world also gets, outside that count/);
    expect(spec).toMatch(/how they get there and one for how they get back/);
    expect(spec).toMatch(/a story set in today's everyday world gets none of these/);
  });
  it('a world, way-in and way-back line in the logic is on the OWED list the writer, the repair and the audit read', () => {
    const logic = [
      'Want and stakes: reach the pump before the supper bell.',
      'Opposition: a stuck valve.',
      'Facts:',
      '- Ana (commissioned) — none',
      '- The story is set on a space station in orbit',
      '- The family flew up from Earth in a rocket',
      '- They ride the capsule back down at the end',
      'Motives:',
      '- Ana: wants the pump → she climbs',
      'Central figure: none',
      'Events: 2',
      'Chain:',
      '- because the valve stuck, Ana climbs',
      '- but the pump hums, so it works',
    ].join('\n');
    const owed = pb.parseStoryLogic(`STORY LOGIC:\n${logic}`).owed;
    expect(owed).toEqual(expect.arrayContaining(['The story is set on a space station in orbit', 'The family flew up from Earth in a rocket', 'They ride the capsule back down at the end']));
    expect(pb.buildOwedFacts(logic)).toMatch(/space station in orbit/);
  });
  it('the frame rule, shared by the creator, the re-teller, the panel and the trial arc, says the arc names the world and the way back', () => {
    expect(pb.WORLD_FRAME_RULE).toMatch(/says which world or time the story is set in/);
    expect(pb.WORLD_FRAME_RULE).toMatch(/the way back a staged moment too/);
  });
});

describe('the page-1 checks do not penalise a world named inside the action', () => {
  it('the plan check\'s opening question exempts a page 1 that does something in a named world', () => {
    expect(read('prompts/plan-check.txt')).toMatch(/a page 1 that does something in a named world or time is not/);
  });
});
