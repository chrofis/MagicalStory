/**
 * POST /api/trial/create-story takes the visitor's ONE trial slot atomically
 * (`stories_generated + 1 ... WHERE stories_generated < 1`) before it reads the
 * character row, offloads images, writes trial_data and inserts the job. When
 * any of those later steps fails, the handler answers "start over" / "try
 * again" / "try again tomorrow" (daily cap) — but the slot stays taken, so the
 * retry it just asked for answers 409 TRIAL_USED with no job behind it (the
 * `TRIAL_USED ... but no story_jobs row found` log line in the same handler).
 * A failure before the job row exists must give the slot back.
 */
import { describe, it, expect, afterEach } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-slot';
const trialRouter = require('../../server/routes/trial.js');
const database = require('../../server/services/database.js');

function createStoryHandler() {
  const layer = trialRouter.stack.find((l: any) => l.route?.path === '/create-story');
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1]; // past verifySessionToken
}

function fakePool(state: { generated: number; characterRow: any[] }) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (/stories_generated = stories_generated \+ 1/.test(sql)) {
        if (state.generated < 1) { state.generated += 1; return { rows: [{ id: 'u1', stories_generated: state.generated }] }; }
        return { rows: [] };
      }
      if (/stories_generated = stories_generated - 1/.test(sql)) {
        state.generated = Math.max(0, state.generated - 1);
        return { rows: [{ id: 'u1' }] };
      }
      if (/SELECT id FROM users WHERE id = \$1 AND is_trial = true/.test(sql)) return { rows: [{ id: 'u1' }] };
      // The resume check (existingTrialJobResponse) reads the slot before any input is validated.
      if (/SELECT stories_generated FROM users WHERE id = \$1 AND is_trial = true/.test(sql)) return { rows: [{ stories_generated: state.generated }] };
      if (/FROM story_jobs/.test(sql)) return { rows: [] };
      if (/FROM characters/.test(sql)) return { rows: state.characterRow };
      throw new Error(`unexpected query in test: ${sql.slice(0, 60)}`);
    },
  };
}

function call(handler: any, body: any) {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  const req: any = { body, sessionUser: { userId: 'u1' }, headers: {}, ip: '127.0.0.1' };
  return handler(req, res).then(() => res);
}

const origGetPool = database.getPool;
afterEach(() => { database.getPool = origGetPool; });

describe('create-story gives the trial slot back when no job was created', () => {
  it('a failure after the atomic increment does not turn the retry into TRIAL_USED', async () => {
    const state = { generated: 0, characterRow: [] as any[] };
    const pool = fakePool(state);
    database.getPool = () => pool;
    const handler = createStoryHandler();

    const first = await call(handler, { storyTopic: 'A day at the lake' });
    expect(first.statusCode).toBe(404);
    expect(first.body.code).toBe('CHARACTER_NOT_FOUND');
    // The slot is free again: no job exists for it.
    expect(state.generated).toBe(0);

    const second = await call(handler, { storyTopic: 'A day at the lake' });
    expect(second.body.code).not.toBe('TRIAL_USED');
    expect(second.statusCode).toBe(404);
  });
});
