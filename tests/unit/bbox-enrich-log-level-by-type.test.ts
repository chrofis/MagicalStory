/**
 * bboxDetection chooses the log level for an unmatched issue from issue.type
 * only (owner, 2026-10-09: code does not read what a description means). The
 * description regex that used to also pick the level is gone.
 */
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

describe('bbox enrichment log level', () => {
  it('does not read the issue description to decide missing-ness', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/bboxDetection.js'), 'utf8');
    const i = src.indexOf("const isMissing =");
    expect(i).toBeGreaterThan(0);
    const stmt = src.slice(i, src.indexOf(';', i));
    expect(stmt).toContain('issue.type');
    expect(stmt).not.toMatch(/description|test\(/);
  });
});
