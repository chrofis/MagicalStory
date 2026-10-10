import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * Test Lab stage avatar_sheet_variant threads options into the REAL sheet code (docs/decisions.md 2026-10-10 "avatar sheet variants").
 * Every option defaults to the production value, so the production prompts must stay byte-identical: the hashes below were taken
 * from the module at the commit before the options existed.
 */
// @ts-ignore: CommonJS lib; patch the Grok backend before the sheet module destructures it
const grok = require('../../server/lib/grok.js');
const grokCalls: { prompt: string; refs: string[]; opts: any }[] = [];
grok.editWithGrok = async (prompt: string, refs: string[], opts: any) => {
  grokCalls.push({ prompt, refs, opts });
  const sharp = require('sharp');
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  return { imageData: `data:image/jpeg;base64,${buf.toString('base64')}`, usage: null, modelId: opts.model };
};
// @ts-ignore
const sheet = require('../../server/lib/character2x4Sheet.js');

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const ch = { name: 'T', age: 8, gender: 'male', physical: { hairColor: 'brown', glasses: 'none' } };
const season = { season: 'autumn', label: 'Autumn', outfit: 'a jumper', footwear: 'boots' };

describe('production prompts are byte-identical when no style line is given', () => {
  it('costumed body row, head row and standard body row', () => {
    expect(sha(sheet.buildBodyRowPrompt('a robe', ch, false, 'wizard', season))).toBe('a5f03eba74a42a91');
    expect(sha(sheet.buildHeadRowPrompt(ch, 'a robe', false))).toBe('addc3768c25d2e49');
    expect(sha(sheet.buildBodyRowPrompt('standard outfit', ch))).toBe('e598c0309efe5c5f');
  });
});

describe('styleLine draws the rows in the art style (styledBodyRow variant)', () => {
  it('replaces the realistic instruction in both row prompts', () => {
    const body = sheet.buildBodyRowPrompt('a robe', ch, false, 'wizard', season, 'soft watercolour');
    const head = sheet.buildHeadRowPrompt(ch, 'a robe', false, 'soft watercolour');
    expect(body).toMatch(/art style: soft watercolour/);
    expect(body).not.toMatch(/REALISTIC reference/);
    expect(head).toMatch(/Art style: soft watercolour/);
    expect(head).not.toMatch(/Photographic \/ lifelike/);
  });
});

describe('oneCall: the whole styled 2x4 sheet in one Grok call', () => {
  it('makes exactly one call, on the named tier, with a layout guide and the photo', async () => {
    grokCalls.length = 0;
    const photo = 'data:image/jpeg;base64,' + (await require('sharp')({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).jpeg().toBuffer()).toString('base64');
    const c = { ...ch, photos: { face: photo } };
    const out = await sheet.generateOneCallSheet(c, { artStyle: 'watercolor', costumeDescription: 'a robe', costumeName: 'wizard', grokModel: 'grok-imagine-image-2.0' });
    expect(grokCalls).toHaveLength(1);
    expect(grokCalls[0].opts.model).toBe('grok-imagine-image-2.0');
    expect(grokCalls[0].refs).toHaveLength(2);
    expect(out.prompt).toMatch(/2×4 grid/);
    expect(out.prompt).toMatch(/Costume — a wizard: a robe/);
    expect(out.prompt).toMatch(/Empty hands/);
  });
});

describe('pass 2 options', () => {
  it('model, attempt count and anchor reach the Grok call; defaults keep Standard + anchor', async () => {
    const run = async (extra: any) => {
      grokCalls.length = 0;
      const sharp = require('sharp');
      const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).jpeg().toBuffer();
      await sheet.runStyleTransferPass({ pass1ImageData: `data:image/jpeg;base64,${buf.toString('base64')}`, facePhoto: null, artStyle: 'watercolor', characterName: 'T', skipQualityEval: true, ...extra });
      return grokCalls[0];
    };
    const base = await run({});
    expect(base.opts.model).toBe(grok.GROK_MODELS.STANDARD);
    const lean = await run({ grokModel: grok.GROK_MODELS.IMAGE_2, useAnchor: false, maxAttempts: 1 });
    expect(lean.opts.model).toBe(grok.GROK_MODELS.IMAGE_2);
    expect(lean.refs).toHaveLength(1);
    expect(lean.prompt).not.toMatch(/Image 2 is a swatch/);
  });
});
