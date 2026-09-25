/**
 * A plate that fails QC twice keeps the attempt with the less SEVERE defects,
 * decided on the check each issue is filed under — never on issue text or a
 * bare count (owner, 2026-09-25). A derived plate broken twice falls back to its
 * base; a base plate broken twice ships with a visible event; both attempts are
 * stored; a retry whose prompt cannot fit is not sent.
 *
 * Cases from staging job_1790277448294_5herh01j7: the p10 ultra-wide derive
 * ("a large glowing white rectangular frame", then only "Setting / location")
 * kept its framed first attempt on a 1-vs-1 count; the LOC001.1 base plate
 * failed on its medium, then on a signature.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const plateQc = require_('../../server/lib/plateQc');
const { decidePlateAfterRetry, normaliseJudgeIssue, plateQcRecord, emptySceneQcOf, PLATE_QC_CHECKS, UNCLASSIFIED, nullOnPromptFit, logPlateOutcome } = plateQc;
const { PromptFitError } = require_('../../server/lib/promptFitError');

const qc = (...findings: Array<[string, string]>) => ({
  pass: findings.length === 0,
  issues: findings.map(f => f[1]),
  findings: findings.map(([check, issue]) => ({ check, issue })),
  visionFeedback: null,
});

describe('decidePlateAfterRetry', () => {
  it('p10: a framed first derive loses to a retry whose only fault is the setting', () => {
    const o = decidePlateAfterRetry({
      firstQc: qc(['artefact', 'a large glowing white rectangular frame in the center']),
      retryQc: qc(['setting', 'the balustrade does not match']),
      derived: true,
    });
    expect(o).toMatchObject({ keep: 'retry', shipFailed: false });
  });

  it('LOC001.1: a base plate hard twice keeps one and ships it visibly', () => {
    const o = decidePlateAfterRetry({
      firstQc: qc(['medium', 'reads as a photograph']),
      retryQc: qc(['text', 'signature at lower-right']),
      derived: false,
    });
    expect(o.keep).toBe('first');
    expect(o.shipFailed).toBe(true);
    expect(o.hardDefects).toEqual([{ check: 'medium', issue: 'reads as a photograph' }]);
  });

  it('a derived plate hard twice falls back to its base plate', () => {
    const o = decidePlateAfterRetry({
      firstQc: qc(['artefact', 'paper mat']), retryQc: qc(['medium', 'photograph']), derived: true,
    });
    expect(o.keep).toBe('base');
  });

  it('severity beats count: one hard defect loses to three soft ones', () => {
    const o = decidePlateAfterRetry({
      firstQc: qc(['text', 'watermark']),
      retryQc: qc(['figures', 'a passer-by'], ['camera', 'eye level'], ['light', 'daylight']),
    });
    expect(o.keep).toBe('retry');
    expect(o.shipFailed).toBe(false);
  });

  it('equal hard counts: fewer soft defects win; a full tie keeps the first', () => {
    expect(decidePlateAfterRetry({ firstQc: qc(['figures', 'a'], ['camera', 'b']), retryQc: qc(['figures', 'c']) }).keep).toBe('retry');
    expect(decidePlateAfterRetry({ firstQc: qc(['figures', 'a']), retryQc: qc(['setting', 'b']) }).keep).toBe('first');
  });

  it('a passing retry wins; no retry image keeps the first and still flags a hard defect', () => {
    expect(decidePlateAfterRetry({ firstQc: qc(['text', 'sign']), retryQc: qc() }).keep).toBe('retry');
    const o = decidePlateAfterRetry({ firstQc: qc(['text', 'sign']), retryQc: null, derived: true });
    expect(o).toMatchObject({ keep: 'first', shipFailed: true });
  });

  it('an unclassified issue counts as hard', () => {
    const o = decidePlateAfterRetry({ firstQc: qc([UNCLASSIFIED, 'x']), retryQc: qc(['figures', 'y']) });
    expect(o.keep).toBe('retry');
  });
});

describe('the judge files each issue under a closed check key', () => {
  it('known keys pass through; strings and unknown keys are unclassified', () => {
    expect(normaliseJudgeIssue({ check: 'Medium', issue: 'photo' })).toEqual({ check: 'medium', issue: 'photo' });
    expect(normaliseJudgeIssue({ check: 'vibes', issue: 'odd' }).check).toBe(UNCLASSIFIED);
    expect(normaliseJudgeIssue('Figures: a man').check).toBe(UNCLASSIFIED);
  });

  it('the hard checks are exactly the frame/box, medium and lettering checks', () => {
    expect(PLATE_QC_CHECKS.filter((c: any) => c.hard).map((c: any) => c.key).sort()).toEqual(['artefact', 'medium', 'text']);
  });

  describe('the QC prompt carries the list', () => {
    beforeAll(async () => { await require_('../../server/services/prompts').loadPromptTemplates(); });
    it('every key reaches the judge', () => {
      const { buildEmptySceneQcPrompt } = require_('../../server/lib/evalPipeline');
      const prompt = buildEmptySceneQcPrompt({ sceneDescription: 'a meadow', artStyle: 'watercolor' });
      for (const c of PLATE_QC_CHECKS) expect(prompt).toContain(`${c.key} (`);
      expect(prompt).toContain('"issues": [{"check": "<key>", "issue": "short issue"}]');
      expect(prompt).not.toContain('{CHECK_KEYS}');
    });
  });

  it('the pixel check files a white box under artefact (hard)', async () => {
    const sharp = require_('sharp');
    const buf = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const { validateEmptyScene } = require_('../../server/lib/evalPipeline');
    const res = await validateEmptyScene(`data:image/png;base64,${buf.toString('base64')}`, null, 'T', { skipVision: true });
    expect(res.findings.some((f: any) => f.check === 'artefact')).toBe(true);
    expect(plateQc.qcSeverity(res).hard.length).toBeGreaterThan(0);
  });
});

describe('both attempts are stored', () => {
  it('v1ImageData is the first attempt and retryImageData the retry, whichever shipped', () => {
    const outcome = { keep: 'first', shipFailed: false, hardDefects: [] };
    const rec = plateQcRecord({ firstImage: 'A', firstQc: qc(['figures', 'x']), retryImage: 'B', retryQc: qc(['setting', 'y']), retryPrompt: 'P', outcome });
    expect(rec).toMatchObject({ v1ImageData: 'A', retryImageData: 'B', keptAttempt: 'first', v1Issues: ['x'], retryIssues: ['y'] });
    expect(emptySceneQcOf(rec)).toMatchObject({ v1ImageData: 'A', retryImageData: 'B', keptAttempt: 'first' });
    expect(emptySceneQcOf({})).toBeNull();
  });
});

describe('logging and the deterministic-failure guard', () => {
  it('a hard defect that ships raises plate_shipped_failed_qc with the defect', () => {
    const events: any[] = [];
    const genLog = { info: (e: string, m: string) => events.push({ e, m }), warn: (e: string, m: string, _c: any, d: any) => events.push({ e, m, d }) };
    const firstQc = qc(['medium', 'photograph']); const retryQc = qc(['text', 'signature']);
    logPlateOutcome(genLog, { event: 'vantage_plate_qc_retry', label: 'Vantage plate V1', pages: [1], outcome: decidePlateAfterRetry({ firstQc, retryQc }), firstQc, retryQc });
    const shipped = events.find(x => x.e === 'plate_shipped_failed_qc');
    expect(shipped.d.defects).toEqual([{ check: 'medium', issue: 'photograph' }]);
  });

  it('a retry whose prompt cannot fit counts as no image; any other error still throws', () => {
    expect(nullOnPromptFit(new PromptFitError('over'))).toBeNull();
    expect(() => nullOnPromptFit(new Error('grok down'))).toThrow('grok down');
  });

  it('the pipeline decides every plate retry with it — no issue-count comparison is left', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/issues\.length < (qc|dqc)\.issues\.length/);
    expect(src.match(/decidePlateAfterRetry\(\{/g)).toHaveLength(3);
    expect(src.match(/\.catch\(nullOnPromptFit\)/g)).toHaveLength(2);
    expect(src.match(/emptySceneQcOf\(/g)).toHaveLength(4);
  });
});
