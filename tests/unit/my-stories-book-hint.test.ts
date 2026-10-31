import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// My Stories book hint (owner, 2026-10-31): two lines, shown on phones too.
// Line 1 = what is in the book ("1 Geschichte: 18 Seiten"), line 2 = several stories fit, up to MAX_BOOK_PAGES.
const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/MyStories.tsx'), 'utf8');

describe('My Stories book hint', () => {
  it('is not hidden on phones', () => {
    const block = src.slice(src.indexOf('{/* Book hint, phones included'), src.indexOf('{isLoading ?'));
    expect(block).toContain('className="flex bg-blue-50');
    expect(block).not.toContain('hidden md:flex');
  });

  it('states the page limit from the one constant, in all four languages', () => {
    expect(src).toContain("t.severalHint.replace('{max}', String(MAX_BOOK_PAGES))");
    expect(src.match(/severalHint: /g)).toHaveLength(4);
    for (const line of src.match(/severalHint: .*$/gm) || []) expect(line).toContain('{max}');
    expect(src).not.toMatch(/severalHint: .*ß/);
  });

  it('line 1 counts stories with singular and plural and French narrow space before the colon', () => {
    expect(src).toContain("selectedStories.length === 1 ? t.story : t.stories");
    expect(src).toContain("language === 'fr' ? ' ' : ''");
  });
});
