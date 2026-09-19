import { describe, it, expect } from 'vitest';

const { shippedReplanState } = require('../../server/lib/beatsPipeline.js');
const { computeMetrics } = require('../../server/lib/storyMetrics.js');

/**
 * `beatsReviewReport` must describe the division that SHIPPED.
 *
 * The re-plan loop can run a round and throw it away. Until 2026-09-18 the
 * report was written from the last round's variables either way: `changedPages`
 * was a running union across every round, and `recheck` held whatever the last
 * runCheck() returned — so a story whose round 2 was discarded stored round 2's
 * page list and round 2's findings while shipping round 1's division.
 *
 * Every ledger below is the REAL round data of a staging run, transcribed from
 * that run's stored generationLog (`beats_replan`, `plan_recheck*`,
 * `beats_replan_discarded`). The expectations are what the row should have said.
 */

/** job_1789681157795_wkt20ckod — "Das Ei im Lindenhof", 18 pages, round 2 discarded. */
const RUN_WKT = [
  {
    round: 1,
    changedPages: [8, 12, 16, 18],
    findingsIn: 2,
    kept: true,
    recheck: {
      counterFindings: ['PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 7, 8: both pages are a medium shot with 2 named character(s) in frame'],
      modelFindings: [
        { check: 1, text: 'a felt moment shared with three others' },
        { check: 2, text: 'two figures in frame without an arrival' },
        { check: 3, text: 'a third named character with no justification' },
        { check: 4, text: 'the wanted picture is not the page' },
        { check: 5, text: 'the instant is reported, not staged' },
        { check: 6, text: 'the page ends where the one before it ended' },
        { check: 7, text: 'the shot repeats' },
        { check: 8, text: 'nothing is true after this page that was not true before' },
      ],
      lines: [
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 7, 8: both pages are a medium shot with 2 named character(s) in frame',
        'CHECK[1]: a felt moment shared with three others',
        'CHECK[2]: two figures in frame without an arrival',
        'CHECK[3]: a third named character with no justification',
        'CHECK[4]: the wanted picture is not the page',
        'CHECK[5]: the instant is reported, not staged',
        'CHECK[6]: the page ends where the one before it ended',
        'CHECK[7]: the shot repeats',
        'CHECK[8]: nothing is true after this page that was not true before',
      ],
    },
  },
  {
    round: 2,
    changedPages: [3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18],
    findingsIn: 9,
    kept: false,
    discardReason: 'did not reduce must-fix findings (1 → 1)',
    recheck: {
      counterFindings: [
        'PLAN[PLAN_LINE_INCOMPLETE] page 18: the plan line does not carry all four of shot, who, the instant, and what is true after',
        'PLAN[NO_PEOPLELESS_PAGE]: no page shows only a thing or a place, with no people in frame',
        'PLAN[NO_COMMISSIONED_ON_PAGE] page 7: a peopled page with none of the commissioned characters in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 6, 7: both pages are a medium shot with 1 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 8, 9: both pages are a close-up shot with 2 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 10, 11: both pages are a medium shot with 2 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 15, 16: both pages are a medium shot with 2 named character(s) in frame',
      ],
      modelFindings: [],
      lines: [
        'PLAN[PLAN_LINE_INCOMPLETE] page 18: the plan line does not carry all four of shot, who, the instant, and what is true after',
        'PLAN[NO_PEOPLELESS_PAGE]: no page shows only a thing or a place, with no people in frame',
        'PLAN[NO_COMMISSIONED_ON_PAGE] page 7: a peopled page with none of the commissioned characters in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 6, 7: both pages are a medium shot with 1 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 8, 9: both pages are a close-up shot with 2 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 10, 11: both pages are a medium shot with 2 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 15, 16: both pages are a medium shot with 2 named character(s) in frame',
      ],
    },
  },
];

/** job_1789506283204_3kxqshifx — "Das Ei unter den Wurzeln", round 2 discarded. */
const RUN_3KX = [
  {
    round: 1,
    changedPages: [3, 17],
    findingsIn: 4,
    kept: true,
    recheck: {
      counterFindings: ['PLAN[NO_FOCAL_PAGE]: Nia never has a focal page — never in frame with at most one companion, never the subject of a close-up'],
      modelFindings: [],
      lines: ['PLAN[NO_FOCAL_PAGE]: Nia never has a focal page — never in frame with at most one companion, never the subject of a close-up'],
    },
  },
  {
    round: 2,
    changedPages: [9],
    findingsIn: 1,
    kept: false,
    discardReason: 'did not reduce must-fix findings (1 → 1)',
    recheck: {
      counterFindings: [
        "PLAN[ARC_INVENTED_UNDECLARED]: the plan names invented figure crow that the arc's own invented list does not carry (arc declared: Lindi)",
        'PLAN[NO_COMMISSIONED_ON_PAGE] page 10: a peopled page with none of the commissioned characters in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 8, 9: both pages are a close-up shot with 1 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 9, 10: both pages are a close-up shot with 1 named character(s) in frame',
      ],
      modelFindings: [],
      lines: [
        "PLAN[ARC_INVENTED_UNDECLARED]: the plan names invented figure crow that the arc's own invented list does not carry (arc declared: Lindi)",
        'PLAN[NO_COMMISSIONED_ON_PAGE] page 10: a peopled page with none of the commissioned characters in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 8, 9: both pages are a close-up shot with 1 named character(s) in frame',
        'PLAN[CONSECUTIVE_SAME_SHOT_CAST] page 9, 10: both pages are a close-up shot with 1 named character(s) in frame',
      ],
    },
  },
];

/** job_1789584708605_rts4wqupm — "Das Ei unter der Wurzel", BOTH rounds kept (findings survived, nothing discarded). */
const RUN_RTS = [
  {
    round: 1,
    changedPages: [11, 14, 18],
    findingsIn: 5,
    kept: true,
    recheck: {
      counterFindings: ['a', 'b', 'c', 'd'],
      modelFindings: [],
      lines: ['a', 'b', 'c', 'd'],
    },
  },
  {
    round: 2,
    changedPages: [14],
    findingsIn: 4,
    kept: true,
    recheck: {
      counterFindings: ['PLAN[SHOT_ULTRAWIDE_COUNT]: 0 ultra-wide page(s); the plan asks for about two', 'w', 'x', 'y'],
      modelFindings: [],
      lines: ['PLAN[SHOT_ULTRAWIDE_COUNT]: 0 ultra-wide page(s); the plan asks for about two', 'w', 'x', 'y'],
    },
  },
];

describe('shippedReplanState — the report describes the division that shipped', () => {
  it('job_1789681157795_wkt20ckod: reports round 1 (4 pages, 9 findings), not the discarded round 2 (14 pages, 7 findings)', () => {
    const shipped = shippedReplanState(RUN_WKT);
    expect(shipped.changedPages).toEqual([8, 12, 16, 18]);
    expect(shipped.recheck?.counterFindings).toHaveLength(1);
    expect(shipped.recheck?.counterFindings?.[0]).toContain('page 7, 8');
    expect(shipped.recheck?.lines).toHaveLength(9);
    // The numbers the row used to carry are exactly the ones that must NOT be here.
    expect(shipped.changedPages).not.toContain(3);
    expect(shipped.recheck?.counterFindings?.join(' ')).not.toContain('PLAN_LINE_INCOMPLETE');
  });

  it('job_1789681157795_wkt20ckod: the discarded round survives in full under discardedRounds', () => {
    const shipped = shippedReplanState(RUN_WKT);
    expect(shipped.discardedRounds).toHaveLength(1);
    const [d] = shipped.discardedRounds;
    expect(d.round).toBe(2);
    expect(d.reason).toContain('did not reduce must-fix findings');
    expect(d.changedPages).toEqual([3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(d.recheck?.counterFindings).toHaveLength(7);
  });

  it('job_1789506283204_3kxqshifx: reports 2 pages and 1 finding, not the stored 3 pages and 4 findings', () => {
    const shipped = shippedReplanState(RUN_3KX);
    expect(shipped.changedPages).toEqual([3, 17]);
    expect(shipped.recheck?.lines).toHaveLength(1);
    expect(shipped.recheck?.counterFindings?.[0]).toContain('NO_FOCAL_PAGE');
    expect(shipped.discardedRounds).toHaveLength(1);
    expect(shipped.discardedRounds[0].changedPages).toEqual([9]);
    expect(shipped.discardedRounds[0].recheck?.counterFindings).toHaveLength(4);
  });

  it('job_1789584708605_rts4wqupm: two KEPT rounds still union their pages and report the last round’s recheck', () => {
    const shipped = shippedReplanState(RUN_RTS);
    expect(shipped.changedPages).toEqual([11, 14, 18]);
    expect(shipped.recheck?.counterFindings?.[0]).toContain('0 ultra-wide page(s)');
    expect(shipped.discardedRounds).toEqual([]);
  });

  it('a single-round run is unchanged: its pages and its recheck, no discarded round', () => {
    const one = [{ round: 1, changedPages: [4, 9], findingsIn: 3, kept: true, recheck: { counterFindings: ['x'], modelFindings: [], lines: ['x'] } }];
    const shipped = shippedReplanState(one);
    expect(shipped.changedPages).toEqual([4, 9]);
    expect(shipped.recheck?.lines).toEqual(['x']);
    expect(shipped.discardedRounds).toEqual([]);
  });

  it('a run where the check drew no findings has no rounds at all', () => {
    const shipped = shippedReplanState([]);
    expect(shipped.changedPages).toEqual([]);
    expect(shipped.recheck).toBeNull();
    expect(shipped.discardedRounds).toEqual([]);
    expect(shippedReplanState().changedPages).toEqual([]);
  });

  it('a round discarded by a guard before its recheck ran is recorded with no findings', () => {
    const guarded = [
      { round: 1, changedPages: [2], findingsIn: 1, kept: true, recheck: { counterFindings: [], modelFindings: [], lines: [] } },
      { round: 2, changedPages: [], recheck: null, kept: false, discardReason: 'two pages returned with an identical plan line' },
    ];
    const shipped = shippedReplanState(guarded);
    expect(shipped.changedPages).toEqual([2]);
    expect(shipped.recheck?.lines).toEqual([]);
    expect(shipped.discardedRounds).toHaveLength(1);
    expect(shipped.discardedRounds[0].recheck).toBeNull();
  });

  it('a re-plan that failed mid-loop leaves nothing shipped and every round on the record', () => {
    // What the catch block produces: rounds that had been kept are demoted.
    const failed = RUN_WKT.map(r => ({ ...r, kept: false, discardReason: r.discardReason || 're-plan failed after this round (timeout) — the first division ships' }));
    const shipped = shippedReplanState(failed);
    expect(shipped.changedPages).toEqual([]);
    expect(shipped.recheck).toBeNull();
    expect(shipped.discardedRounds).toHaveLength(2);
  });

  it('the shipped page list is sorted and deduplicated across kept rounds', () => {
    const overlap = [
      { round: 1, changedPages: [9, 3], kept: true, recheck: { counterFindings: [], modelFindings: [], lines: [] } },
      { round: 2, changedPages: [3, 1], kept: true, recheck: { counterFindings: [], modelFindings: [], lines: [] } },
    ];
    expect(shippedReplanState(overlap).changedPages).toEqual([1, 3, 9]);
  });
});

describe('backward compatibility — a row written before the fix still reads', () => {
  // The three server-side readers of beatsReviewReport are storyMetrics
  // (churn + outline_fix_count, off `.pages`), storyScorecard (`.model`) and the
  // dev-mode diff panel (`.changedPages`). None of them reads `discardedRounds`,
  // so an old row without the key must still compute the same metrics.
  const oldRow: any = {
    sceneImages: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }, { pageNumber: 4 }],
    beatsReviewReport: {
      check: 'counters+plan-check',
      model: 'openai/gpt-5.6-luna-pro',
      changedPages: [3, 9, 17],
      pages: [
        { pageNumber: 3, before: 'PLAN: a', after: 'PLAN: b' },
        { pageNumber: 9, before: 'PLAN: c', after: 'PLAN: c' },
      ],
      recheck: { counterFindings: ['x'], counterStats: {}, modelFindings: [] }, // no `lines`, no `discardedRounds`
    },
  };

  it('storyMetrics reads an old row without discardedRounds and without recheck.lines', () => {
    const m = computeMetrics(oldRow, null);
    expect(m).toBeTruthy();
    // One of the two report pages actually differs → one outline fix.
    expect(m.outline_fix_count).toBe(1);
  });

  it('storyMetrics reads a NEW row carrying discardedRounds identically', () => {
    const newRow = JSON.parse(JSON.stringify(oldRow));
    newRow.beatsReviewReport.discardedRounds = [{ round: 2, reason: 'did not reduce must-fix findings (1 → 1)', changedPages: [9], recheck: { counterFindings: ['a'], modelFindings: [], lines: ['a'] } }];
    newRow.beatsReviewReport.changedPages = [3, 17];
    const m = computeMetrics(newRow, null);
    expect(m).toBeTruthy();
    expect(m.outline_fix_count).toBe(1);
  });
});
