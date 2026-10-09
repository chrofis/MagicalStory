/**
 * "On the idea editor I can pull the screen left/right" (iPhone). Layout was
 * measured in WebKit at iPhone 12 (390) and 14 Pro Max (430): no element wider
 * than the viewport. iOS Safari zooms the page in when a field with a font under
 * 16px gets focus, and a zoomed page can be dragged sideways; the idea textarea
 * and the city input were text-sm (14px). Both are 16px on phones now.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const STEP = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'trial', 'TrialIdeasStep.tsx'), 'utf8');

describe('trial ideas step fields do not trigger iOS focus zoom', () => {
  it('every textarea and text input is text-base (16px) below md', () => {
    // AutoGrowTextarea is the idea editor; its inner <textarea {...props}> only forwards the caller's className
    const fields = (STEP.match(/<(AutoGrowTextarea|textarea|input)\b[\s\S]*?\/>/g) || []).filter((f) => !f.includes('{...props}'));
    expect(fields.length).toBeGreaterThanOrEqual(2);
    for (const f of fields) {
      expect(f).toContain('text-base md:text-sm');
      expect(f).not.toMatch(/className="[^"]*\btext-sm\b(?! )[^"]*"(?![\s\S]*md:text-sm)/);
    }
  });
});
