#!/usr/bin/env node
/**
 * Measure head:body ratio of a phantom reference sheet by extracting the
 * bottom-left cell (the front-view full-body figure) and running
 * neck-detection.
 *
 * Usage:
 *   node scripts/measure-phantom-ratios.js <path-to-phantom.png> [...more paths]
 */

'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function measure(filePath) {
  const meta = await sharp(filePath).metadata();
  const W = meta.width, H = meta.height;
  // Bottom-left cell: left=0, top=H/2, width=W/4, height=H/2
  const cellW = Math.floor(W / 4);
  const cellH = Math.floor(H / 2);
  const cellTop = Math.floor(H / 2);
  const { data, info } = await sharp(filePath)
    .extract({ left: 0, top: cellTop, width: cellW, height: cellH })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height;
  // Threshold: anything <220 in greyscale = figure pixel
  const isFigure = (x, y) => data[y * w + x] < 220;

  // Per-row figure pixel count + leftmost/rightmost figure col
  const rowSpan = new Array(h).fill(0);   // rightmost - leftmost + 1, 0 if no figure
  const rowCount = new Array(h).fill(0);  // count of figure pixels
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1, cnt = 0;
    for (let x = 0; x < w; x++) {
      if (isFigure(x, y)) {
        if (lo < 0) lo = x;
        hi = x;
        cnt++;
      }
    }
    rowSpan[y] = lo < 0 ? 0 : hi - lo + 1;
    rowCount[y] = cnt;
  }

  // Top-most and bottom-most figure rows = figure height
  let top = -1, bot = -1;
  for (let y = 0; y < h; y++) if (rowCount[y] > 5) { top = y; break; }
  for (let y = h - 1; y >= 0; y--) if (rowCount[y] > 5) { bot = y; break; }
  if (top < 0 || bot < 0) return { path: filePath, error: 'no figure detected' };
  const figH = bot - top + 1;

  // Find neck: scan from top through upper third looking for the narrowest
  // row (after the head's widest point) — the dip from head to body.
  const upperEnd = top + Math.floor(figH / 3);
  // First, find widest row in upper sixth (= head's widest point)
  const headRegionEnd = top + Math.floor(figH / 6);
  let headMaxSpan = 0, headMaxRow = top;
  for (let y = top; y <= headRegionEnd; y++) {
    if (rowSpan[y] > headMaxSpan) { headMaxSpan = rowSpan[y]; headMaxRow = y; }
  }
  // After head widest row, find narrowest row before upperEnd = neck
  let neckRow = headMaxRow, neckSpan = rowSpan[headMaxRow];
  for (let y = headMaxRow + 1; y <= upperEnd; y++) {
    if (rowSpan[y] > 0 && rowSpan[y] < neckSpan) {
      neckSpan = rowSpan[y];
      neckRow = y;
    }
  }
  const headH = neckRow - top + 1;
  const ratio = figH / headH;

  return {
    path: filePath,
    W: w, H: h,
    figTop: top, figBot: bot, figH,
    headMaxRow, headMaxSpan,
    neckRow, neckSpan,
    headH,
    ratio: Number(ratio.toFixed(2)),
  };
}

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: measure-phantom-ratios.js <path> [...]'); process.exit(1); }
  for (const f of files) {
    try {
      const r = await measure(f);
      console.log(JSON.stringify(r, null, 2));
    } catch (err) {
      console.error(`${f}: ${err.message}`);
    }
  }
})();
