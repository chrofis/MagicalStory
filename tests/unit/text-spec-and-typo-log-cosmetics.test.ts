/**
 * Cosmetics found on job_1791497309909_6quecrr9t (2026-10-09): the writer's ALSO
 * IN VIEW rows printed "..", and a creature row's "Looks at: X" ran into the next
 * row X as "X; X"; the cover typography log said "baked title" for a pass that
 * skipped (no dedication).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const cjs = createRequire(import.meta.url);
const SM = cjs('../../server/lib/sceneMetadata.js');
const fs = cjs('fs');

const VB = {
  animals: [
    { id: 'ANI002', name: 'The raven', species: 'Common raven', coloring: 'Solid black feathers with a slight glossy blue sheen.' },
  ],
  artifacts: [{ id: 'ART001', name: 'dragon egg', states: [] }],
  locations: [{ id: 'LOC001', name: 'Lindenhof' }],
};
const brief = [
  'PLAN: x',
  '```json',
  JSON.stringify({ sceneIntent: 'The raven watches the egg.', objects: ['LOC001', 'ANI002', 'ART001'], characters: [],
    creatures: [{ id: 'ANI002', depth: 'midground', emotion: 'neutral', looksAt: 'ART001', expression: 'eyes wide' }] }),
  '```',
].join('\n');

describe('picture spec cosmetics', () => {
  it('prints no double full stop and keeps a gaze target apart from the next row', () => {
    const spec = SM.buildTextStagePictureSpecs([{ pageNumber: 3, brief }], { visualBible: VB }).get(3);
    expect(spec).not.toContain('..');
    expect(spec).not.toMatch(/Looks at: dragon egg; dragon egg/);
    expect(spec).toMatch(/Looks at: dragon egg \| dragon egg/);
  });
  it('the cover typography log says skipped for a skipped pass', () => {
    const src = fs.readFileSync('server/lib/coverTypography.js', 'utf8');
    expect(src).toContain('typography SKIPPED on served v');
  });
});
