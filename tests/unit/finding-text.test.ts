import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { findingText as clientFindingText } from '../../client/src/utils/findingText';

const require = createRequire(import.meta.url);
const { findingText } = require('../../server/lib/scoring.js');

// The semantic evaluator (prompts/image-semantic.txt) emits `description`.
// Several summary builders read `i.problem`, which is only ever present on
// pre-2026-08 stored rows — so every fresh semantic finding rendered as an
// empty string and `issuesSummary` read literally "SEMANTIC: ". A shipped
// CRITICAL on a page was invisible in the logs (staging job
// job_1788641639919_mpjwlzkf1, page 2). One accessor, asserted here on both
// schemas, so no reader has to guess which field the row carries.
const CURRENT = { type: 'action_interaction', severity: 'CRITICAL', description: 'Map not visible — girl should be giving it to boy', fix: 'add the map' };
const LEGACY = { type: 'action_interaction', severity: 'CRITICAL', problem: 'Map not visible' };
const ANCIENT = { type: 'style', severity: 'MAJOR', issue: 'Flat colours' };
const BARE = { type: 'action_interaction', item: 'map', severity: 'MAJOR' };

for (const [name, fn] of [['server', findingText], ['client', clientFindingText]] as const) {
  describe(`findingText (${name})`, () => {
    it('reads the current `description` schema', () => {
      expect(fn(CURRENT)).toBe('Map not visible — girl should be giving it to boy');
    });
    it('still reads stored `problem` and `issue` rows', () => {
      expect(fn(LEGACY)).toBe('Map not visible');
      expect(fn(ANCIENT)).toBe('Flat colours');
    });
    it('names the finding when it carries no prose at all', () => {
      expect(fn(BARE)).toBe('action_interaction: map');
    });
    it('never throws on junk', () => {
      expect(fn(null)).toBe('');
      expect(fn(undefined)).toBe('');
      expect(fn('nope' as any)).toBe('');
    });
    it('a summary of current-schema findings is not empty', () => {
      const summary = `SEMANTIC: ${[CURRENT, LEGACY].map(fn).join('; ')}`;
      expect(summary).not.toBe('SEMANTIC: ');
      expect(summary).toContain('Map not visible');
    });
  });
}
