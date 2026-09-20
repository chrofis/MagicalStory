import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

// THE OBJECT-SCALE CHECK MUST NEVER BE STARVED SILENTLY (2026-09-20).
//
// The check ran in the live repair path and measured NOTHING for as long as it
// existed: repairPipeline handed `auditStoryBook` a projection —
// `{ id, sceneImages: buildAuditPages(...) }` — which carried no visualBible
// and no per-page object citations. `selectScaleObjects` then read `vb[coll]`
// as `[]`, produced zero candidates AND zero skips, and wrote not even a
// `notEvaluated` row. And even a real finding would have been thrown away: the
// `bookAuditRounds.push({...})` record is a hand-kept whitelist that did not
// list `objectScale` (same class as notEvaluated / degradedScene /
// threeStageResult).
//
// These tests pin BEHAVIOUR: the citations survive the projection, a stripped
// story is loud and recorded, and the field survives to finalChecksReport.

// @ts-expect-error - JS module without types
import { buildAuditPages } from '../../server/lib/bookAudit.js';
// @ts-expect-error - JS module without types
import { citedIds, selectScaleObjects } from '../../server/lib/objectScaleAudit.js';

const IMG = 'data:image/png;base64,AAA';

describe('buildAuditPages carries the brief’s object citations', () => {
  it('projects sceneMetadata.objects onto the audit page', () => {
    const pages = buildAuditPages(
      [{ pageNumber: 3, text: 't', imageData: IMG, sceneMetadata: { objects: [{ id: 'ART001.2' }, 'VEH001'] } }],
      null);
    expect(pages[0].citedIds.sort()).toEqual(['ART001', 'VEH001']);
  });

  it('a projected audit page is still readable by the scale selector', () => {
    const story = {
      visualBible: { artifacts: [{ id: 'ART001', label: 'large warm egg', scaleClass: 'melon' }] },
      sceneImages: buildAuditPages(
        [2, 3, 4, 5].map(pageNumber => ({
          pageNumber, text: 't', imageData: IMG, sceneMetadata: { objects: ['ART001'] },
        })), null),
    };
    const { candidates } = selectScaleObjects(story, [2, 3, 4, 5]);
    expect(candidates.map((c: any) => c.id)).toEqual(['ART001']);
    expect(candidates[0].pages).toEqual([2, 3, 4, 5]);
  });

  it('citedIds reads all three page shapes', () => {
    expect([...citedIds({ citedIds: ['ART001'] })]).toEqual(['ART001']);
    expect([...citedIds({ objects: ['ART001'] })]).toEqual(['ART001']);
    expect([...citedIds({ sceneMetadata: { objects: ['ART001'] } })]).toEqual(['ART001']);
    expect([...citedIds({})]).toEqual([]);
  });
});

describe('a starved object-scale check is loud and recorded, never silent', () => {
  it('records a notEvaluated row when the story carries no bible', async () => {
    const bookAudit: any = await import('../../server/lib/bookAudit.js');
    const prompts: any = await import('../../server/services/prompts.js');
    prompts.PROMPT_TEMPLATES.bookAudit = 'PAGES: {{PAGE_LIST}} {{TEXT_NOT_A_CHECKLIST}}';
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';

    const spy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'no faults' }] } }], usageMetadata: {} }),
    } as any);
    const result = await bookAudit.auditStoryBook(
      { id: 's1', sceneImages: [{ pageNumber: 1, text: 't', imageData: IMG }] },
      { imageLoader: async () => IMG });
    spy.mockRestore();

    expect(JSON.stringify(result.objectScale.notEvaluated)).toMatch(/missing_input/);
  });

  it('the starvation branch shouts at log.error — a silent starve is the bug', () => {
    const src = fs.readFileSync('server/lib/bookAudit.js', 'utf8');
    const guard = src.slice(src.indexOf('STARVATION GUARD'), src.indexOf('selectScaleObjects('));
    expect(guard).toMatch(/log\.error/);
    expect(guard).toMatch(/notEvaluated\.record\('object_scale', 'missing_input'/);
  });
});

describe('objectScale survives the whitelist to finalChecksReport', () => {
  const repair = fs.readFileSync('server/lib/repairPipeline.js', 'utf8');
  const jobPipeline = fs.readFileSync('storyJobPipeline.js', 'utf8');

  it('the bookAuditRounds record stores the audit’s objectScale', () => {
    const push = repair.slice(repair.indexOf('bookAuditRounds.push({'));
    expect(push.slice(0, push.indexOf('});'))).toMatch(/objectScale:\s*audit\.objectScale/);
  });

  it('the repair pipeline passes the bible into the audit', () => {
    expect(repair).toMatch(/auditStoryBook\(\s*\n?\s*\{[^}]*visualBible/);
  });

  it('finalChecksReport.objectScale is written from a stored round', () => {
    expect(jobPipeline).toMatch(/finalChecksReport\.objectScale\s*=/);
  });
});
