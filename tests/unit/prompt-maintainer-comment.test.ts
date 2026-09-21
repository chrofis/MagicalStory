/**
 * A prompt file may open with notes for the maintainer. They must not ship to
 * the model — and a markdown `#` heading, which IS prompt structure, must
 * survive untouched. The convention is a leading `#!` block.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { stripMaintainerComment } = require('../../server/services/prompts');

const PROMPTS_DIR = path.join(__dirname, '../../prompts');

describe('stripMaintainerComment', () => {
  it('removes a leading #! block and the blank lines after it', () => {
    const out = stripMaintainerComment('#! note one\n#! note two\n\n**ROLE:** do the thing\n');
    expect(out).toBe('**ROLE:** do the thing\n');
  });

  it('leaves a markdown heading alone', () => {
    const text = '# Entity Consistency Check\n\nbody\n';
    expect(stripMaintainerComment(text)).toBe(text);
  });

  it('leaves a file with no leading comment alone', () => {
    const text = '**ROLE:** do the thing\n#! not at the top\n';
    expect(stripMaintainerComment(text)).toBe(text);
  });

  it('strips a #! block appearing mid-file only when it is at the top', () => {
    const text = 'body\n#! note\n';
    expect(stripMaintainerComment(text)).toBe(text);
  });

  it('keeps the maintainer notes out of the scene-expansion templates', () => {
    for (const file of ['scene-expansion-all.txt', 'scene-expansion.txt']) {
      const raw = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8');
      expect(raw.startsWith('#!')).toBe(true);
      const sent = stripMaintainerComment(raw);
      expect(sent.startsWith('#!')).toBe(false);
      expect(sent).not.toContain('beatsPipeline.js');
      expect(sent).toContain('**ROLE:**');
    }
  });

  it('no prompt template ships a leftover #! line', () => {
    for (const file of fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt'))) {
      const sent = stripMaintainerComment(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8'));
      expect(sent.split('\n').filter(l => l.startsWith('#!')).length, file).toBe(0);
    }
  });
});
