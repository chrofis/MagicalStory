import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const { needsScaleRepair } = require_('../../server/lib/scaleRepair.js');

/**
 * The trigger counts only figures the composite can ACTUALLY cast. A Visual
 * Bible secondary the scene reviewer promoted into characters[] passes the
 * figure count and then resolves to nothing, so a cast-blind call answers a
 * different question from the one production asks.
 */
describe('the scale-repair trigger needs the cast list to answer correctly', () => {
  const md = {
    fullData: {
      setting: 'outdoor',
      objects: [],
      interactions: [],
      characters: [
        { name: 'Emma', depth: 'foreground', position: 'left foreground' },
        { name: 'The Harbour Master', depth: 'background', position: 'far quay' },
      ],
    },
  };

  it('cast-blind, a promoted secondary counts as a castable figure', () => {
    expect(needsScaleRepair(md)).toBe(true);
  });

  it('with the cast list, only photo-backed characters count', () => {
    expect(needsScaleRepair(md, [{ name: 'Emma' }])).toBe(false);
    expect(needsScaleRepair(md, [{ name: 'Emma' }, { name: 'The Harbour Master' }])).toBe(true);
  });
});

describe('every call site passes the cast', () => {
  it('the Lab stage passes it to the trigger and into runScaleRepair', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
    const at = src.indexOf('async function runScaleRepairStage');
    const stage = src.slice(at, at + 1400);
    expect(stage).toMatch(/needsScaleRepair\(sceneMetadata, castable\)/);
    expect(stage).toMatch(/castableCharacters: castable/);
  });

  it('the production endpoint passes it to both gates', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/routes/regeneration.js'), 'utf8');
    expect(src).toMatch(/needsScaleRepair\(sceneMetadata, storyData\.characters \|\| \[\]\)/);
    expect(src).toMatch(/castableCharacters: storyData\.characters \|\| \[\]/);
  });
});
