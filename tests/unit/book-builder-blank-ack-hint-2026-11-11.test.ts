/**
 * Book order page, 2026-11-11 (customer could not order a 10-page book):
 * 1. The order button stays grey until the blank pages are confirmed, and nothing near the button said why.
 *    A hint under the button now names the reason and jumps to the tick box.
 * 2. The printed-book strip showed broken thumbnails: it wrapped R2 image URLs as base64 data URIs.
 *    It now uses the shared toImgSrc helper, which passes URLs through.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { toImgSrc } from '../../client/src/utils/imgSrc';

const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../..', ...p), 'utf8');

describe('printed-book strip thumbnails', () => {
  it('keeps an R2 URL as the image source', () => {
    expect(toImgSrc('https://images.magicalstory.ch/x/page1.jpg')).toBe('https://images.magicalstory.ch/x/page1.jpg');
  });
  it('BlankPagesPreview builds its sources with toImgSrc, never by wrapping as base64', () => {
    const src = read('client/src/components/book/BlankPagesPreview.tsx');
    expect(src).toMatch(/toImgSrc\(/);
    expect(src).not.toMatch(/base64,\$\{/);
  });
});

describe('order button explains why it is off', () => {
  const src = read('client/src/pages/BookBuilder.tsx');
  it('shows the hint exactly while the blank pages are unconfirmed', () => {
    expect(src).toMatch(/needsBlankAck && !blankAck && pageInfo && !isOverLimit && \(\s*<button[\s\S]*?data-testid="blank-ack-needed"/);
  });
  it('the hint jumps to the tick box', () => {
    expect(src).toMatch(/ref=\{blankAckRef\}/);
    expect(src).toMatch(/blankAckRef\.current\?\.scrollIntoView/);
  });
  it('has the hint text in all four languages', () => {
    expect((src.match(/blankAckNeeded: \(b: number\) =>/g) || []).length).toBe(4);
  });
});
