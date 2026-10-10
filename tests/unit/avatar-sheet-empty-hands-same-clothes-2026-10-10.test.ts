/**
 * Owner's iPhone trial (staging user 10e1d43c, 2026-10-10): the standard sheet's body cells held the pink hoop the photo
 * cut-out shows, and the head cells wore denim overalls while the body wore the photo's hoodie. Every sheet prompt now
 * says "empty hands", and the head row is always drawn against the body row with an explicit same-clothes rule.
 * docs/decisions.md 2026-10-10.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const sheet = require('../../server/lib/character2x4Sheet.js');
const { buildOneCallSheetPrompt } = sheet;
const ROOT = path.join(__dirname, '../..');
const EMPTY = /Empty hands: nothing is held or carried in any cell, and no bag or backpack is worn/;
const kid = { name: 'A', age: 8, gender: 'male' };
const P = (o: any = {}) => buildOneCallSheetPrompt(kid, { costumeDescription: 'standard outfit', styleLine: 'watercolour', kind: 'standard', ...o });

describe('empty hands reaches the sheet prompt', () => {
  it('standard, costume and seasonal sheets, with and without a body reference', () => {
    expect(P()).toMatch(EMPTY);
    expect(P({ kind: 'costume', costumeDescription: 'red bodysuit', costumeName: 'superhero' })).toMatch(EMPTY);
    expect(P({ seasonOutfit: { label: 'Autumn', outfit: 'a jumper', footwear: 'boots' } })).toMatch(EMPTY);
    expect(P({ hasReference: true })).toMatch(EMPTY);
  });
  it('the standard sheet names the body reference as clothing and build only, and drops hoop, toy and backpack', () => {
    const p = P({ hasReference: true });
    expect(p).toMatch(/take its CLOTHING and build only/);
    expect(p).toMatch(/hoop/);
    expect(p).toMatch(/backpack/);
  });
  it('a costume sheet takes the body reference build only and ignores its clothes', () => {
    expect(P({ kind: 'costume', hasReference: true })).toMatch(/take its build only\. IGNORE its clothing/);
  });
  it('the full-story avatar template keeps its no-carried-items rule', () => {
    expect(fs.readFileSync(path.join(ROOT, 'prompts/avatar-main-prompt.txt'), 'utf8')).toMatch(/No carried items/);
  });
  it('a costume-named item stays allowed', () => {
    expect(P({ kind: 'costume', costumeDescription: 'tweed jacket, brass magnifying glass', costumeName: 'detective' })).toMatch(/only an item the costume text names stays/);
  });
});

describe('head and body wear the same clothes', () => {
  it('one call draws both rows: the top row wears the neckline the body below wears', () => {
    expect(P()).toMatch(/the neckline in the top row is the one the body below wears/);
  });
});
