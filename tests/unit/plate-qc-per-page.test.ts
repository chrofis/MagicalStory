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
  const src = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('const renderPagePlate = async');
  const end = src.indexOf('const storePagePlate = ', start);
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

describe('the Lab judges its plate with the same rule', () => {
  it('runEmptySceneStage takes its QC text position from plateQcTextPosition', () => {
    const lab = fs.readFileSync(path.join(process.cwd(), 'server/lib/testlab.js'), 'utf8');
    expect(lab).toContain("require('./plateQc').plateQcTextPosition(wantsTextZone, ctx.textPosition)");
  });
});
