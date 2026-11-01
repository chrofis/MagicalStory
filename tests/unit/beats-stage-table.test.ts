import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const { BEATS_STAGES, TEXT_PHASE_START_PCT, TEXT_PHASE_END_PCT } = require('../../server/lib/beatsStageTable');

// Medians over 74 completed beats stories (prod + staging), docs/decisions.md 2026-11-01.
const MEASURED_SECONDS: Record<string, number> = { arcCreate: 250, arcPanel: 246, arcRetell: 307 };
const MEASURED_TEXT_PHASE_SECONDS = 1735;

// The pre-2026-11-01 table (arc machine owned 1-3 points of 57).
const OLD = { arcCreate: { pct: 1, next: 2 }, arcPanel: { pct: 2, next: 2 }, arcRetell: { pct: 2, next: 3 } };

const CHAIN = ['arcCreate', 'arcPanel', 'arcRetell', 'plan', 'planCheck', 'wardrobe', 'visualBible', 'briefs', 'pageText'];

function arcShare(t: Record<string, { pct: number; next: number }>) {
  return (t.arcRetell.next - t.arcCreate.pct) / (TEXT_PHASE_END_PCT - TEXT_PHASE_START_PCT);
}

describe('beats stage table', () => {
  it('is monotonic and chained: each stage ends where the next begins', () => {
    CHAIN.forEach((k, i) => {
      const s = BEATS_STAGES[k];
      expect(s.next).toBeGreaterThan(s.pct);
      const following = BEATS_STAGES[CHAIN[i + 1]];
      if (following) expect(s.next).toBe(following.pct);
    });
    expect(BEATS_STAGES.arcCreate.pct).toBe(TEXT_PHASE_START_PCT);
    expect(BEATS_STAGES.replan.pct).toBeGreaterThan(BEATS_STAGES.planCheck.pct);
    expect(BEATS_STAGES.replan.next).toBe(BEATS_STAGES.planCheck.next);
  });

  it('ends where storyJobPipeline writes text-complete, below where images start', () => {
    expect(BEATS_STAGES.pageText.next).toBe(TEXT_PHASE_END_PCT);
    const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toContain('[' + TEXT_PHASE_END_PCT + ', `Story complete');
    const img = /\[(\d+), 'Generating page illustrations\.\.\.'/.exec(src);
    expect(img).not.toBeNull();
    expect(Number(img![1])).toBeGreaterThan(TEXT_PHASE_END_PCT);
  });

  it('gives every stage at least its measured median to ease over', () => {
    for (const k of CHAIN) {
      const s = BEATS_STAGES[k];
      expect(s.ms).toBeGreaterThanOrEqual(s.seconds * 1000);
    }
  });

  it('arc-machine stages own a share of the bar matching their measured time', () => {
    const measured = (250 + 246 + 307) / MEASURED_TEXT_PHASE_SECONDS; // ~46%
    expect(Math.abs(arcShare(BEATS_STAGES) - measured)).toBeLessThan(0.05);
    // every stage individually within 5 points of its measured share
    for (const k of Object.keys(MEASURED_SECONDS)) {
      const s = BEATS_STAGES[k];
      const share = (s.next - s.pct) / (TEXT_PHASE_END_PCT - TEXT_PHASE_START_PCT);
      expect(Math.abs(share - MEASURED_SECONDS[k] / MEASURED_TEXT_PHASE_SECONDS)).toBeLessThan(0.05);
    }
  });

  it('the old table fails the share assertion (regression)', () => {
    const measured = (250 + 246 + 307) / MEASURED_TEXT_PHASE_SECONDS;
    expect(Math.abs(arcShare(OLD) - measured)).toBeGreaterThan(0.3);
  });

  it('every stage in beatsPipeline.js comes from the table', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    expect(src).not.toMatch(/await stage\(\d/);
    for (const k of Object.keys(BEATS_STAGES)) expect(src).toContain(`stageArgs('${k}'`);
  });
});
