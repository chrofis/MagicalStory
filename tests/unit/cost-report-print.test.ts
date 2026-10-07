import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

/**
 * scripts/admin/cost-report.js header line. The window ends "now" and the two
 * dates were `startISO.slice(0, 10)` — the UTC calendar day. Run at 00:30 CH the
 * end date read as yesterday, and the whole owner-facing line was UTC, which
 * CLAUDE.md's timezone rule forbids (every timestamp shown is Swiss, marked CH).
 */
const nodeRequire = createRequire(import.meta.url);

const report = {
  projectName: 'magical-story',
  days: 7,
  deltaTotal: 0,
  projectedMonthly: 0,
  current: {
    // 2026-09-30 22:30 UTC is 2026-10-01 00:30 CH: the owner ran this on 1 October.
    startISO: '2026-09-23T22:30:00.000Z',
    endISO: '2026-09-30T22:30:00.000Z',
    items: [],
    totals: { memory: 0, cpu: 0, egress: 0, disk: 0, total: 0 },
  },
  previous: { totals: { total: 0 } },
};

describe('cost-report print()', () => {
  it('shows the window as Swiss calendar days, marked CH', () => {
    const { print } = nodeRequire('../../scripts/admin/cost-report.js');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')); });
    try {
      print(report);
    } finally {
      spy.mockRestore();
    }
    const header = lines.find((l) => l.includes('→'));
    expect(header).toBeDefined();
    expect(header).toContain('2026-09-24 → 2026-10-01 CH');
    expect(lines.join('\n')).not.toContain('2026-09-30');
  });
});
