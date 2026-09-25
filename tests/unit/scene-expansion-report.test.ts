import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const lf = (s: string) => s.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const beats = lf(readFileSync(join(__dirname, '../..', 'server', 'lib', 'beatsPipeline.js'), 'utf-8'));
const pipeline = lf(readFileSync(join(__dirname, '../..', 'storyJobPipeline.js'), 'utf-8'));

/**
 * sceneReviewReport.prompt is the REVIEWER's prompt. The Art Director's own —
 * ~100k chars of rules, the Visual Bible spec, the cover spec and all 18 plan
 * lines — was stored nowhere. Recovering it for job_1789759147125_p08djwhbl
 * meant a git worktree at the run's commit plus a rebuild from inputData +
 * finalArc + pagePlan + clothingRequirements + characterAvatars, and WHICH
 * commit to rebuild at was only decidable by probing the stored review prompt
 * for a constant a candidate commit had introduced.
 *
 * Since 2026-09-21 `sceneExpansionReport.prompts[]` is also the ONLY copy: the
 * pages reference it by index instead of each carrying the ~112 KB string. The
 * roll-up therefore has exactly ONE builder — `rollUpScenePrompts()` in
 * server/lib/storyShape.js, which is exercised directly in story-shape.test.ts.
 * These cases pin where it is called from, and that no second builder returns.
 */
describe('the scene stage keeps the prompt that wrote the briefs', () => {
  const block = beats.slice(beats.indexOf('const sceneExpansionReport'), beats.indexOf("gl.info('beats_scenes'"));

  it('beats contributes only what beats alone knows — it does NOT build the prompt table', () => {
    expect(block).toContain('durationMs');
    expect(block).toContain('fallbackPages');
    // A second roll-up here would drift from the one in storyShape.js and
    // silently win, because the caller spreads this object.
    expect(block).not.toContain('byPrompt');
    expect(block).not.toMatch(/prompts:/);
  });

  it('is built OUTSIDE the scene-review branch, so an unreviewed run still carries it', () => {
    // sceneReviewReport is assigned only where the review template loaded.
    const buildIdx = beats.indexOf('const sceneExpansionReport');
    const reviewIdx = beats.indexOf('let sceneReviewReport = null;');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(buildIdx, 'the AD report must be built before the review section begins').toBeLessThan(reviewIdx);
  });

  it('is returned by beats and persisted onto the story', () => {
    expect(beats).toMatch(/return \{[^}]*sceneExpansionReport[^}]*\}/);
    expect(pipeline).toMatch(/^\s*sceneExpansionReport,$/m);
  });

  it('the pipeline is the single owner of the prompt table, for every mode', () => {
    // One call, over the assembled scenes — so the beats all-pages call, its
    // per-page fallback and the unified streaming path all dedupe identically.
    expect(pipeline).toContain("require('./server/lib/storyShape')");
    expect(pipeline).toMatch(/rollUpScenePrompts\(expandedScenes\)/);
    expect(pipeline).toMatch(/prompts:\s*scenePromptTable/);
  });

  it('no page carries an inline copy of the prompt — only the index', () => {
    // 18 copies of a ~112 KB prompt was 2.06 MB per story, twice over
    // (sceneDescriptions AND sceneImages) — 47% of a measured 8.7 MB row.
    // The stored sceneDescriptions record is built by one projection
    // (sceneMetadata.sceneDescriptionRecord), handed the page -> index map.
    expect(pipeline).toMatch(/sceneDescriptionRecord\(scene, scenePromptRefs\)/);
    const sceneMetadataSrc = lf(readFileSync(join(__dirname, '../..', 'server', 'lib', 'sceneMetadata.js'), 'utf-8'));
    expect(sceneMetadataSrc).toMatch(/scenePromptRef:/);
    expect(sceneMetadataSrc).not.toMatch(/sceneDescriptionPrompt/);
    expect(pipeline).not.toMatch(/scenePrompt:\s*scene\.sceneDescriptionPrompt/);
    expect(pipeline).not.toMatch(/sceneDescriptionPrompt:\s*img\.scene\?\.sceneDescriptionPrompt/);
  });
});

/**
 * The page cast stored a FULL character record per page — avatars.prompts and
 * avatars.storyHistory alone were 0.90 MB across 41 snapshots of one story,
 * both owned by the characters table and read only through the characters API.
 */
describe('the stored story carries no duplicate avatar provenance', () => {
  const db = lf(readFileSync(join(__dirname, '../..', 'server', 'services', 'database.js'), 'utf-8'));
  const stripStart = db.indexOf('const stripCharSnapshot');
  const strip = db.slice(stripStart, db.indexOf('// sceneImages', stripStart));

  it('strips avatars.prompts and avatars.storyHistory from every snapshot', () => {
    expect(strip).toMatch(/c\.avatars\.prompts\s*=\s*undefined;/);
    expect(strip).toMatch(/c\.avatars\.storyHistory\s*=\s*undefined;/);
  });

  it('still preserves the per-story avatars that have no other home', () => {
    expect(strip).not.toMatch(/c\.avatars\.styledAvatars\s*=\s*undefined;/);
    expect(strip).not.toMatch(/c\.avatars\.costumed\s*=\s*undefined;/);
  });

  it('runs over both the page cast and the top-level roster', () => {
    expect(db).toMatch(/for \(const c of s\.sceneCharacters\) stripCharSnapshot\(c\);/);
    expect(db).toMatch(/for \(const c of data\.characters\) stripCharSnapshot\(c\);/);
  });
});

/**
 * story_jobs.result_data is the job-status payload, not a second copy of the
 * story. storyService.getJobStatus()'s explicit field mapping is the real gate.
 */
describe('result_data stores nothing the status poll cannot deliver', () => {
  it('is built from an explicit allow-list, not by subtraction', () => {
    expect(pipeline).toMatch(/const RESULT_DATA_FIELDS = \[/);
    expect(pipeline).toMatch(/for \(const key of RESULT_DATA_FIELDS\) \{/);
    // A field added to `resultData` must not reach the column by default.
    expect(pipeline).not.toMatch(/\.\.\.resultDataStorable/);
    expect(pipeline).not.toMatch(/\.\.\.resultData,/);
  });

  it('never stores the story a second time: no page, cover or scene payload', () => {
    const list = pipeline.slice(pipeline.indexOf('const RESULT_DATA_FIELDS = ['));
    const fields = list.slice(0, list.indexOf('];'));
    for (const dup of ['sceneImages', 'sceneDescriptions', 'coverImages', 'finalChecksReport',
                       'outlineReview', 'tokenUsage', 'generationMode']) {
      expect(fields).not.toContain(`'${dup}'`);
    }
    // ...and the client no longer asks the poll for them.
    const svc = lf(readFileSync(join(__dirname, '../..', 'client', 'src', 'services', 'storyService.ts'), 'utf-8'));
    expect(svc).not.toMatch(/sceneImages: resultData\.sceneImages/);
    expect(svc).not.toMatch(/coverImages: resultData\.coverImages/);
    expect(svc).not.toMatch(/sceneDescriptions: resultData\.sceneDescriptions/);
  });

  it('keeps every field the client mapping does forward', () => {
    const list = pipeline.slice(pipeline.indexOf('const RESULT_DATA_FIELDS = ['));
    const fields = list.slice(0, list.indexOf('];'));
    for (const keep of ['storyId', 'shareToken', 'title', 'outline', 'outlinePrompt',
                        'outlineModelId', 'outlineUsage', 'story', 'storyTextPrompts',
                        'visualBible', 'styledAvatarGeneration', 'costumedAvatarGeneration',
                        'generationLog', 'sceneExpansionReport', 'estimatedCost']) {
      expect(fields).toContain(`'${keep}'`);
    }
  });

  it('keeps estimatedCost — storyMetrics queries it straight off the column', () => {
    const metrics = lf(readFileSync(join(__dirname, '../..', 'server', 'lib', 'storyMetrics.js'), 'utf-8'));
    expect(metrics).toContain("result_data->>'estimatedCost'");
    expect(pipeline).toMatch(/estimatedCost: totalCost,/);
  });
});
