import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Code review 2026-10 B4 / B5. The route needs a live DB + Gemini, so the
// contract is pinned on the handler's source (the repo's pattern for routes).
const src = fs.readFileSync(path.resolve(__dirname, '../../server/routes/regeneration.js'), 'utf8');
const start = src.indexOf("router.post('/:id/repair-workflow/re-evaluate'");
const end = src.indexOf("router.post('/:id/evaluate-single/:pageNum'");
const handler = src.slice(start, end);

describe('re-evaluate route', () => {
  it('is rate limited like the other paid repair routes (B4)', () => {
    expect(handler.split('\n')[0]).toContain('imageRegenerationLimiter');
    expect(src).toMatch(/repair-workflow\/consistency-check', authenticateToken, imageRegenerationLimiter/);
  });
  it('evaluates each distinct page once and refuses a list longer than the story (B4)', () => {
    expect(handler).toMatch(/new Set\(requestedPageNumbers\)/);
    expect(handler).toMatch(/maxEvaluablePages/);
    expect(handler).not.toMatch(/req\.body;?\s*\n.*pageNumbers\.map/);
  });
  it('saves evaluated pages atomically instead of rewriting the whole story blob (B5)', () => {
    expect(handler).not.toMatch(/saveStoryData\(/);
    expect(handler).toMatch(/savePagesAtomically\(/);
    const helper = src.slice(src.indexOf('async function savePagesAtomically'), src.indexOf('function isCoverPage') + 4000);
    expect(helper).toMatch(/saveScenePageData\(/);
    expect(helper).toMatch(/saveCoverData\(/);
  });
  it('consistency-check and pick-best also save per page / per key, never the whole blob (batch 8)', () => {
    const cc = src.slice(src.indexOf("router.post('/:id/repair-workflow/consistency-check'"), src.indexOf("router.post('/:id/repair-workflow/pick-best-versions'"));
    const pb = src.slice(src.indexOf("router.post('/:id/repair-workflow/pick-best-versions'"), src.indexOf('// Step 7: Repair characters using repairSinglePage'));
    for (const h of [cc, pb]) expect(h).not.toMatch(/saveStoryData\(/);
    expect(cc).toMatch(/saveFinalChecksReport\(/);
    expect(cc).toMatch(/savePagesAtomically\(/);
    expect(pb).toMatch(/savePagesAtomically\(/);
  });
});
