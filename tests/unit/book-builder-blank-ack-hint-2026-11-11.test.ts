/**
 * Book order page redesign, 2026-11-11 (customer could not order a 10-page book; owner redesign).
 * - one blankAck state, two controls: agree button in the warning box + tick box above the order button
 * - single story hides note / arrows / badge; spreadNote deleted; dedication not displayed
 * - printed-book strip uses toImgSrc and shows real page text
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toImgSrc } from '../../client/src/utils/imgSrc';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../..', ...p), 'utf8');
const builder = read('client/src/pages/BookBuilder.tsx');

describe('printed-book strip', () => {
  const src = read('client/src/components/book/BlankPagesPreview.tsx');
  it('keeps an R2 URL as the image source', () => {
    expect(toImgSrc('https://images.magicalstory.ch/x/page1.jpg')).toBe('https://images.magicalstory.ch/x/page1.jpg');
  });
  it('builds its sources with toImgSrc, never by wrapping as base64', () => {
    expect(src).toMatch(/toImgSrc\(/);
    expect(src).not.toMatch(/base64,\$\{/);
  });
  it('shows the real page text on text pages, not placeholder lines', () => {
    expect(src).toMatch(/\{p\.text\}/);
    expect(src).not.toMatch(/h-px bg-indigo-300/);
  });
});

describe('one blankAck state bound to both controls', () => {
  it('has a single blankAck useState', () => {
    expect((builder.match(/useState\(false\);\s*\n.*\n?/g) || []).length).toBeGreaterThan(0);
    expect((builder.match(/\[blankAck, setBlankAck\]/g) || []).length).toBe(1);
  });
  it('the agree button sets it and the checkbox is bound to it', () => {
    expect(builder).toMatch(/data-testid="blank-ack-button"\s+onClick=\{\(\) => setBlankAck\(true\)\}/);
    expect(builder).toMatch(/checked=\{blankAck\}\s+onChange=\{e => setBlankAck\(e\.target\.checked\)\}/);
  });
  it('the order button stays disabled until acknowledged', () => {
    expect(builder).toMatch(/disabled=\{isOverLimit \|\| isCheckingOut \|\| \(needsBlankAck && !blankAck\)/);
  });
  it('the old scroll hint is gone', () => {
    expect(builder).not.toMatch(/blank-ack-needed|blankAckRef|blankAckFlash|blankAckNeeded/);
  });
  it('the two action buttons share one className', () => {
    const nudge = read('client/src/components/book/AddStoryNudge.tsx');
    expect(builder).toMatch(/className=\{BLANK_ACTION_BUTTON_CLASS\}/);
    expect(nudge).toMatch(/className=\{BLANK_ACTION_BUTTON_CLASS\}/);
    expect(nudge).toMatch(/bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1\.5 hover:bg-indigo-600/);
  });
});

describe('single story', () => {
  it('hides the cover note, arrows and badge for one story', () => {
    expect(builder).toMatch(/!isSingleStory && \(\s*<div className="bg-amber-50[\s\S]*?t\.coverNote/);
    expect(builder).toMatch(/!isSingleStory && index === 0/);
    expect(builder).toMatch(/\{!isSingleStory && \(\s*<div className="flex flex-col gap-1">/);
  });
  it('uses the single-story heading and subtitle', () => {
    expect(builder).toMatch(/isSingleStory \? t\.yourStory : t\.storyOrder/);
    expect(builder).toMatch(/isSingleStory \? t\.subtitleSingle : t\.subtitle/);
    for (const s of ['Deine Geschichte', 'Your story', 'Votre histoire', 'La tua storia']) expect(builder).toContain(s);
  });
  it('shows the printed story page count, not the story list count', () => {
    expect(builder).toMatch(/storyPageCounts\[index\]/);
    expect(builder).not.toMatch(/\{story\.pages\} \{t\.pages\}/);
  });
});

describe('mini book box', () => {
  it('uses SQUARE_BOOK_SIZE_LABEL, never a retyped size', () => {
    expect(builder).toMatch(/\$\{SQUARE_BOOK_SIZE_LABEL\}/);
    expect(builder).not.toMatch(/20 × 20 cm/);
  });
  it('spreadNote is deleted and the mini note no longer lives in BookFacingOption', () => {
    const nudge = read('client/src/components/book/AddStoryNudge.tsx');
    expect(nudge).not.toMatch(/spreadNote/);
    expect(read('client/src/components/book/BookFacingOption.tsx')).not.toMatch(/book-mini-note|mini:/);
  });
});

describe('square covers', () => {
  const src = read('client/src/components/book/BookSquareCovers.tsx');
  it('does not display the dedication page or a heading', () => {
    expect(src).toMatch(/COVER_ORDER: CoverKey\[\] = \['frontCover', 'backCover'\]/);
    expect(src).not.toMatch(/dedication:|t\.title/);
  });
});

describe('preview button placement', () => {
  it('sits in the left column before the covers, not next to the order button', () => {
    expect(builder.indexOf('<BookPreviewButton')).toBeGreaterThan(builder.indexOf('<BlankPagesPreview'));
    expect(builder.indexOf('<BookPreviewButton')).toBeLessThan(builder.indexOf('{/* Right: Format & Price */}'));
  });
});

describe('story row thumbnail', () => {
  it('loads the cover itself when My Stories had not loaded it yet', () => {
    expect(builder).toMatch(/filter\(st => !st\.thumbnail\)[\s\S]*?getStoryCover\(st\.id\)/);
  });
});
