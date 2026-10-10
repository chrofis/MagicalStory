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
const { buildBodyRowPrompt, buildHeadRowPrompt, buildStyleTransferPrompt } = sheet;
const ROOT = path.join(__dirname, '../..');
const EMPTY = /Empty hands: nothing is held or carried in any cell, and no bag or backpack is worn/;
const kid = { name: 'A', age: 8, gender: 'male' };

describe('empty hands reaches every sheet prompt', () => {
  it('body row: standard, costumed (redress) and seasonal', () => {
    for (const [desc, redress, name] of [['standard outfit', false, null], ['red bodysuit', true, 'superhero']] as const) {
      const p = buildBodyRowPrompt(desc, kid, redress, name, null);
      expect(p).toMatch(EMPTY);
    }
    expect(buildBodyRowPrompt('standard outfit', kid, false, null, { label: 'Autumn', outfit: 'a jumper', footwear: 'boots' })).toMatch(EMPTY);
  });
  it('body row: the standard prompt names Image 2 as clothing only and drops hoop, toy and backpack', () => {
    const p = buildBodyRowPrompt('standard outfit', kid, false, null, null);
    expect(p).toMatch(/take its CLOTHING ONLY/);
    expect(p).toMatch(/hoop/);
    expect(p).toMatch(/backpack/);
  });
  it('head row and style transfer', () => {
    expect(buildHeadRowPrompt(kid, 'standard outfit', false)).toMatch(EMPTY);
    expect(buildHeadRowPrompt(kid, 'red bodysuit', true)).toMatch(EMPTY);
    expect(buildStyleTransferPrompt('watercolor')).toMatch(EMPTY);
  });
  it('the full-story avatar template keeps its no-carried-items rule', () => {
    expect(fs.readFileSync(path.join(ROOT, 'prompts/avatar-main-prompt.txt'), 'utf8')).toMatch(/No carried items/);
  });
  it('a costume-named item stays allowed', () => {
    expect(buildBodyRowPrompt('tweed jacket, brass magnifying glass', kid, true, 'detective', null)).toMatch(/only an item the costume text names stays/);
  });
});

describe('head and body wear the same clothes', () => {
  it('standard and costumed head rows both bind the neckline, emblem and print to Image 3', () => {
    for (const redress of [false, true]) {
      const p = buildHeadRowPrompt(kid, 'standard outfit', redress);
      expect(p).toMatch(/clothing at the neck and shoulders is EXACTLY what Image 3 wears/);
      expect(p).toMatch(/no other garment drawn/);
    }
  });
  it('the head row is always drawn with the body row as Image 3', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/character2x4Sheet.js'), 'utf8');
    expect(src).toContain('const headRefs = [headPhantom, facePhoto, bodyRow];');
    expect(src).not.toMatch(/parallelRows/);
  });
});
