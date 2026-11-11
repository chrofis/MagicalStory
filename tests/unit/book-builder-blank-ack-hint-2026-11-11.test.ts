/**
 * Book order page redesign, 2026-11-11 (customer could not order a 10-page book; owner redesign).
 * Round 2 (same day): either/or choice cards (one shared BlankPagesChoice used twice, one blankAck), covers before
 * 3 open-book spreads, preview hint only for A4, square preview prefetch.
 * - one blankAck state, two controls: option card in the warning box + the SAME card above the order button
 * - single story hides note / arrows / badge; spreadNote deleted; dedication not displayed
 * Round 3 (same day, owner: "page is too long"): the printed-book section is removed, only "Buch ansehen" stays;
 *   no plus icon on the add-story choice card.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toImgSrc } from '../../client/src/utils/imgSrc';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../..', ...p), 'utf8');
const builder = read('client/src/pages/BookBuilder.tsx');

describe('printed-book strip (voucher page still uses it)', () => {
  const src = read('client/src/components/book/BlankPagesPreview.tsx');
  it('keeps an R2 URL as the image source', () => {
    expect(toImgSrc('https://images.magicalstory.ch/x/page1.jpg')).toBe('https://images.magicalstory.ch/x/page1.jpg');
  });
  it('builds its sources with toImgSrc, never by wrapping as base64', () => {
    expect(src).toMatch(/toImgSrc\(/);
    expect(src).not.toMatch(/base64,\$\{/);
  });
});

describe('one blankAck state bound to both controls', () => {
  const choice = read('client/src/components/book/BlankPagesChoice.tsx');
  it('has a single blankAck useState', () => {
    expect((builder.match(/\[blankAck, setBlankAck\]/g) || []).length).toBe(1);
  });
  it('uses ONE shared BlankPagesChoice component twice, both bound to blankAck / setBlankAck', () => {
    const uses = builder.match(/<BlankPagesChoice [^>]*>/g) || [];
    expect(uses.length).toBe(2);
    for (const u of uses) expect(u).toMatch(/blankAck=\{blankAck\} onChange=\{setBlankAck\}/);
    expect(builder).not.toMatch(/checked=\{blankAck\}/);
    expect(builder).not.toMatch(/t\.blankAck\b|agreeBlank/);
  });
  it('the choice is a radiogroup of radio cards with aria-checked, indigo when selected', () => {
    expect(builder).toMatch(/role="radiogroup"/);
    expect(choice).toMatch(/role="radio"/);
    expect(choice).toMatch(/aria-checked=\{checked\}/);
    expect(choice).toMatch(/checked \? 'border-indigo-500' : 'border-gray-300/);
    expect(choice).toMatch(/\{checked && <span className="h-2\.5 w-2\.5 rounded-full bg-indigo-500"/);
  });
  it('selecting the blank card sets blankAck true', () => {
    expect(choice).toMatch(/onSelect=\{\(\) => onChange\(true\)\}/);
  });
  it('the add-story card is an unselected card of the same ChoiceCard and runs handleAddStory', () => {
    const nudge = read('client/src/components/book/AddStoryNudge.tsx');
    expect(nudge).toMatch(/<ChoiceCard checked=\{false\} onSelect=\{onAdd\}/);
    expect(builder).toMatch(/<AddStoryNudge asChoice [^>]*onAdd=\{handleAddStory\}/);
  });
  it('the order button stays disabled until acknowledged', () => {
    expect(builder).toMatch(/disabled=\{isOverLimit \|\| isCheckingOut \|\| \(needsBlankAck && !blankAck\)/);
  });
  it('the old scroll hint is gone', () => {
    expect(builder).not.toMatch(/blank-ack-needed|blankAckRef|blankAckFlash|blankAckNeeded/);
  });
  it('the blank-pages wording names no printer, comes from the page info and is in all 4 languages', () => {
    expect(builder).not.toMatch(/Druckerei|imprimerie|tipografia|printer prints/i);
    expect((builder.match(/blankLine: \(p: number/g) || []).length).toBe(4);
    expect((builder.match(/printBlank: \(b: number\)/g) || []).length).toBe(4);
    expect(builder).toMatch(/t\.blankLine\(pageInfo\.printedPages, pageInfo\.contentPages, pageInfo\.blankPages/);
    expect(builder).toContain('Ein Buch hat mindestens ${p} Seiten.');
    expect(builder).toContain('Mit ${b} leeren Seiten drucken');
    expect(builder).not.toMatch(/ß/);
  });
});

describe('no printed-book section (owner 2026-11-11: page too long, "Buch ansehen" shows the book)', () => {
  it('the section and its helpers are deleted', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../client/src/components/book/PrintedBookSpreads.tsx'))).toBe(false);
    expect(fs.existsSync(path.resolve(__dirname, '../../client/src/utils/printedSpreads.ts'))).toBe(false);
    expect(builder).not.toMatch(/PrintedBookSpreads|blankPreviewTitle|Dein gedrucktes Buch|squareDedications/);
  });
  it('square covers are still made (order waits) and the preview button is shown', () => {
    expect(builder).toMatch(/<BookSquareCovers [^>]*onReadyChange=\{setSquareCoversReady\} showImages=\{false\} \/>/);
    expect(builder).toMatch(/<BookPreviewButton language=\{language\}/);
  });
  it('the add-story choice card has no plus icon', () => {
    const nudge = read('client/src/components/book/AddStoryNudge.tsx');
    expect(nudge).toMatch(/testId="add-story-nudge">\{text\}<\/ChoiceCard>/);
  });
});

describe('preview hint and prefetch', () => {
  const btn = read('client/src/components/book/BookPreviewButton.tsx');
  it('the slow-preview hint shows for A4 only', () => {
    expect(btn).toMatch(/layout !== 'spread' && <p[^>]*>\{HINT\[l\]\}<\/p>/);
  });
  it('a square preview is requested in the background once, never for A4', () => {
    expect(builder).toMatch(/if \(previewLayout !== 'spread' \|\| !storyIdsKey\) return;/);
    expect(builder).toMatch(/requestBookPreview\(storyIdsKey\.split\(','\), 'spread', coverType, false\)\s*\.catch\(err => log\.error/);
    expect((builder.match(/requestBookPreview\(/g) || []).length).toBe(1);
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
  it('spreadNote is deleted and BookFacingOption (hidden more-options link) is deleted', () => {
    const nudge = read('client/src/components/book/AddStoryNudge.tsx');
    expect(nudge).not.toMatch(/spreadNote/);
    expect(fs.existsSync(path.resolve(__dirname, '../../client/src/components/book/BookFacingOption.tsx'))).toBe(false);
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
  it('sits in the left column, not next to the order button', () => {
    expect(builder.indexOf('<BookPreviewButton')).toBeGreaterThan(builder.indexOf('{/* Printed book, shown the same way in every case'));
    expect(builder.indexOf('<BookPreviewButton')).toBeLessThan(builder.indexOf('{/* Right: Format & Price */}'));
  });
});

describe('story row thumbnail', () => {
  it('loads the cover itself when My Stories had not loaded it yet', () => {
    expect(builder).toMatch(/filter\(st => !st\.thumbnail\)[\s\S]*?getStoryCover\(st\.id\)/);
  });
});
