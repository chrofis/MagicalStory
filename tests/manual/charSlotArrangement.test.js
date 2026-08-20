/**
 * Reference-slot layout chooser (server/lib/grok.js → chooseCardArrangement).
 *
 * Guards the fix for staging job_1787252581387_6sn8z0nh2, whose A4 back cover
 * packed three characters as "2 on top, 1 below" and rendered each of them
 * 138px wide inside a 768x1024 slot (25.8% ink). The arrangement had been
 * hardcoded per (character count, target aspect) for an input shape that has
 * since changed: cropAvatarCell now feeds ~1:3.7 head-over-body strips, and
 * stacking two rows of those makes a ~1:7 composite that must be crushed to fit.
 *
 * The chooser must satisfy BOTH book layouts (owner, 2026-08-20):
 *   - A4 / portrait 3:4
 *   - square 1:1
 * and must not regress if the input ever returns to square 2x4 sheets, where
 * three-across would be 3:1 and stacking genuinely wins.
 *
 * Pure arithmetic on card dimensions — no image work, no network.
 *
 * Run: node tests/manual/charSlotArrangement.test.js
 */

'use strict';

const assert = require('assert');
const { chooseCardArrangement } = require('../../server/lib/grok');

let passed = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); console.log(`  ✓ ${msg}`); passed++; };
const ok = (c, msg) => { assert.ok(c, msg); console.log(`  ✓ ${msg}`); passed++; };

const A4 = 3 / 4;      // 0.75 portrait
const SQUARE = 1;
// Real strip sizes from the staging story (Emma / Noah / Daniel).
const CELL = [{ width: 284, height: 1024 }, { width: 270, height: 1024 }, { width: 278, height: 1024 }];
// Styled 2x4 reference sheets, the other input shape this function must serve.
const SHEET = n => Array.from({ length: n }, () => ({ width: 1024, height: 1024 }));

console.log('\ntall cell strips (~1:3.7) — the production input');
{
  const a4 = chooseCardArrangement(CELL, A4);
  eq(a4.cols, 3, 'A4: all three on ONE row (was 2-on-top-1-below)');
  const sq = chooseCardArrangement(CELL, SQUARE);
  eq(sq.cols, 3, 'square: one row too');
  ok(a4.scale > 0.8, `A4 scale ${a4.scale.toFixed(3)} — each character stays large`);
  // The regression this test exists for: the old hardcoded portrait branch.
  const stacked = chooseCardArrangement(CELL, A4);
  ok(stacked.cols !== 2, 'A4 never picks the 2-column stack for tall strips');
}

console.log('\nthe chooser beats the old hardcoded rule, measurably');
{
  // Reproduce what 2-on-top-1-below would have scored, and assert the winner
  // is strictly better. cols=2 IS that arrangement for n=3.
  const all = [1, 2, 3].map(cols => {
    let totalH = 0, maxW = 0;
    const rowCount = Math.ceil(3 / cols);
    for (let i = 0; i < 3; i += cols) {
      const row = CELL.slice(i, i + cols);
      const rowH = Math.max(...row.map(m => m.height));
      const rowW = row.reduce((a, m) => a + Math.round(m.width * rowH / m.height), 0) + 4 * (row.length - 1);
      totalH += rowH; maxW = Math.max(maxW, rowW);
    }
    totalH += 4 * (rowCount - 1);
    return { cols, scale: 1024 / Math.max(totalH, maxW / A4) };
  });
  const chosen = chooseCardArrangement(CELL, A4);
  const old = all.find(c => c.cols === 2);
  ok(chosen.scale > old.scale * 1.6, `chosen scale ${chosen.scale.toFixed(3)} vs old 2-col ${old.scale.toFixed(3)} — >1.6x larger`);
  ok(all.every(c => chosen.scale >= c.scale), 'chosen arrangement is the maximum over all column counts');
}

console.log('\nsquare 2x4 sheets — the other input shape must NOT regress');
{
  const a4 = chooseCardArrangement(SHEET(3), A4);
  eq(a4.cols, 2, 'A4 + square sheets: stacking still wins (3-across would be 3:1)');
  // Two square cards at a square target tie exactly — same bounding box either
  // way. The tie-break must pick the row, which is what this did historically.
  const sq = chooseCardArrangement(SHEET(2), SQUARE);
  eq(sq.cols, 2, 'square target + 2 square sheets: ties break to side by side');
  const a42 = chooseCardArrangement(SHEET(2), A4);
  eq(a42.cols, 1, 'A4 + 2 square sheets: one per row (stacking genuinely wins)');
}

console.log('\nno character count is unsupported (the old n>3 silent drop)');
{
  for (const n of [4, 5, 6, 7, 8]) {
    const r = chooseCardArrangement(CELL.concat(Array.from({ length: n - 3 }, () => ({ width: 275, height: 1024 }))), A4);
    ok(r && r.cols >= 1 && r.cols <= n, `n=${n} resolves to a real arrangement (cols=${r.cols})`);
  }
}

console.log('\nedge cases');
{
  const one = chooseCardArrangement([{ width: 284, height: 1024 }], A4);
  eq(one.cols, 1, 'single card → single column');
  const mixed = chooseCardArrangement([{ width: 1024, height: 1024 }, { width: 284, height: 1024 }], SQUARE);
  ok(mixed.cols >= 1, 'mixed card shapes still resolve');
  ok(chooseCardArrangement(CELL, A4).scale > 0, 'scale is always positive');
}

console.log(`\n✅ ALL ${passed} assertions passed (reference-slot arrangement: A4 + square)\n`);
