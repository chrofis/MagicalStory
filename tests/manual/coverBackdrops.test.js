/**
 * Cover backdrop allocation (server/lib/outlineParser/unified.js).
 *
 * Every cover gets a real landmark and no two covers share one (owner,
 * 2026-08-21). The previous rule enforced one backdrop PER cover but never that
 * the three differ: on production story job_1787262655143_s9zb960muni the title
 * page and the initial page both took LOC004 while LOC005 — a second real
 * landmark — sat unused, and the two covers rendered as near-duplicates.
 *
 * This is the BACKSTOP only. The writer picks each backdrop for story fit and
 * the prompt asks for three different real landmarks; code repairs collisions.
 *
 * The parser class pulls the world in, so the allocation block is sliced out of
 * the real source and run against stubs — same technique as the other slice
 * tests here.
 *
 * Run: node tests/manual/coverBackdrops.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); console.log(`  ✓ ${msg}`); passed++; };
const ok = (c, msg) => { assert.ok(c, msg); console.log(`  ✓ ${msg}`); passed++; };

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/outlineParser/unified.js'), 'utf8').replace(/\r\n/g, '\n');
const from = SRC.indexOf('    const isLoc = (id) => /^LOC\\d+/i.test(id);');
const END = '\n\n    log.debug(`[UNIFIED-PARSER] Cover hints extracted';
const to = SRC.indexOf(END, from);
assert.ok(from !== -1 && to !== -1, 'could not slice the backdrop allocator');
const BLOCK = SRC.slice(from, to);

/** Run the real allocator over stub cover hints + locations. */
function allocate(locations, coverHints) {
  const log = { info: () => {}, warn: () => {}, debug: () => {} };
  const locs = locations;
  const realLandmarkIds = locs.filter(l => l.isRealLandmark).map(l => l.id.toUpperCase());
  // The sliced block reads `this._cache.coverHints`, so bind a stand-in parser.
  const self = { _cache: { coverHints } };
  const fn = new Function('log', 'locs', 'realLandmarkIds', BLOCK + '\nreturn this._cache.coverHints;');
  return fn.call(self, log, locs, realLandmarkIds);
}

const cover = (objects) => ({ objects: [...objects] });
const backdropOf = (c) => c.objects[0];

console.log('\nthe production regression: two covers took the same landmark');
{
  // Exactly job_1787262655143_s9zb960muni: LOC004 twice, LOC005 unused.
  const locations = [
    { id: 'LOC001', isRealLandmark: false }, { id: 'LOC002', isRealLandmark: false },
    { id: 'LOC003', isRealLandmark: false }, { id: 'LOC004', isRealLandmark: true },
    { id: 'LOC005', isRealLandmark: true },
  ];
  const out = allocate(locations, {
    titlePage: cover(['LOC004', 'ART001', 'ANI001']),
    initialPage: cover(['LOC004', 'ART005']),
    backCover: cover(['LOC001', 'ART001']),
  });
  eq(backdropOf(out.titlePage), 'LOC004', 'title page keeps the writer\'s real landmark');
  eq(backdropOf(out.initialPage), 'LOC005', 'initial page moves off the duplicate to the unused real landmark');
  ok(backdropOf(out.backCover) !== backdropOf(out.titlePage)
     && backdropOf(out.backCover) !== backdropOf(out.initialPage), 'back cover differs from both');
  ok(out.titlePage.objects.includes('ART001') && out.titlePage.objects.includes('ANI001'),
     'non-LOC objects are preserved');
}

console.log('\nevery cover gets a REAL landmark when enough exist');
{
  const locations = [
    { id: 'LOC001', isRealLandmark: false },
    { id: 'LOC002', isRealLandmark: true }, { id: 'LOC003', isRealLandmark: true },
    { id: 'LOC004', isRealLandmark: true },
  ];
  const out = allocate(locations, {
    titlePage: cover(['LOC001']),      // writer chose an invented one
    initialPage: cover(['LOC001']),    // and again
    backCover: cover(['LOC001']),      // and again
  });
  const picks = ['titlePage', 'initialPage', 'backCover'].map(k => backdropOf(out[k]));
  ok(picks.every(p => ['LOC002', 'LOC003', 'LOC004'].includes(p)), `all three are real landmarks (${picks.join(', ')})`);
  eq(new Set(picks).size, 3, 'all three are distinct');
}

console.log('\nscarcity: fewer real landmarks than covers');
{
  const locations = [
    { id: 'LOC001', isRealLandmark: false }, { id: 'LOC002', isRealLandmark: false },
    { id: 'LOC003', isRealLandmark: true },
  ];
  const out = allocate(locations, {
    titlePage: cover(['LOC001']), initialPage: cover(['LOC002']), backCover: cover(['LOC001']),
  });
  const picks = ['titlePage', 'initialPage', 'backCover'].map(k => backdropOf(out[k]));
  eq(picks[0], 'LOC003', 'the one real landmark goes to the title page');
  eq(new Set(picks).size, 3, `still three distinct backdrops (${picks.join(', ')})`);
}

console.log('\nvantage suffixes and hygiene');
{
  const locations = [{ id: 'LOC001', isRealLandmark: true }, { id: 'LOC002', isRealLandmark: true }];
  const out = allocate(locations, {
    titlePage: cover(['LOC001.2', 'ART001']),
    initialPage: cover(['LOC001.3']),   // same base landmark, different vantage
    backCover: cover(['LOC002']),
  });
  eq(backdropOf(out.titlePage), 'LOC001.2', 'a dotted vantage is kept as written');
  ok(String(backdropOf(out.initialPage)).split('.')[0] !== 'LOC001',
     'a different VANTAGE of the same landmark still counts as a duplicate');
}

console.log('\nonly one LOC survives per cover');
{
  const locations = [{ id: 'LOC001', isRealLandmark: true }, { id: 'LOC002', isRealLandmark: true }, { id: 'LOC003', isRealLandmark: true }];
  const out = allocate(locations, {
    titlePage: cover(['LOC001', 'LOC002', 'ART001']),
    initialPage: cover(['LOC003']), backCover: cover(['LOC002']),
  });
  eq(out.titlePage.objects.filter(o => /^LOC/.test(o)).length, 1, 'the extra backdrop is dropped');
  eq(out.titlePage.objects[0], 'LOC001', 'the backdrop leads the objects list');
}

console.log(`\n✅ ALL ${passed} assertions passed (cover backdrop allocation)\n`);
