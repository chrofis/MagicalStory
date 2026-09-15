/**
 * #35 — an array is a DECLARATION, null is UNKNOWN.
 *
 * The distinction became load-bearing on 2026-09-11, when `buildExpectedCastBlock`
 * started reading it (D6): a DECLARED empty roster means "this frame was written
 * with no people in it, so every person present is a surplus figure", while an
 * ABSENT one means "no roster supplied, do not judge the figure count". Confusing
 * the two turns every commissioned child on a page into a CRITICAL
 * `extra_character`.
 *
 * Three sites in repairPipeline expressed it with `||`, which is the one JS idiom
 * that cannot: `[]` is truthy.
 *   :409  `entry.sceneCharacters || orig.sceneCharacters`  — feeds the evaluator
 *   :1632 `r.sceneCharacters || orig?.sceneCharacters || []`
 *   :3362 `v.sceneCharacters || null`  — the version WRITE site, which does NOT
 *         normalise an empty array away either, for the same reason
 *
 * Nothing writes `[]` today, so the trap was unsprung — it was one careless
 * writer from firing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
import repairLogic from '../../server/lib/repairLogic.js';
const { resolveDeclaredCast } = repairLogic as any;

const PAGE = [{ name: 'A' }, { name: 'B' }];

describe('resolveDeclaredCast', () => {
  it('a DECLARED empty cast wins over the page roster', () => {
    // A version's own rewrite may legitimately empty the cast (iterate rewrites
    // the scene). That is a declaration and it is honoured — deliberately now,
    // rather than as a side effect of `[]` being truthy.
    expect(resolveDeclaredCast([], PAGE)).toEqual([]);
  });

  it('an ABSENT cast falls through to the next source', () => {
    expect(resolveDeclaredCast(null, PAGE)).toEqual(PAGE);
    expect(resolveDeclaredCast(undefined, PAGE)).toEqual(PAGE);
  });

  it('nothing declared anywhere is null, never an empty array', () => {
    // null and [] mean different things downstream, so the "unknown" answer must
    // not arrive dressed as "declared empty".
    expect(resolveDeclaredCast(undefined, undefined)).toBeNull();
    expect(resolveDeclaredCast()).toBeNull();
  });

  it('ignores non-array junk rather than treating it as a cast', () => {
    expect(resolveDeclaredCast('Levin', PAGE)).toEqual(PAGE);
    expect(resolveDeclaredCast(0, PAGE)).toEqual(PAGE);
    expect(resolveDeclaredCast({ name: 'Levin' }, PAGE)).toEqual(PAGE);
  });

  it('takes the FIRST declaration, most specific first', () => {
    const version = [{ name: 'C' }];
    expect(resolveDeclaredCast(version, PAGE)).toEqual(version);
  });
});

describe('every site uses the one contract, not `||`', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/repairPipeline.js'), 'utf8');

  it('the eval-input site resolves rather than coalesces', () => {
    expect(src).toMatch(/sceneCharacters: resolveDeclaredCast\(entry\.sceneCharacters, orig\.sceneCharacters\)/);
    expect(src).not.toMatch(/sceneCharacters: entry\.sceneCharacters \|\| orig\.sceneCharacters/);
  });

  it('the redetect site resolves rather than coalesces', () => {
    expect(src).toMatch(/resolveDeclaredCast\(r\.sceneCharacters, orig\?\.sceneCharacters\)/);
    expect(src).not.toMatch(/r\.sceneCharacters \|\| orig\?\.sceneCharacters/);
  });

  it('the version WRITE site resolves rather than coalescing to null', () => {
    // `v.sceneCharacters || null` leaves an empty array intact — it is truthy —
    // so a version could ship `[]` and override the page's real cast downstream.
    expect(src).toMatch(/sceneCharacters: resolveDeclaredCast\(v\.sceneCharacters\)/);
    expect(src).not.toMatch(/sceneCharacters: v\.sceneCharacters \|\| null/);
  });
});
