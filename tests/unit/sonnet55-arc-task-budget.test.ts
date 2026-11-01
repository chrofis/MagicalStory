/**
 * THE ARC CREATOR CARRIES A TASK BUDGET (2026-11-01).
 *
 * Production job_1793560136987_ohe71lhr4: claude-sonnet-5-5 at effort xhigh
 * (arc_create) spent all 128,000 output tokens on thinking and returned no arc;
 * the story sat at 5% for 17 minutes and the customer cancelled. The call now
 * sends the advisory output_config.task_budget so the model paces itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const TM = require('../../server/lib/textModels');
const { TEXT_MODELS, MODEL_DEFAULTS } = require('../../server/config/models');

const sse = (events: any[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });

describe('Sonnet 5.5 arc creator task budget', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { vi.unstubAllGlobals(); process.env.ANTHROPIC_API_KEY = prev; });

  it('the arc creator model at the arc effort has a valid budget; other efforts send none', () => {
    const m = TEXT_MODELS[MODEL_DEFAULTS.arcCreateModel];
    expect(MODEL_DEFAULTS.arcCreateModel).toBe('claude-sonnet-5-5');
    const budget = TM.taskBudgetFor(m, { effort: MODEL_DEFAULTS.arcCreateEffort });
    expect(budget).toBe(80000);
    expect(budget).toBeLessThan(m.maxOutputTokens);
    expect(TM.taskBudgetFor(m, { effort: 'high' })).toBeNull();
    expect(TM.taskBudgetFor(m, { effort: 'medium' })).toBeNull();
    // the alias is the same object, so the Lab and production read one setting
    expect(TEXT_MODELS['claude-sonnet']).toBe(TEXT_MODELS['claude-sonnet-5-5']);
  });

  it('an xhigh call sends effort + task_budget with the beta header', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 100 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ARC' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60000 } },
      ]);
    }));
    const res = await TM.callTextModelStreaming('prompt', null, null, 'claude-sonnet-5-5', { effort: 'xhigh', usageLabel: 'arc_create' });
    expect(res.text).toBe('ARC');
    expect(calls[0].headers['anthropic-beta']).toBe('task-budgets-2026-03-13');
    expect(calls[0].body.output_config).toEqual({ effort: 'xhigh', task_budget: { type: 'tokens', total: 80000 } });

    // The Lab control arm (noTaskBudget) sends the same call without the budget or its beta header.
    await TM.callTextModelStreaming('prompt', null, null, 'claude-sonnet-5-5', { effort: 'xhigh', usageLabel: 'testlab_arc_effort', noTaskBudget: true });
    expect(calls[1].headers['anthropic-beta']).toBeUndefined();
    expect(calls[1].body.output_config).toEqual({ effort: 'xhigh' });
  });
});
