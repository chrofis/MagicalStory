/**
 * FOOTING AS A FIELD (owner rule 2026-08-15 "no partial immersion"; staging job
 * job_1791267520938_essbvehs8 p3). Pins behaviour of the structural check and
 * that the rule reaches every brief author — never prompt wording.
 * see docs/decisions.md 2026-10-06 "Footing is a field"
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { ctxWithIndex } from '../helpers/cast-index';
import fs from 'node:fs';

const req = createRequire(import.meta.url);
const SBC = req('../../server/lib/sceneBriefCheck');
const BC = req('../../server/lib/briefChecks');
const PB = req('../../server/lib/promptBuilders');
const SV = req('../../server/lib/shotVocabulary');

const row = (name: string, footing?: string) => ({ name, depth: 'foreground', expression: 'brows raised, mouth open', ...(footing ? { footing } : {}) });
const VB = (cameraOn: string) => ({ locations: [{ id: 'LOC001', name: 'Beach', vantages: [
  { id: 'LOC001.1', shot: 'wide', cameraOn: 'ground', pages: [1] },
  { id: 'LOC001.2', shot: 'medium', cameraOn, pages: [3] },
] }] });
const meta = (characters: any[]) => ({ shot: 'medium', objects: ['LOC001.2'], characters });

describe('footing_invalid', () => {
  it('fires for a row with no footing or a value outside the enum', () => {
    const f = SBC.checkFooting({ pageNumber: 3 }, meta([row('Emma'), row('Hans', 'wading'), row('Sarah', 'ground')]), null);
    expect(f).toHaveLength(1);
    expect(f[0].type).toBe('footing_invalid');
    expect(f[0].characters).toEqual(['Emma', 'Hans']);
  });
  it('passes when every row carries a valid footing', () => {
    expect(SBC.checkFooting({ pageNumber: 3 }, meta([row('Emma', 'ground'), row('Hans', 'swimming')]), null)).toEqual([]);
  });
});

describe('footing_in_water: a vantage in the water holds only swimming figures', () => {
  it('fires for a figure with footing on a water vantage, naming a shore vantage', () => {
    const f = SBC.checkFooting({ pageNumber: 3 }, meta([row('Emma', 'ground'), row('Hans', 'swimming')]), VB('water'));
    expect(f.map((x: any) => x.type)).toEqual(['footing_in_water']);
    expect(f[0].characters).toEqual(['Emma']);
    expect(f[0].detail).toContain('LOC001.1');
  });
  it('passes when everyone swims, or the vantage is on the ground', () => {
    expect(SBC.checkFooting({ pageNumber: 3 }, meta([row('Emma', 'swimming')]), VB('water'))).toEqual([]);
    expect(SBC.checkFooting({ pageNumber: 3 }, meta([row('Emma', 'ground')]), VB('ground'))).toEqual([]);
  });
  it('reaches the re-ask: collectBriefFindings reports both types', () => {
    const b = `Emma stands at the shore.\n\n---METADATA---\n${JSON.stringify(meta([row('Emma', 'ground')]))}`;
    const ctx = ctxWithIndex({ inputData: { characters: [{ name: 'Emma' }] }, clothingRequirements: null, visualBible: VB('water'), briefBeats: [] });
    const types = BC.collectBriefFindings([{ pageNumber: 3, brief: b }], ctx).findings.map((f: any) => f.type);
    expect(types).toContain('footing_in_water');
    const b2 = `Emma stands at the shore.\n\n---METADATA---\n${JSON.stringify(meta([row('Emma')]))}`;
    expect(BC.collectBriefFindings([{ pageNumber: 3, brief: b2 }], ctx).findings.map((f: any) => f.type)).toContain('footing_invalid');
  });
});

describe('the rule reaches every brief author and the Bible', () => {
  it('shotRuleFills carries both fills on both paths', () => {
    for (const fixedShot of [true, false]) {
      const f = PB.shotRuleFills({ fixedShot });
      expect(f.FOOTING_RULE).toBe(SV.FOOTING_RULE);
      expect(f.FOOTING_FIELD).toBe(SV.FOOTING_FIELD);
    }
  });
  it('all four brief templates declare both placeholders; the Bible declares cameraOn', () => {
    for (const t of ['scene-briefs-all', 'scene-expansion', 'scene-iteration', 'scene-iteration-free']) {
      const s = fs.readFileSync(`prompts/${t}.txt`, 'utf8');
      expect(s).toContain('{FOOTING_RULE}');
      expect(s).toContain('{FOOTING_FIELD}');
    }
    expect(fs.readFileSync('prompts/visual-bible.txt', 'utf8')).toContain('cameraOn');
  });
});
