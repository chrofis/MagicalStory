import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The cold-read pass (story-text-proofread.txt) and the diff pass
 * (story-text-diff.txt) hand their findings to the SAME parser and applier
 * (textRefine.js parseLectorFindings / applyLectorFindings). A shortest-span
 * quote on either path leaves agreement broken around the fix, so both
 * templates must ask for the whole sentence.
 */
const LECTOR_TEMPLATES = ['prompts/story-text-proofread.txt', 'prompts/story-text-diff.txt'];

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
