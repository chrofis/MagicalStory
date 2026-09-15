import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const P = (f: string) => fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');

// Measured across both databases on 2026-09-15: 267 stories, 21,099 story_images
// and 1,308 Lab experiments. `cross-eyes` has never fired once, `rendering.cross_eyes`
// was emitted in 69 of 138 staging stories and is `true` in ZERO rows in either
// environment, and no JS anywhere reads the field. It is removed, and stays removed.
describe('anatomy checks — only the ones that measurably fire', () => {
  for (const f of ['image-inventory-unified.txt', 'image-visual-inventory.txt',
    'image-prompt-compliance.txt', 'image-evaluation.txt', 'image-semantic.txt',
    'variants/image-evaluation-verbose-v1.txt']) {
    it(`${f} carries no cross-eyes check`, () => {
      expect(P(f)).not.toMatch(/cross[-_ ]?eye/i);
    });
  }

  it('the inventory schemas no longer declare the dead field', () => {
    expect(P('image-inventory-unified.txt')).toContain('"rendering": { "extra_limbs": false, "physics_ok": true');
  });

  // D-13 is the one anatomy check that works — ~24 findings over 11 stories,
  // 3/3 eye-verified real, 0 false positives. Deliberately kept.
  it('D-13 fused fingers survives, at MINOR', () => {
    const evalPrompt = P('image-evaluation.txt');
    expect(evalPrompt).toMatch(/\*\*D-13 `figure_completeness` → MINOR\.\*\*/);
    expect(evalPrompt).toMatch(/fingers fused/);
  });
});
