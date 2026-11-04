import { describe, it, expect } from 'vitest';
const { parsePicks, planPage } = require('../../scripts/admin/adopt-lab-versions.js');

const lab = { versions: [
  { labVersionIndex: 0, source: 'original', method: null, finalScore: 70 },
  { labVersionIndex: 1, source: 'inpaint-round-1', method: null, finalScore: 85 },
  { labVersionIndex: 2, source: 'inpaint-round-2', method: null, finalScore: 100 },
] };
const rec = (n: number) => ({ pageNumber: 7, sceneCharacters: [{ name: 'A' }], imageVersions: Array.from({ length: n }, () => ({ description: 'brief' })) });

describe('adopt-lab-versions', () => {
  it('parses page:version picks and rejects anything else', () => {
    expect([...parsePicks('1:4,7:2')]).toEqual([[1, 4], [7, 2]]);
    expect(() => parsePicks('1-4')).toThrow(/bad pick/);
    expect(() => parsePicks('')).toThrow(/no picks/);
  });
  it('brings the earlier Lab version along so the array index stays the version index', () => {
    const { adopt, entries } = planPage(rec(1), 2, lab, 1803);
    expect(adopt).toEqual([1, 2]);
    expect(entries.map((e: any) => e.source)).toEqual(['inpaint-round-1', 'inpaint-round-2']);
    expect(entries[1]).toMatchObject({ type: 'repair', finalScore: 100, labExperimentId: 1803, description: 'brief' });
  });
  it('refuses a version that is already real, and one the Lab does not have', () => {
    expect(() => planPage(rec(3), 2, lab, 1803)).toThrow(/already a real version/);
    expect(() => planPage(rec(3), 5, lab, 1803)).toThrow(/has no version 3/);
  });
});
