/**
 * Regression: bug page-edit-silently-edits-version-0. Page 5 had a Lab test row
 * (is_test) pinned active; rehydrateActivePageImage filters NOT is_test and fell
 * back to version 0, so the edit changed a different picture than the customer saw.
 * Rule: an unloadable active version throws (requireActiveRow) - never v0; and the
 * PUT active-image route refuses an unpromoted Lab test row (promote it first).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const { requireActiveRow } = nodeRequire('../../server/lib/versionManager.js');

const regen = fs.readFileSync(path.join(__dirname, '../../server/routes/regeneration.js'), 'utf8');
const stories = fs.readFileSync(path.join(__dirname, '../../server/routes/stories.js'), 'utf8');

describe('requireActiveRow', () => {
  const rows = [{ version_index: 0 }, { version_index: 1 }];
  it('returns the active row', () => {
    expect(requireActiveRow(rows, 1, 'page 5')).toBe(rows[1]);
  });
  it('throws instead of returning version 0 when the active row is missing (test row filtered out)', () => {
    expect(() => requireActiveRow(rows, 4, 'page 5')).toThrow(/Refusing to use another version/);
    try { requireActiveRow(rows, 4, 'page 5'); } catch (e: any) { expect(e.code).toBe('ACTIVE_VERSION_NOT_LOADABLE'); }
  });
  it('active 0 resolves to 0 (legitimate, not a fallback)', () => {
    expect(requireActiveRow(rows, 0, 'page 5')).toBe(rows[0]);
  });
});

describe('no v0 fallback in the single-page / cover handlers', () => {
  it('regeneration.js has no "|| rows.find(version_index === 0)" substitution', () => {
    expect(regen).not.toMatch(/\|\|\s*(rows|pageImages)\.find\(\w+ => \w+\.version_index === 0\)/);
    expect(regen).not.toMatch(/\|\|\s*\n?\s*(rows|pageImages)\.find\(\w+ => \w+\.version_index === 0\)/);
  });
  it('page, cover and the pages-load handler all resolve the active row via requireActiveRow', () => {
    expect((regen.match(/requireActiveRow\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('PUT active-image refuses an unpromoted Lab test row', () => {
  const start = stories.indexOf("router.put('/:id/pages/:pageNumber/active-image'");
  const body = stories.slice(start, stories.indexOf('\nrouter.', start + 10));
  it('checks for an is_test row at the requested index and answers 409 before pinning', () => {
    const guard = body.indexOf('AND is_test');
    const pin = body.indexOf('Setting active version');
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf('409')).toBeGreaterThan(guard);
    expect(pin).toBeGreaterThan(guard);
  });
});
