/**
 * audit_replay's promptOverride had no effect (docs/testlab-prod-parity.md):
 * the stage built the audit prompt from PROMPT_TEMPLATES BEFORE entering
 * `withTemplates({ [templateKey]: promptOverride }, …)`, which wrapped only the
 * model call — a call that reads nothing but the finished string. Every
 * override A/B measured the stored template against itself.
 *
 * Only the DB and the model call are stubbed. No paid call is made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

const database = require_('../../server/services/database');
const textModels = require_('../../server/lib/textModels');

const ARC = '1. Mira finds a gate. 2. A dragon waits behind it. 3. They become friends.';
const STORY = {
  title: 'Das Tor im Garten',
  language: 'de',
  outline: '',
  beatsReviewReport: { arc: ARC },
  arcReviewReport: { arcHints: '', logic: '' },
  characters: [{ id: 'c1', name: 'Mira', age: 6 }],
  sceneImages: [
    { pageNumber: 1, text: 'Mira stand vor dem Tor.', sceneDescription: 'Mira stands before a garden gate.', sceneMetadata: { sceneIntent: 'Mira reaches the gate.' } },
  ],
};

let sentPrompts: string[] = [];
database.dbQuery = async (sql: string) => (/FROM stories WHERE id/.test(sql) ? [{ data: STORY, user_id: 1 }] : []);
textModels.callTextModelStreaming = async (prompt: string) => {
  sentPrompts.push(prompt);
  return { text: 'FAULT[CONTINUITY] p1: stub', modelId: 'stub-auditor', usage: { input_tokens: 10, output_tokens: 5 } };
};

const { runStageOnTarget } = require_('../../server/lib/testlab');

const OVERRIDE_MARK = 'LAB-OVERRIDE-SENTINEL';
const run = (level: string, promptOverride: string | null) => runStageOnTarget(
  'audit_replay', { storyId: 'job_test' }, { params: { level, models: 'claude-opus' }, promptOverride },
);

beforeEach(() => { sentPrompts = []; });

describe('audit_replay promptOverride reaches the model', () => {
  it('arc: the override template is what gets filled and sent', async () => {
    const r = await run('arc', `${OVERRIDE_MARK}\nARC:\n{ARC}\n{STORY_BRIEF}`);
    expect(r.runs[0].ok).toBe(true);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain(OVERRIDE_MARK);
    expect(sentPrompts[0]).toContain(ARC);
    expect(r.promptChars).toBe(sentPrompts[0].length);
  });

  it('text and text-blind: the override template is what gets filled and sent', async () => {
    for (const level of ['text', 'text-blind']) {
      sentPrompts = [];
      await run(level, `${OVERRIDE_MARK} ${level}\n{PAGES}`);
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toContain(`${OVERRIDE_MARK} ${level}`);
    }
  });

  it('without an override the stored template is sent', async () => {
    await run('arc', null);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).not.toContain(OVERRIDE_MARK);
    expect(sentPrompts[0]).toContain(ARC);
  });
});
