import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import { parsePlanResponse, parseBeats } from '../../server/lib/promptBuilders.js';

/**
 * The planner emits ONE block, the page plan, and each page IS its plan line
 * (owner ruling 2026-09-02, Lab #973 — the beat prose was the lossiest stage).
 * There is no legacy bridge: a transcript carrying beat prose is not a shape
 * these parsers read, and its pages come back as missing so the caller fails
 * loudly rather than replaying half a story.
 */
describe('parsePlanResponse — the planner response', () => {
  const raw = [
    'Some planning prose the model wrote first.',
    '',
    '---PAGE PLAN---',
    'Page 1: close-up — the main character — she lifts the lid — the box is open',
    'Page 2: wide — the main character and a guard — the guard blocks the gate — the way out is shut',
  ].join('\n');

  it('reads one page per plan line', () => {
    const out = parsePlanResponse(raw, [1, 2]);
    expect(out.pages.map((p: any) => p.pageNumber)).toEqual([1, 2]);
    expect(out.pages[0].planLine).toContain('the box is open');
    expect(out.pages[1].planLine).toContain('the way out is shut');
    expect(out.missing).toEqual([]);
  });

  it('reports the pages the planner omitted', () => {
    expect(parsePlanResponse(raw, [1, 2, 3]).missing).toEqual([3]);
  });

  it('carries no beat field — the planner writes no prose', () => {
    expect(parsePlanResponse(raw, [1, 2]).pages.every((p: any) => !('beat' in p))).toBe(true);
  });

  it('stores the page plan block, never the whole response', () => {
    expect(parsePlanResponse(raw, [1, 2]).pagePlan).not.toContain('planning prose');
  });

  it('falls back to scanning the whole response when the marker is missing', () => {
    const noMarker = 'Page 1: close-up — the main character — she lifts the lid — the box is open';
    expect(parsePlanResponse(noMarker, [1]).pages).toHaveLength(1);
  });

  it('returns no pages for an empty response', () => {
    expect(parsePlanResponse('', [1, 2]).pages).toEqual([]);
  });
});

describe('parseBeats — a stored transcript is read in ONE shape', () => {
  const beatsBlock = (body: string) => `---BEATS---\n${body}`;

  it('reads a page from its PLAN line', () => {
    const out = parseBeats(beatsBlock('## Page 1\nPLAN: close-up — the main character — she lifts the lid — the box is open'), [1]);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].planLine).toContain('the box is open');
    expect(out.pages[0].beat).toBeUndefined();
  });

  it('does NOT read beat prose — a pre-2026-09-02 page is reported missing', () => {
    const out = parseBeats(beatsBlock('## Page 1\nBEAT: She opens the box.\nSCENE: a close-up of the open box'), [1]);
    expect(out.pages).toHaveLength(0);
    expect(out.missing).toEqual([1]);
  });

  it('reads only the PLAN line when a legacy page carries both', () => {
    const out = parseBeats(beatsBlock('## Page 1\nBEAT: She opens the box.\nPLAN: close-up — the main character — the box is open'), [1]);
    expect(out.pages[0].planLine).toContain('the box is open');
    expect(out.pages[0].planLine).not.toContain('She opens the box');
  });

  it('reports pages the transcript is missing', () => {
    expect(parseBeats(beatsBlock('## Page 1\nPLAN: a plan line'), [1, 2]).missing).toEqual([2]);
  });

  it('still extracts the ---ARC--- block', () => {
    const raw = `---ARC---\n1. The story happens.\n\n---BEATS---\n## Page 1\nPLAN: a plan line`;
    expect(parseBeats(raw, [1]).arc).toContain('The story happens');
  });
});
