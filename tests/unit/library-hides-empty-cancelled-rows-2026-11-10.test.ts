import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
// @ts-ignore - CommonJS module
import { LIBRARY_HIDDEN_JOB_FILTER } from '../../server/lib/storyLibraryFilter';

// Regression: bug cancelled-job-leaves-empty-library-card. A cancelled/failed job's empty row
// (metadata {}) was listed as a blank card; a failed job that saved a partial (metadata.id) stays.
describe('library filter for job rows', () => {
  const f = LIBRARY_HIDDEN_JOB_FILTER.replace(/\s+/g, ' ');
  it('still hides running jobs', () => {
    expect(f).toContain("j.status IN ('pending', 'processing')");
  });
  it('hides cancelled and failed jobs only when the row holds no saved story (no metadata.id)', () => {
    expect(f).toContain("j.status IN ('cancelled', 'failed') AND s.metadata->>'id' IS NULL");
  });
  it('does not hide cancelled/failed rows unconditionally (a saved partial stays visible)', () => {
    expect(f).not.toMatch(/OR j\.status IN \('cancelled'/);
  });
  it('GET /api/stories uses the shared filter for both the count and the page query', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/routes/stories.js'), 'utf8');
    expect(src).toContain('inProgressFilter = LIBRARY_HIDDEN_JOB_FILTER');
    expect((src.match(/\$\{inProgressFilter\}/g) || []).length).toBe(2);
  });
});
