import { describe, it, expect, afterEach } from 'vitest';

// Bug cover-pyjamas-in-prose-with-day-label (staging job_1793526073039_9nhq3ju59, 2026-11-01): the back cover's label
// said the day outfit, its prose said "red long-sleeve cotton top and matching red bottoms ... wool socks", and the
// image showed a bodysuit with bare legs outdoors at night. Owner: "Tell Opus too + check text" — Jev decides whether
// a cover's prose dresses each figure in its outfit; a "no" is sent back once. The book review gets the same sentence.
const jev = require('../../server/lib/jevDecisions.js');
const resolve = require('../../server/lib/clothingResolve.js');
const { coverOutfitFindings, COVER_ONLY_TYPES } = require('../../server/lib/briefChecks.js');
const { COVER_OUTFIT_RULE } = require('../../server/lib/clothingCategories.js');
const fs = require('fs');
const path = require('path');

const realJev = jev.decideOutfitsStated;
const realResolve = resolve.resolveSceneClothingDescriptions;
afterEach(() => { jev.decideOutfitsStated = realJev; resolve.resolveSceneClothingDescriptions = realResolve; });

const brief = (prose: string, clothing: Record<string, string>) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({ characters: Object.keys(clothing).map(name => ({ name })), characterClothing: clothing })}`;
const ctx = { inputData: { characters: [{ name: 'Mia' }], artStyle: 'realistic' }, clothingRequirements: {} };
const gl = { errors: [] as any[], error(...a: any[]) { this.errors.push(a); } };

describe('coverOutfitFindings', () => {
  it('a cover whose prose does not dress a figure in its outfit is one re-askable finding with the outfit text', async () => {
    resolve.resolveSceneClothingDescriptions = () => ({ Mia: 'a yellow raincoat over blue jeans and red boots.' });
    let seen: any = null;
    jev.decideOutfitsStated = async (args: any) => { seen = args; return { missing: ['Mia'], stated: [] }; };
    const out = await coverOutfitFindings([
      { pageNumber: -3, brief: brief('Mia in a red top and red bottoms waves under the stars.', { Mia: 'standard' }) },
      { pageNumber: 2, brief: brief('Mia on page two.', { Mia: 'standard' }) },
    ], ctx, gl);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pageNumber: -3, type: 'cover_outfit_not_stated', character: 'Mia' });
    expect(out[0].detail).toContain('a yellow raincoat over blue jeans and red boots.');
    expect(out[0].detail).toContain(COVER_OUTFIT_RULE);
    expect(seen.prose).toBe('Mia in a red top and red bottoms waves under the stars.');
    expect(seen.figures).toEqual([{ name: 'Mia', outfit: 'a yellow raincoat over blue jeans and red boots.' }]);
  });
  it('a cover that states the outfit has none; interior pages are never asked', async () => {
    resolve.resolveSceneClothingDescriptions = () => ({ Mia: 'a yellow raincoat.' });
    let calls = 0;
    jev.decideOutfitsStated = async () => { calls++; return { missing: [], stated: ['Mia'] }; };
    const out = await coverOutfitFindings([
      { pageNumber: -1, brief: brief('Mia in her yellow raincoat.', { Mia: 'standard' }) },
      { pageNumber: 4, brief: brief('x', { Mia: 'standard' }) },
    ], ctx, gl);
    expect(out).toEqual([]);
    expect(calls).toBe(1);
  });
  it('a failed Jev call is logged as an error and leaves that cover unchecked', async () => {
    resolve.resolveSceneClothingDescriptions = () => ({ Mia: 'a yellow raincoat.' });
    jev.decideOutfitsStated = async () => { throw new Error('boom'); };
    const g = { errors: [] as any[], error(...a: any[]) { this.errors.push(a); } };
    expect(await coverOutfitFindings([{ pageNumber: -2, brief: brief('x', { Mia: 'standard' }) }], ctx, g)).toEqual([]);
    expect(g.errors[0][0]).toBe('beats_cover_outfit_check_failed');
  });
  it('is sent to the re-ask, not shipped as a cover-only flag; the recheck is awaited', () => {
    expect(COVER_ONLY_TYPES.has('cover_outfit_not_stated')).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/briefCorrection.js'), 'utf8');
    expect(src).toMatch(/const after = \(await recheck\(out\.text\)\) \|\| \[\];/);
  });
});

describe('the book review reads the same cover outfit sentence', () => {
  it('reviewRulesText fills it in', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '../../prompts/book-review-rules.txt'), 'utf8');
    expect(tpl).toContain('{COVER_OUTFIT_RULE}');
    const { reviewRulesText } = require('../../server/lib/bookAudit.js');
    const { fillTemplate } = require('../../server/services/prompts.js');
    // The review without cast pictures needs its own rule text (cast-reference pictures, decisions 2026-11-13).
    const noRefs = fs.readFileSync(path.join(__dirname, '../../prompts/book-review-no-cast-refs.txt'), 'utf8');
    const text = reviewRulesText({ title: 'Le titre' }, { bookReviewRules: tpl, bookReviewNoCastRefs: noRefs }, fillTemplate);
    expect(text).toContain(COVER_OUTFIT_RULE);
    expect(text).not.toContain('{COVER_OUTFIT_RULE}');
  });
});
