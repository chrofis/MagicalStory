import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import express from 'express';

/**
 * GET /api/admin/token-usage (server/routes/admin/analytics.js), driven over
 * HTTP with the pool stubbed. Defect found 2026-10-07:
 *
 * A story's data.tokenUsage carries an `openrouter` bucket (the reviewers
 *    on four stages, eval/compliance traffic) with tokens AND the charge
 *    OpenRouter reported. The route's provider lists were hand-copied five
 *    times and none had the key, so that spend was $0 in the grand total, the
 *    daily/monthly rows and the per-user rows while the story itself booked it.
 */

const nodeRequire = createRequire(import.meta.url);

function get(port: number, p: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: p, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode || 0, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

const PG_NAIVE = new Date(2026, 8, 30, 22, 30, 0);

const textBucket = (n: number) => ({ input_tokens: n, output_tokens: n, thinking_tokens: 0, calls: 1 });

const STORIES = [
  {
    id: 's-reported', user_id: 'u-1', user_email: 'a@example.com', user_name: 'A',
    story_type: 'adventure', title: 'Reported', created_at: PG_NAIVE,
    token_usage: {
      anthropic: textBucket(1000),
      // OpenRouter reported its own charge: that figure wins over any table.
      openrouter: { input_tokens: 40000, output_tokens: 8000, thinking_tokens: 0, direct_cost: 0.0375, calls: 3 },
      runware: { direct_cost: 0, calls: 0 },
      grok: { direct_cost: 0.02, calls: 1 },
    },
  },
  {
    id: 's-unreported', user_id: 'u-2', user_email: 'b@example.com', user_name: 'B',
    story_type: 'adventure', title: 'Unreported', created_at: PG_NAIVE,
    token_usage: {
      anthropic: textBucket(1000),
      // Older story: tokens recorded, no reported charge — priced at the eval model's rate, never $0.
      openrouter: { input_tokens: 1_000_000, output_tokens: 1_000_000, thinking_tokens: 0, direct_cost: 0, calls: 2 },
    },
  },
];

let server: http.Server;
let port: number;
let adminTok: string;

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-token-usage-test';
  // analytics.js pulls the trial router for its trial-stats endpoints; none are
  // exercised here and the real module drags in sharp/rate limiters.
  const trialPath = nodeRequire.resolve('../../server/routes/trial.js');
  nodeRequire.cache[trialPath] = { id: trialPath, filename: trialPath, loaded: true, exports: {
    getTrialStats: () => ({}), getTrialStatsHistory: async () => [], getTrialFunnel: async () => ({}), getTrialStepFunnel: async () => ({}),
  } } as any;

  const database = nodeRequire('../../server/services/database.js');
  database.isDatabaseMode = () => true;
  database.getPool = () => ({
    query: async (sql: string, params: any[]) => {
      if (/FROM users WHERE id/.test(sql)) return { rows: [{ token_version: 0, role: 'admin' }] };
      if (/FROM stories s/.test(sql)) return { rows: STORIES };
      if (/FROM characters c/.test(sql)) return { rows: [] };
      return { rows: [{ token_version: 0, role: 'admin' }] };
    },
  });
  database.logActivity = async () => {};

  const { generateToken } = nodeRequire('../../server/middleware/auth.js');
  adminTok = generateToken({ id: 'a-1', username: 'a', email: 'a@x', role: 'admin', token_version: 0 });

  const router = nodeRequire('../../server/routes/admin/analytics.js');
  const app = express();
  app.use('/api/admin', router);
  server = app.listen(0);
  port = (server.address() as any).port;
});

afterAll(() => { server?.close(); });

describe('GET /api/admin/token-usage', () => {
  it('counts OpenRouter spend: the reported charge when there is one, else the tokens at the eval model rate', async () => {
    const { MODEL_DEFAULTS, calculateTextCost } = nodeRequire('../../server/config/models.js');
    const { status, body } = await get(port, '/api/admin/token-usage?days=30', adminTok);
    expect(status).toBe(200);

    const priced = calculateTextCost(MODEL_DEFAULTS.evalModel, { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(priced).toBeGreaterThan(0); // the eval model is in MODEL_PRICING (model-pricing-integrity.test.ts)

    expect(body.totals.openrouter.calls).toBe(5);
    expect(body.totals.openrouter.input_tokens).toBe(1_040_000);
    expect(body.costs.openrouter.total).toBeCloseTo(0.0375 + priced, 6);

    // The grand total and every aggregate carry it — it was $0 everywhere before.
    const withoutOpenrouter = body.costs.anthropic.total + body.costs.gemini_text.total + body.costs.gemini_image.total
      + body.costs.gemini_quality.total + body.costs.totalAvatarCost + body.costs.runware.total + body.costs.grok.total;
    expect(body.costs.grandTotal).toBeCloseTo(withoutOpenrouter + 0.0375 + priced, 6);

    expect(body.byDay).toHaveLength(1);
    expect(body.byDay[0].openrouter.cost).toBeCloseTo(0.0375 + priced, 6);
    expect(body.byDay[0].totalCost).toBeGreaterThan(0.0375 + priced);
    expect(body.byMonth[0].openrouter.cost).toBeCloseTo(0.0375 + priced, 6);

    const byEmail = Object.fromEntries(body.byUser.map((u: any) => [u.email, u]));
    expect(byEmail['a@example.com'].openrouter.cost).toBeCloseTo(0.0375, 6);
    expect(byEmail['b@example.com'].openrouter.cost).toBeCloseTo(priced, 6);
    expect(body.byStoryType.adventure.openrouter.calls).toBe(5);
    // The pre-existing providers still aggregate as before.
    expect(body.totals.anthropic.input_tokens).toBe(2000);
    expect(body.totals.grok.direct_cost).toBeCloseTo(0.02, 6);
  });

});
