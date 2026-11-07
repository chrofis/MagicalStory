// Regression: page-edit-overwrites-existing-version (2026-11-07). The edit and regenerate routes
// took the new version's DB index from the imageVersions[] array position, which does not list
// versions the Test Lab image stage wrote to story_images, so the save overwrote a Lab row.
// Every route that pushes a scene version must stamp dbVersionIndex from getNextVersionIndex.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, '../../server/routes/regeneration.js'), 'utf8');
const { dbIndexFor } = require('../../server/lib/versionManager');

function routeBody(marker: string): string {
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\nrouter.', start + marker.length);
  return src.slice(start, next < 0 ? undefined : next);
}

describe('scene version routes allocate from story_images', () => {
  it('edit route stamps dbVersionIndex from getNextVersionIndex', () => {
    const body = routeBody("router.post('/:id/edit/image/:pageNum'");
    expect(body).toMatch(/dbVersionIndex:\s*await getNextVersionIndex\(id, 'scene', pageNumber\)/);
  });

  it('regenerate route stamps dbVersionIndex from getNextVersionIndex', () => {
    const body = routeBody("router.post('/:id/regenerate/image/:pageNum'");
    expect(body).toMatch(/newVersion\.dbVersionIndex = await getNextVersionIndex\(id, 'scene', pageNumber\)/);
  });

  it('a stamped entry wins over its array position (Lab v2,v3 not in imageVersions)', () => {
    const versions = [{ type: 'original' }, { type: 'edit', dbVersionIndex: 4 }];
    expect(dbIndexFor(versions[1], 1, 'scene')).toBe(4);
  });
});
