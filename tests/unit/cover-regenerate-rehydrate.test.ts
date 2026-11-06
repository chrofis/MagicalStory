/**
 * Regression: POST /:id/regenerate/cover/:coverType read story.data (no image
 * bytes) and called iterateFullStoryCover, which throws "no cover image to
 * iterate". The route must load this cover's active bytes first
 * (rehydrateActiveCoverImage), and only that cover (SPD-2: no full rehydrate).
 * Bug cover-regenerate-no-image-bytes, cause 6fbd2b599 (covers-as-pages).
 */
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../server/routes/regeneration.js'), 'utf8');
const start = src.indexOf("router.post('/:id/regenerate/cover/:coverType'");
const end = src.indexOf('\nrouter.', start + 10);
const route = src.slice(start, end > 0 ? end : undefined);

describe('cover regenerate route loads the cover bytes', () => {
  it('calls rehydrateActiveCoverImage before the page-path render', () => {
    const load = route.indexOf('rehydrateActiveCoverImage(id, storyData, coverKey)');
    const render = route.indexOf('iterateFullStoryCover(');
    expect(load).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(load);
  });
  it('does not full-rehydrate the story (SPD-2 OOM)', () => {
    expect(route).not.toContain('rehydrateStoryImages(');
  });
  it('the helper reads only this cover active version from story_images', () => {
    const h = src.slice(src.indexOf('async function rehydrateActiveCoverImage'));
    const body = h.slice(0, h.indexOf('\n}\n'));
    expect(body).toContain("image_type = $2 AND page_number IS NULL");
    expect(body).toContain('activeVersion');
    expect(body).toContain('imgBytesAsync');
  });
});
