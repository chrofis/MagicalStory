/**
 * writer_compare's text arm threw on every run (docs/testlab-prod-parity.md):
 * the stage handed `parseRefinedText` the page COUNT where production hands it
 * the page NUMBERS (beatsPipeline.js `beatPages`), so the parser's
 * `expectedPages.filter` blew up and each model's text stage was recorded as
 * `{ score: 0, error: 'expectedPages.filter is not a function' }`.
 *
 * Only the DB and the model call are stubbed. No paid call is made.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const database = require_('../../server/services/database');
const textModels = require_('../../server/lib/textModels');

const PAGE = (n: number, text: string) => `## Page ${n}\n${text}\n`;
const WRITER_REPLY = [
  '---ANALYSIS---',
  'Two pages, one event each.',
  '---STORY TEXT---',
  PAGE(1, 'Mira und Tom standen vor dem Tor. «Komm», sagte Mira, «wir gehen hinein.»'),
  PAGE(2, 'Hinter dem Tor wartete ein kleiner Drache. Er schnupperte an Toms Schuh.'),
  '---TITLE---',
  '1. Das Tor im Garten',
  'PICK: 1 — short and concrete',
].join('\n');

const STORY = {
  title: 'Das Tor im Garten',
  language: 'de',
  outline: '',
  storyText: '## Page 1\nShipped page one.\n\n## Page 2\nShipped page two.\n',
  characters: [{ id: 'c1', name: 'Mira', age: 6 }, { id: 'c2', name: 'Tom', age: 4 }],
  sceneImages: [
    { pageNumber: 1, sceneDescription: 'Mira and Tom stand before a garden gate.', sceneMetadata: { sceneIntent: 'The two children reach the gate.' } },
    { pageNumber: 2, sceneDescription: 'A small dragon sniffs at a shoe behind the gate.', sceneMetadata: { sceneIntent: 'A dragon greets them.' } },
  ],
};

database.dbQuery = async (sql: string) => (/FROM stories WHERE id/.test(sql) ? [{ data: STORY, user_id: 1 }] : []);
textModels.callTextModelStreaming = async () => ({
  text: WRITER_REPLY, modelId: 'stub-writer', usage: { input_tokens: 10, output_tokens: 50 },
});

const { runStageOnTarget } = require_('../../server/lib/testlab');

describe('writer_compare text arm', () => {
  it('parses the model reply by page number and scores it, instead of throwing', async () => {
    const r = await runStageOnTarget('writer_compare', { storyId: 'job_test' }, {
      params: { models: ['deepseek-v4-pro'], stages: ['text'], baseline: false },
    });
    const arm = r.arms.find((a: any) => a.model === 'deepseek-v4-pro');
    expect(arm.stages.text.error).toBeUndefined();
    // Both pages found: full completeness, no ß, guillemets present.
    expect(arm.stages.text.completeness).toBe(5);
    expect(arm.stages.text.score).toBeGreaterThan(0);
    expect(arm.stages.text.raw).toMatch(/^2\/2 pages/);
    // The count stays a count where a count is wanted.
    expect(r.expectedPages).toBe(2);
  });
});
