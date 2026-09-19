import { describe, it, expect, vi } from 'vitest';

const {
  parseWornItems, carryForwardWornItems, resolveWornItemsForPage,
} = require('../../server/lib/wornItems');
const { buildRedressPrompt } = require('../../server/lib/character2x4Sheet');
const { pickAuthoredNote } = require('../../server/lib/wardrobeVariants');

/**
 * THE ART DIRECTOR AUTHORS THE WARDROBE HALF (owner, 2026-09-19).
 *
 * The stage that holds the outfit contract, the garment, the slot and the exact
 * off-combination writes the wardrobe instruction; code keeps only the
 * sheet-mechanics scaffold. These pin the BEHAVIOUR — that the authored text
 * survives parsing and a rewrite, that one off-set picks one instruction
 * deterministically, and that an absent one falls back to the mechanical
 * builder — never any prompt wording.
 */

const NOTE = 'The character keeps the red cap, the navy trousers and the brown boots exactly as the sheet draws them. '
  + 'The green jacket is off, with nothing in its place. The long-sleeved white cotton shirt is now the outer garment on the torso.';

describe('redressNote survives the row pipeline', () => {
  it('parses off a declared row', () => {
    const [row] = parseWornItems([{ id: 'clo002', owner: 'A', state: 'off', location: 'on a hook', redressNote: NOTE }]);
    expect(row.redressNote).toBe(NOTE);
  });

  it('is null when the brief authored none', () => {
    const [row] = parseWornItems([{ id: 'CLO002', owner: 'A', state: 'off', location: 'on a hook' }]);
    expect(row.redressNote).toBeNull();
  });

  it('reaches the resolved row the variant derivation reads', () => {
    const vb = { clothing: [{ id: 'CLO002', name: 'green jacket', type: 'outer layer', wornAs: 'A.outer layer', wornBy: 'A' }] };
    const meta = { characters: ['A'], wornItems: [{ id: 'CLO002', owner: 'A', state: 'off', location: 'on a hook', redressNote: NOTE }] };
    const resolved = resolveWornItemsForPage(vb, ['A'], meta, { pageNumber: 6 });
    const r = resolved.find((x: any) => x.id === 'CLO002');
    expect(r.state).toBe('off');
    expect(r.redressNote).toBe(NOTE);
  });

  it('survives an iterate rewrite that re-states the row without the field', () => {
    const saved = { wornItems: [{ id: 'CLO002', owner: 'A', state: 'off', location: 'on a hook', redressNote: NOTE }] };
    const rewritten = { wornItems: [{ id: 'CLO002', owner: 'A', state: 'off', location: 'over a chair' }] };
    const carried = carryForwardWornItems(rewritten, saved);
    expect(carried[0].location).toBe('over a chair');   // the rewrite still owns the state
    expect(carried[0].redressNote).toBe(NOTE);          // and does not delete the instruction
  });

  it('lets a rewrite that authors its own note replace it', () => {
    const saved = { wornItems: [{ id: 'CLO002', owner: 'A', state: 'off', redressNote: NOTE }] };
    const rewritten = { wornItems: [{ id: 'CLO002', owner: 'A', state: 'off', redressNote: 'a different instruction' }] };
    expect(carryForwardWornItems(rewritten, saved)[0].redressNote).toBe('a different instruction');
  });
});

describe('one authored instruction per off-set', () => {
  it('picks the lowest page number that authored one, whatever the arrival order', () => {
    const notes = [
      { pageNumber: 11, note: NOTE },
      { pageNumber: 6, note: NOTE },
      { pageNumber: 9, note: NOTE },
    ];
    expect(pickAuthoredNote(notes, 'A off:CLO002')).toBe(NOTE);
    expect(pickAuthoredNote([...notes].reverse(), 'A off:CLO002')).toBe(NOTE);
  });

  it('is null when no page authored one', () => {
    expect(pickAuthoredNote([{ pageNumber: 6, note: '   ' }], 'x')).toBeNull();
    expect(pickAuthoredNote([], 'x')).toBeNull();
  });

  it('does not warn when the wordings differ only in whitespace and punctuation', () => {
    const { log } = require('../../server/utils/logger');
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    pickAuthoredNote([{ pageNumber: 6, note: NOTE }, { pageNumber: 7, note: `  ${NOTE.toUpperCase()}  ` }], 'x');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('warns loudly, naming the off-set and every page, when the pages disagree materially', () => {
    const { log } = require('../../server/utils/logger');
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const picked = pickAuthoredNote(
      [{ pageNumber: 9, note: 'the jacket is off' }, { pageNumber: 6, note: NOTE }],
      'CharacterA off:CLO002',
    );
    expect(picked).toBe(NOTE);                       // the pick is still deterministic
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0][0]);
    expect(msg).toContain('CharacterA off:CLO002');
    expect(msg).toContain('6');
    expect(msg).toContain('9');
    spy.mockRestore();
  });
});

describe('the assembled prompt = scaffold + wardrobe half', () => {
  const scaffold = (p: string) => {
    expect(p).toMatch(/2×4 character reference sheet \(8 cells\)/);
    expect(p).toMatch(/Image 1 is the only authority/i);
    expect(p).toMatch(/facing the viewer/i);
    expect(p).toMatch(/turned away/i);
    expect(p).toMatch(/rather than uncover/i);
    for (const inv of ['same face', 'same hair', 'same body', 'same poses', 'same cell layout', 'same art style']) {
      expect(p.toLowerCase()).toContain(inv);
    }
  };

  it('wraps the authored half verbatim in the scaffold', () => {
    const p = buildRedressPrompt(NOTE);
    scaffold(p);
    expect(p).toContain(NOTE);
  });

  it('carries only the words the Art Director wrote — no contract adjective reaches it', () => {
    const p = buildRedressPrompt(NOTE).toLowerCase();
    for (const word of ['chunky-knit', 'corduroy', 'folded cuff', 'lace-up', 'straight-leg']) {
      expect(p).not.toContain(word);
    }
  });

  it('THROWS rather than derive a wardrobe half of its own', () => {
    // There is exactly one implementation of this instruction. A missing one is
    // an error, never a cue to fall back to string surgery on the contract.
    for (const absent of [null, undefined, '', '   ']) {
      expect(() => buildRedressPrompt(absent as any)).toThrow(/authored wardrobe instruction/i);
    }
  });

  it('no stripping machinery is reachable from the redress path any more', () => {
    const fs = require('fs');
    const src = fs.readFileSync('server/lib/character2x4Sheet.js', 'utf8');
    for (const gone of ['splitClausesDetailed', 'shortGarmentLabel', 'headIsUnderLayer', 'resolvedOutfit']) {
      expect(src).not.toContain(gone);
    }
    const worn = require('../../server/lib/wornItems');
    expect(worn.shortGarmentLabel).toBeUndefined();
    expect(worn.headIsUnderLayer).toBeUndefined();
  });
});
