/**
 * 2026-11-14: a full-story cover's plate is stored as its `empty_scene` row (negative page number), as a page's
 * plate is, after its first render AND after a book-review `background: redo` repaint. Before, a stored cover had
 * no plate: a later `keep` painted a new one from the text, and a redo plate lived for its run only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { saveCoverPlate } = require_('../../server/services/database.js');
const ROOT = path.resolve(__dirname, '../..');
const PLATE = 'data:image/jpeg;base64,/9j/PLATE';

describe('saveCoverPlate', () => {
  it('writes the plate as the cover\'s empty_scene row and moves the bytes out of the blob', async () => {
    const writes: any[] = [];
    const cover: any = { emptySceneImage: PLATE, imageData: 'x' };
    const n = await saveCoverPlate('s1', -1, cover, async (...a: any[]) => { writes.push(a); });
    expect(n).toBe(1);
    expect(writes).toEqual([['s1', 'empty_scene', -1, PLATE]]);
    expect(cover.emptySceneImage).toBeUndefined();
    expect(cover.hasEmptySceneImage).toBe(true);
  });

  it('writes nothing for a cover with no plate, and leaves a non-image value alone', async () => {
    const writes: any[] = [];
    const w = async (...a: any[]) => { writes.push(a); };
    expect(await saveCoverPlate('s1', -2, {}, w)).toBe(0);
    const old: any = { emptySceneImage: 'https://r2.example/plate.jpg' };
    expect(await saveCoverPlate('s1', -3, old, w)).toBe(0);
    expect(old.emptySceneImage).toBe('https://r2.example/plate.jpg');
    expect(writes).toHaveLength(0);
  });

  it('the row is the one the re-render reads (loadStoredPagePlate: empty_scene at the page number)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/landmarkScene.js'), 'utf8');
    expect(src).toMatch(/getStoryImage\(storyId, 'empty_scene', pageNumber, 0\)/);
  });
});

describe('both save paths store it, and the pipeline hands the repaired plate back', () => {
  const db = fs.readFileSync(path.join(ROOT, 'server/services/database.js'), 'utf8');
  const pipe = fs.readFileSync(path.join(ROOT, 'storyJobPipeline.js'), 'utf8');

  it('the full story save calls it for every cover', () => {
    const loop = db.slice(db.indexOf("const coverTypes = ['frontCover', 'initialPage', 'backCover'];"));
    expect(loop.slice(0, 4000)).toMatch(/imagesSaved \+= await saveCoverPlate\(storyId, coverPageNumber, coverData\);/);
  });

  it('the single-cover save calls it', () => {
    const fn = db.slice(db.indexOf('async function saveCoverData('));
    expect(fn.slice(0, 1500)).toMatch(/await saveCoverPlate\(storyId, COVER_PAGE_NUMBERS\[coverType\] \?\? null, dataForStorage\);/);
  });

  it('the cover copy-back after the repair carries the plate the repair left', () => {
    expect(pipe).toMatch(/coverImages\[coverKey\]\.emptySceneImage = img\.emptySceneImage \?\? coverImages\[coverKey\]\.emptySceneImage \?\? null;/);
  });
});
