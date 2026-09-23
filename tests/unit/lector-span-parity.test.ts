import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The cold-read pass (story-text-proofread.txt) hands its findings to
 * parseLectorFindings / applyLectorFindings. A shortest-span quote leaves
 * agreement broken around the fix, so the template asks for the whole
 * sentence. The pass after the repair (story-text-diff.txt) left this contract
 * on 2026-09-23: it edits numbered sentences whole (parseDiffEdits, pinned in
 * text-stage-counter-and-specs.test.ts).
 */
const LECTOR_TEMPLATES = ['prompts/story-text-proofread.txt'];

describe('lector quoting span parity', () => {
  for (const rel of LECTOR_TEMPLATES) {
    it(`${path.basename(rel)} asks for the whole sentence, not the shortest span`, () => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(/WHOLE SENTENCE/.test(text)).toBe(true);
      expect(/shortest span/i.test(text)).toBe(false);
    });

    it(`${path.basename(rel)} states the one-line-per-sentence output rule`, () => {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(/One line per sentence/.test(text)).toBe(true);
    });
  }
});
