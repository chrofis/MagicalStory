/**
 * scripts/analysis/fetch-story-data.js — render-attempt reporting.
 *
 * Regression: lines 503 / 696 / 980 used `page.totalAttempts || 1`. No generation
 * path writes page-level `totalAttempts` (the quality-retry path that did was
 * deleted in the 2026-08 pipeline unification), so the script reported
 * "Attempts: 1" — a clean single render — on EVERY evaluated story, and its
 * per-page rollup silently dropped the attempts field for the same reason.
 *
 * The source of truth is `pageAttemptCount()` from server/lib/storyMetrics.js
 * (19af9e4ce): retryHistory first, totalAttempts as fallback, null when neither
 * exists. These tests pin the RENDERED output, not the helper (which has its own
 * tests in quality-analytics-not-measured.test.ts): an absent counter must never
 * reach the screen as "1", and a real retryHistory must show its true length.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { formatAttempts, printPageDetails, printAnalysisSummary } = require('../../scripts/analysis/fetch-story-data.js');

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

const basePage = {
  storyId: 's1', title: 'T', pageNumber: 4, text: 'x', outlineExtract: '',
  description: null, sceneCharacters: [], sceneCharacterClothing: null,
  qualityScore: 82, qualityReasoning: '', wasRegenerated: false,
  retryHistory: 0, repairHistory: 0,
};

afterEach(() => vi.restoreAllMocks());

describe('formatAttempts', () => {
  it('renders an absent counter as "not measured", never 1', () => {
    expect(formatAttempts({ pageNumber: 1 })).toBe('not measured');
    expect(formatAttempts({ pageNumber: 1, retryHistory: [] })).toBe('not measured');
    expect(formatAttempts(null)).toBe('not measured');
  });

  it('renders the true retryHistory length', () => {
    expect(formatAttempts({ retryHistory: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] })).toBe('3');
    expect(formatAttempts({ retryHistory: [{ attempt: 1 }] })).toBe('1');
  });

  it('falls back to totalAttempts only when there is no history', () => {
    expect(formatAttempts({ totalAttempts: 2 })).toBe('2');
    // history wins over a stale totalAttempts
    expect(formatAttempts({ totalAttempts: 9, retryHistory: [{ attempt: 1 }, { attempt: 2 }] })).toBe('2');
  });
});

describe('printPageDetails — Attempts line', () => {
  it('says "not measured" for a unified-pipeline page with no counter', () => {
    const out = capture(() => printPageDetails({ ...basePage, attemptsLabel: formatAttempts({ pageNumber: 4 }) }));
    expect(out).toContain('Attempts: not measured');
    expect(out).not.toContain('Attempts: 1');
  });

  it('shows the real count when retryHistory exists', () => {
    const img = { pageNumber: 4, retryHistory: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] };
    const out = capture(() => printPageDetails({ ...basePage, attemptsLabel: formatAttempts(img) }));
    expect(out).toContain('Attempts: 3');
  });
});

describe('printAnalysisSummary — IMAGE EVALUATIONS rollup', () => {
  const summary = (evaluations: unknown[]) => ({
    storyId: 's1', title: 'T', createdAt: null, language: 'de', artStyle: 'x', pages: 2,
    cost: null, sceneData: [], evaluations, checkpoints: [], outlineSections: null,
    outlineComparison: null, textCheck: null, storyIdeas: null, job: null,
  });

  it('marks pages whose attempt counter is absent instead of implying one clean render', () => {
    const out = capture(() => printAnalysisSummary(summary([
      { pageNumber: 1, qualityScore: 80, fixTargets: [], attemptCount: null, wasRegenerated: false, wasAutoRepaired: false },
    ]) as never));
    expect(out).toContain('Page 1: score=80.0, attempts=not measured');
  });

  it('reports the true count for a retried page and stays silent for a genuine single render', () => {
    const out = capture(() => printAnalysisSummary(summary([
      { pageNumber: 1, qualityScore: 60, fixTargets: [], attemptCount: 3, wasRegenerated: true, wasAutoRepaired: false },
      { pageNumber: 2, qualityScore: 90, fixTargets: [], attemptCount: 1, wasRegenerated: false, wasAutoRepaired: false },
    ]) as never));
    expect(out).toContain('attempts=3');
    expect(out).toContain('Page 2: score=90.0');
    expect(out).not.toContain('attempts=1');
  });
});
