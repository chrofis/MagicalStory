import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { ctxWithIndex } from '../helpers/cast-index';

const nodeRequire = createRequire(import.meta.url);
const SBC = nodeRequire('../../server/lib/sceneBriefCheck.js');
const BC = nodeRequire('../../server/lib/briefChecks.js');

// Stored shape: staging job_1791531449494_o0kaatvmq p4, iterate-round-1 (the
// shipped version). The rewrite's characters[] row for the dragon Funka and her
// creatures[] row ANI001 both read emotion "focused" -- not on the closed list,
// so emotionCheck normalised it to null and skipped her on the shipped page.
const p4Rewrite = {
  characters: [
    { name: 'Levin', depth: 'foreground', expression: 'eyes wide, mouth open', emotion: 'happy' },
    { name: 'Funka', depth: 'midground', expression: 'snout lowered, eyes focused, mouth closed', emotion: 'focused' },
    { name: 'Lindi', depth: 'midground', expression: 'head tilted up, eyes wide and soft, mouth closed', emotion: 'happy' },
  ],
  creatures: [
    { id: 'ANI001', depth: 'midground', looksAt: 'egg', expression: 'snout lowered, eyes focused, mouth closed', emotion: 'focused' },
    { id: 'ANI002', depth: 'midground', looksAt: 'Funka', expression: 'head tilted up, eyes wide, mouth closed', emotion: 'happy' },
  ],
};

describe('emotion_off_list: one closed-list check for characters[] and creatures[]', () => {
  it('names the off-list character row and creature row of the stored p4 rewrite', () => {
    const f = SBC.checkEmotionEnum({ pageNumber: 4 }, p4Rewrite);
    expect(f.map((x: any) => x.type)).toEqual(['emotion_off_list', 'emotion_off_list']);
    expect(f[0].character).toBe('Funka');
    expect(f[1].creature).toBe('ANI001');
    expect(f[0].detail).toContain('"focused"');
    expect(f[0].detail).toContain('`neutral`');
  });
  it('is quiet when every row is on the list', () => {
    const ok = { characters: [{ name: 'Levin', emotion: 'happy' }], creatures: [{ id: 'ANI002', emotion: 'afraid' }] };
    expect(SBC.checkEmotionEnum({ pageNumber: 4 }, ok)).toEqual([]);
  });
  it('the authored-brief collector reports it too (same function, one implementation)', () => {
    const rows = p4Rewrite.characters.map(c => ({ ...c, position: 'left' }));
    const brief = 'Funka watches the egg.\n\n```json\n' + JSON.stringify({ shot: 'medium', characters: rows, creatures: p4Rewrite.creatures, objects: ['ANI001'] }) + '\n```';
    const { findings } = BC.collectBriefFindings([{ pageNumber: 4, brief }], ctxWithIndex({
      inputData: { characters: [] }, clothingRequirements: null, visualBible: null, briefBeats: [],
    }));
    expect(findings.filter((f: any) => f.type === 'emotion_off_list').length).toBe(2);
  });
  it('the iterate rewrite check runs the same function', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server/lib/images.js'), 'utf8');
    expect(src).toMatch(/require\('\.\/sceneBriefCheck'\)\.checkEmotionEnum\(/);
  });
});
