/**
 * Every per-page plate is judged (owner, 2026-09-26).
 *
 * The story run's per-page plate path (storyJobPipeline.js renderPagePlate)
 * ran validateEmptyScene only when the layout put text in the image, so no
 * per-page plate was judged since every level went text-below (2026-09-05);
 * only vantage and derived plates were. It now always runs, with the text
 * position only when a text zone is active — plateQc.plateQcTextPosition, the
 * rule the Lab empty_scene stage shares. No network, no DB.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { plateQcTextPosition } = require_('../../server/lib/plateQc');

describe('the text position a page plate is judged with', () => {
  it('is the page text position only when the text sits in the image', () => {
    expect(plateQcTextPosition(true, 'top-left')).toBe('top-left');
    expect(plateQcTextPosition(false, 'top-left')).toBeNull();
    expect(plateQcTextPosition(undefined, 'top-left')).toBeNull();
    expect(plateQcTextPosition(true, null)).toBeNull();
  });
});

describe('the story run judges every per-page plate', () => {
  // The run's per-page plate lives in platePipeline.js since 2026-09-27 (shared with the Lab).
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/platePipeline.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function renderPagePlate(');
  const end = src.indexOf('module.exports', start);
  const body = src.slice(start, end);

  it('runs the QC on every rendered plate, not only on text-in-image layouts', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const qcAt = body.indexOf('await validateEmptyScene(result.imageData');
    expect(qcAt).toBeGreaterThan(0);
    const gate = body.lastIndexOf('if (result?.imageData', qcAt);
    const gateLine = body.slice(gate, body.indexOf('\n', gate));
    expect(gateLine).toBe('if (result?.imageData) {');
  });

  it('judges the plate and its retry with plateQcTextPosition, and the retry keeps the first prompt\'s text zone', () => {
    expect(body).toContain('plateQcTextPosition(layoutTextInImage, textPos)');
    expect(body).toContain('validateEmptyScene(result.imageData, qcTextPos,');
    expect(body).toContain('validateEmptyScene(retryResult.imageData, qcTextPos,');
    expect(body).not.toContain('retryTextInstr');
  });
});

describe('every story-run plate QC gets its inputs whole, and the STRUCTURES the author got (2026-09-26)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/platePipeline.js'), 'utf8').replace(/\r\n/g, '\n');
  const perPage = src.slice(src.indexOf('async function renderPagePlate('), src.indexOf('module.exports'));
  const vantage = src.slice(src.indexOf('const repPlate = resolvePagePlate({'), src.indexOf('async function renderPagePlate('));

  it('per-page: EXPECTED SCENE is the SHOT line beside the whole plate text, never both copies', () => {
    expect(perPage).toContain('sceneDescription: expandedEmptyPrompt ? shotPrefix.trim() : emptySceneDesc,');
    expect(perPage).toContain('framing: expandedEmptyPrompt || null,');
  });
  it('per-page: the STRUCTURES text from the plate builder\'s own function, and the grid the call carried', () => {
    expect(perPage).toMatch(/structures: require\('\.\.\/services\/prompts'\)\.buildPlateStructuresText\(\{ visualBible, pageNumber: pageData\.pageNumber, aboardId: pageAboardId, sceneObjects: pageSceneObjects \}\)/);
    expect(perPage).toContain('structureGrid: emptySceneVbGrid || null,');
  });
  it('vantage: the setting text the prompt carries, the FRAMING apart; derived: the setting, no FRAMING, the base\'s structures', () => {
    expect(vantage).toContain("const vantageSetting = vantageSettingText(v, adEmptyPrompt, { interior: baseLight.weather === 'none' });");
    expect(vantage).toContain('`${shotPrefix}${vantageSetting}`,');
    expect(vantage).toContain('sceneDescription: `${shotPrefix}${vantageSetting}`,');
    expect(vantage).toMatch(/buildPlateStructuresText\(\{ visualBible, pageNumber: repPageData\.pageNumber, aboardId: repAboardId, sceneObjects: repSceneObjects \}\)/);
    expect(vantage).toContain('structureGrid: emptySceneVbGrid || null,');
    expect(vantage).toContain('sceneDescription: vantageSetting,');
    expect(vantage).toContain('structures: plateQcOpts.structures,');
  });
  it('vantageSettingText: LOCATION/VANTAGE lines, and the description only when it is not the plate text', () => {
    const { vantageSettingText } = require_('../../server/lib/sceneMetadata');
    const v = { locationName: 'Harbour', location: { name: 'Harbour', setting: 'outdoor harbour' }, name: 'quay view', description: 'Stone quay, moored boats.' };
    expect(vantageSettingText(v, 'A plate.')).toBe('**LOCATION:** outdoor harbour\n**VANTAGE:** quay view\n\nStone quay, moored boats.');
    expect(vantageSettingText(v, 'Stone quay, moored boats.')).toBe('**LOCATION:** outdoor harbour\n**VANTAGE:** quay view');
  });
});

describe('the Lab judges its plate with the same code', () => {
  it('runEmptySceneStage renders through the run\'s own plate functions', () => {
    const lab = fs.readFileSync(path.join(process.cwd(), 'server/lib/testlab.js'), 'utf8');
    expect(lab).toContain('plates.renderPagePlate(target, env)');
    expect(lab).toContain('plates.renderVantagePlates(route.vantageId, route.group, env)');
  });
});
