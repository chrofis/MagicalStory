/**
 * An in-job iterate rewrite re-pins the decided fields (images.js iteratePageCore reads
 * `savedScene.jevFixed`). The repair pipeline's storyData whitelist (storyJobPipeline.js
 * pipelineStoryData.sceneImages) did not carry `jevFixed`, so no auto-repair rewrite was ever
 * pinned: staging job_1791267520938_essbvehs8 p3 v1 kept location LOC001 (vantage LOC001.2),
 * no population, and Emma's gaze at "water" where the pinned decision says Hans.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { pinBrief } = req('../../server/lib/jevDecisions');
const src = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');

describe('the repair pipeline hands iterate each page\'s decided fields', () => {
  it('pipelineStoryData.sceneImages carries jevFixed from the raw page', () => {
    const block = src.slice(src.indexOf('const pipelineStoryData = {'), src.indexOf('coverImages,  // a full-story cover'));
    expect(block).toContain('sceneImages: rawImages.map(r => ({');
    expect(block).toContain('jevFixed: r.scene?.jevFixed || null');
  });
  it('a rewrite that moved location, population and gaze is restored by the pin', () => {
    const rewrite = `Prose.\n\n---METADATA---\n${JSON.stringify({
      characters: [{ name: 'Emma', looksAt: 'water' }, { name: 'Hans', looksAt: 'Emma' }],
      objects: ['LOC001'], shot: 'over-the-shoulder', timeOfDay: 'afternoon', weather: 'clear',
    })}`;
    const r = pinBrief(rewrite, { shot: 'over-the-shoulder', location: 'LOC001.2', population: 'cast_only', looksAt: { Emma: 'Hans' } });
    expect(r.changes.map((c: any) => c.field).sort()).toEqual(['location', 'looksAt', 'population']);
    expect(r.brief).toContain('"LOC001.2"');
  });
});
