/**
 * A refused change undoes only ITSELF (2026-10-09, job_1791497309909_6quecrr9t).
 * The plan check asked for Julian and Kiaan on p4 (must-fix); the same page also
 * carried a refused advisory change. The restore was page-wide, so the accepted
 * `cast in` lines went with it and the ending shipped without them.
 */
import { describe, it, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');

const CAST = ['Max', 'Julian', 'Kiaan', 'Mia'];
const STANDING = [
  { pageNumber: 3, planLine: 'wide — Max alone at the gate — Max waits — the gate is shut' },
  { pageNumber: 4, planLine: 'medium — Max and Mia at the fountain — Max hands Mia the egg — Mia holds the egg' },
];
const REPLAN = [
  'Page 3: x',
  'Page 4: medium — Max, Mia, Julian and Kiaan at the fountain — Max hands Mia the egg while the others cheer — Mia holds the egg',
  '---CHANGES---',
  'Page 4: cast in Julian — CHECK[16] — the ending needs him',
  'Page 4: cast in Kiaan — CHECK[17] — the ending needs him',
  "Page 4: action out Max hands Mia the egg — CHECK[9] — advisory",
  'Changes: 3',
].join('\n');

function review() {
  const declared = PB.parsePlanChanges(REPLAN);
  const returned = [STANDING[0], { pageNumber: 4, planLine: 'medium — Max, Mia, Julian and Kiaan at the fountain — Max hands Mia the egg while the others cheer — Mia holds the egg' }];
  const rev = PC.reviewPlanChanges({
    changes: declared.changes, standing: STANDING, returned, castNames: CAST,
    protectedPages: new Map([[4, "Max's own action"]]),
    rankOf: (t: any) => (t && t.check >= 16 ? 'must' : 'also'),
  });
  return { declared, returned, rev };
}

describe('restoreRefusedChanges', () => {
  it('refuses only the advisory change on the protected page', () => {
    const { rev } = review();
    expect(rev.refusals.map((r: any) => r.clause)).toEqual(['action out Max hands Mia the egg']);
  });
  it('keeps the accepted must-fix cast changes when a sibling change is refused (fails with a whole-page restore)', () => {
    const { declared, returned, rev } = review();
    const out = PC.restoreRefusedChanges({ pages: returned, standing: STANDING, refusals: rev.refusals, changes: declared.changes, castNames: CAST });
    const p4 = out.pages.find((p: any) => p.pageNumber === 4);
    expect(p4.planLine).toContain('Julian');
    expect(p4.planLine).toContain('Kiaan');
    // the refused prose change is not part of the page: the standing instant stands
    expect(p4.planLine).toContain('Max hands Mia the egg — Mia holds the egg');
    expect(p4.planLine).not.toContain('while the others cheer');
    expect(out.applied[0].pageNumber).toBe(4);
  });
  it('restores the standing line unchanged when every change on the page is refused', () => {
    const declared = PB.parsePlanChanges('---CHANGES---\nPage 4: action out Max hands Mia the egg — CHECK[9] — x\nChanges: 1');
    const rev = PC.reviewPlanChanges({ changes: declared.changes, standing: STANDING, returned: STANDING, castNames: CAST, protectedPages: new Map([[4, 'x']]), rankOf: () => 'also' });
    const out = PC.restoreRefusedChanges({ pages: [STANDING[0], { pageNumber: 4, planLine: 'changed' }], standing: STANDING, refusals: rev.refusals, changes: declared.changes, castNames: CAST });
    expect(out.pages[1]).toBe(STANDING[1]);
  });
  it('reports an accepted prose change it cannot re-apply instead of dropping it silently', () => {
    const changes = [
      { pageNumber: 4, kind: 'action_in', clause: 'action in cheering', line: 'l1' },
      { pageNumber: 4, kind: 'cast_out', subject: 'Mia', clause: 'cast out Mia', line: 'l2' },
    ];
    const out = PC.restoreRefusedChanges({
      pages: [STANDING[0], { pageNumber: 4, planLine: 'z' }], standing: STANDING,
      refusals: [{ pageNumber: 4, rule: 'span', detail: '', line: 'l2', clause: 'cast out Mia' }], changes, castNames: CAST,
    });
    expect(out.lost[0].changes).toEqual(['action in cheering']);
  });
});

describe('both re-plan paths use the partial restore (replan-prod-vs-lab)', () => {
  const fs = require('fs');
  for (const f of ['server/lib/beatsPipeline.js', 'server/lib/testlab.js']) {
    it(f, () => {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).toContain('restoreRefusedChanges(');
      expect(src).not.toMatch(/restore\(review\.refusals\.map/);
    });
  }
});
