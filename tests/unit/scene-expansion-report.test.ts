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
 */
describe('the scene stage keeps the prompt that wrote the briefs', () => {
  it('builds a report of the distinct prompts and the pages each produced', () => {
    const block = beats.slice(beats.indexOf('const sceneExpansionReport'), beats.indexOf('gl.info(\'beats_scenes\''));
    expect(block).toContain('byPrompt');
    expect(block).toContain('fallbackPages');
    expect(block).toMatch(/prompts:\s*\[\.\.\.byPrompt\.values\(\)\]/);
  });

  it('is built OUTSIDE the scene-review branch, so an unreviewed run still carries it', () => {
    // sceneReviewReport is assigned only where the review template loaded.
    const buildIdx = beats.indexOf('const sceneExpansionReport');
    const reviewIdx = beats.indexOf('let sceneReviewReport = null;');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(-1);
    expect(buildIdx, 'the AD report must be built before the review section begins').toBeLessThan(reviewIdx);
  });

  it('is returned by the pipeline and persisted onto the story', () => {
    expect(beats).toMatch(/return \{[^}]*sceneExpansionReport[^}]*\}/);
    expect(pipeline).toContain('beatsResult?.sceneExpansionReport || null');
    expect(pipeline).toMatch(/^\s*sceneExpansionReport,$/m);
  });

  it('rolls up by distinct prompt, not one copy per page', () => {
    // The all-pages prompt is ~100k chars; 18 copies would be 1.8MB per story.
    const block = beats.slice(beats.indexOf('const sceneExpansionReport'), beats.indexOf('gl.info(\'beats_scenes\''));
    expect(block).toMatch(/pages\.push\(x\.pageNumber\)/);
    expect(block).not.toMatch(/expansions\.map\(x => \(\{[^}]*prompt/);
  });
});

/**
 * The roll-up itself, run on the shape `expansions` actually carries: every
 * entry has {pageNumber, brief, prompt, modelId}, from the all-pages map or the
 * per-page salvage path.
 */
describe('the roll-up groups pages by the prompt that produced them', () => {
  const rollUp = (expansions: any[]) => {
    const byPrompt = new Map<string, any>();
    for (const x of expansions) {
      const key = `${x.modelId || ''}\u0000${x.prompt || ''}`;
      if (!byPrompt.has(key)) byPrompt.set(key, { prompt: x.prompt || '', modelId: x.modelId || null, pages: [] });
      byPrompt.get(key).pages.push(x.pageNumber);
    }
    return [...byPrompt.values()].map(r => ({ ...r, pages: r.pages.sort((a: number, b: number) => a - b) }));
  };

  it('one row when every page came from the all-pages call', () => {
    const rows = rollUp([1, 2, 3].map(n => ({ pageNumber: n, prompt: 'ALL', modelId: 'm1' })));
    expect(rows).toHaveLength(1);
    expect(rows[0].pages).toEqual([1, 2, 3]);
  });

  it('a page that fell back to the per-page template keeps its own prompt', () => {
    const rows = rollUp([
      { pageNumber: 1, prompt: 'ALL', modelId: 'm1' },
      { pageNumber: 2, prompt: 'PER-PAGE p2', modelId: 'm1' },
      { pageNumber: 3, prompt: 'ALL', modelId: 'm1' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.prompt === 'ALL')!.pages).toEqual([1, 3]);
    expect(rows.find(r => r.prompt === 'PER-PAGE p2')!.pages).toEqual([2]);
  });

  it('the same prompt from two models is two rows — provenance is model + text', () => {
    const rows = rollUp([
      { pageNumber: 1, prompt: 'ALL', modelId: 'm1' },
      { pageNumber: 2, prompt: 'ALL', modelId: 'm2' },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('pages come back in order however they arrived', () => {
    const rows = rollUp([9, 2, 5].map(n => ({ pageNumber: n, prompt: 'ALL', modelId: 'm1' })));
    expect(rows[0].pages).toEqual([2, 5, 9]);
  });
});
